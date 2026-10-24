#!/usr/bin/env python3
"""Reference image -> LHM gaussian actor -> frozen PLY + looping idle/talk PLY sequence.

Standard actors use LHM-500M-HF; "high detail" (``--model`` LHM-1B-HF + ``--finetune``) adds a
short photometric fine-tune of the canonical gaussians against the reference right after the
canonical inference (finetune_actor.py), so every output below comes from the fine-tuned state.

Runs inside the Modal GPU image (cwd /opt/lhm). Ported from OrbisEngine
``worker/stages/lhm_person.py`` (mask crop, Multi-HMR source pose, head crop, canonical LHM
inference via ``infer_single_view`` + native ``animation_infer_gs`` skinning). Differences:

* No mask given -> person matte from ``rembg`` (u2net), LHM upstream's no-SAM2 fallback.
* The posed output uses an upright root (``root_pose = [pi, 0, 0]``: SMPL-X +Y up / facing +Z
  -> OpenCV camera) unless the Multi-HMR root disagrees by more than ``--upright-max-deg``, so a
  generated reference shot slightly from above doesn't lean.
* Motion is ``idle_motion.py`` (procedural, seamless) instead of per-frame video poses.
* Raw frames are packaged in-worker by ``package_actor.py`` into ``sequence/``.

Outputs under --out: mask.png, observed-mask.png, pose-input.png, estimated-joints.png,
model-input.png, head-input.png, source-pose.json, canonical-state.pt, raw/{person-posed,frozen,
frame_NNN}.ply, frozen.ply, sequence/{sequence.json,frame_NNN.ply,motion.*}, result.json
(+ finetune.json, finetune-source.png, finetune-turns.png with --finetune).
"""

from __future__ import annotations

import argparse
import dataclasses
import gc
import hashlib
import importlib.util
import json
import math
import os
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import finetune_actor  # noqa: E402
import idle_motion  # noqa: E402
import package_actor  # noqa: E402


def person_mask(rgb: np.ndarray, dilate: int = 2) -> tuple[np.ndarray, np.ndarray, dict]:
    """rembg u2net alpha -> largest component; returns (observed 0/255, dilated 0/255, report)."""
    from rembg import new_session, remove

    session = new_session("u2net")
    rgba = np.asarray(remove(Image.fromarray(rgb), session=session))
    m = (rgba[..., 3] > 127).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n <= 1:
        raise RuntimeError("rembg found no foreground person in the reference image")
    largest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    m = (lab == largest).astype(np.uint8)
    observed = m * 255
    if dilate > 0:
        m = cv2.dilate(m, np.ones((2 * dilate + 1, 2 * dilate + 1), np.uint8))
    ys, xs = np.where(m > 0)
    h, w = m.shape
    report = dict(
        method=f"rembg u2net alpha>127, largest component, dilate {dilate}px",
        box=[int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())],
        portrait=bool((ys.max() - ys.min()) > (xs.max() - xs.min())),
        touchesFrame=bool(xs.min() == 0 or ys.min() == 0 or xs.max() == w - 1 or ys.max() == h - 1),
        areaFraction=float(m.mean()),
    )
    return observed, m * 255, report


def pose_parameters(pose, betas=None):
    """Orbis lhm_person.pose_parameters: Multi-HMR rotvecs -> LHM SMPL-X params on CUDA."""
    import torch

    rv = pose["rotvec"]
    params = dict(
        betas=pose["shape"][None] if betas is None else betas,
        root_pose=rv[0][None, None],
        body_pose=rv[1:22][None, None],
        jaw_pose=rv[52][None, None],
        leye_pose=torch.zeros(1, 1, 3),
        reye_pose=torch.zeros(1, 1, 3),
        lhand_pose=rv[22:37][None, None],
        rhand_pose=rv[37:52][None, None],
        expr=torch.zeros(1, 1, 100),
        trans=pose["transl_pelvis"].reshape(1, 1, 3),
    )
    return {k: v.float().cuda() for k, v in params.items()}


def preprocess(repo, source, mask):
    """Orbis lhm_person.preprocess: original LHM mask crop, white background, 5:3 framing."""
    import torch
    from engine.SegmentAPI.base import Bbox

    spec = importlib.util.spec_from_file_location(
        "lhm_inference_helpers", repo / "LHM/runners/infer/utils.py"
    )
    helpers = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helpers)
    rgb = np.asarray(Image.open(source).convert("RGB"))
    h, w = mask.shape
    y, x = np.where(mask > 127)
    if not len(x):
        raise ValueError("Empty input person mask")
    box = (
        Bbox([int(x.min()), int(y.min()), int(x.max()), int(y.max())])
        .scale(1.1, width=w, height=h)
        .get_box()
    )
    rgb = rgb[box[1] : box[3], box[0] : box[2]]
    mask = mask[box[1] : box[3], box[0] : box[2]]
    h, w = rgb.shape[:2]
    aspect = 5 / 3
    if w >= h:
        raise ValueError("Source mask is not a portrait person crop")
    target_w = int(min(w * (h / w / aspect), h))
    if target_w > w:
        pad = (target_w - w) // 2
        rgb = np.pad(rgb, ((0, 0), (pad, pad), (0, 0)), constant_values=255)
        mask = np.pad(mask, ((0, 0), (pad, pad)))
    else:
        pad = int(w * aspect - h)
        rgb = np.pad(rgb, ((pad, 0), (0, 0), (0, 0)), constant_values=255)
        mask = np.pad(mask, ((pad, 0), (0, 0)))
    mask = (mask / 255 > 0.5).astype(np.float32)
    rgb = rgb / 255 * mask[..., None] + (1 - mask[..., None])
    rgb = helpers.resize_image_keepaspect_np(rgb, 896)
    mask = helpers.resize_image_keepaspect_np(mask, 896)
    rgb, mask, _, _ = helpers.center_crop_according_to_mask(rgb, mask, aspect, [1.0, 1.0])
    size, _, _ = helpers.calc_new_tgt_size_by_aspect(rgb.shape[:2], aspect, 1024, 14)
    rgb = cv2.resize(rgb, (size[1], size[0]), interpolation=cv2.INTER_AREA)
    return torch.from_numpy(rgb).float().permute(2, 0, 1)[None]


def prepare_head_input(raw, mask, detector):
    """Orbis lhm_person.prepare_head_input: head detection restricted to the person mask.
    Returns (112 x 112 head crop, head box x0 y0 x1 y1 in reference pixels)."""
    import torch

    selected = mask > 127
    masked = raw.copy()
    masked[~selected] = 255
    box = detector(torch.from_numpy(masked).permute(2, 0, 1)).cpu().numpy()
    if box.shape != (4,) or not np.isfinite(box).all():
        raise ValueError("Invalid head box for selected person")
    box[[0, 2]] = box[[0, 2]].clip(0, raw.shape[1])
    box[[1, 3]] = box[[1, 3]].clip(0, raw.shape[0])
    x0, y0, x1, y1 = box.astype(int)
    if x1 <= x0 or y1 <= y0 or not selected[y0:y1, x0:x1].any():
        raise ValueError("Head box does not contain the selected person")
    head = masked[y0:y1, x0:x1]
    return cv2.resize(head, (112, 112), interpolation=cv2.INTER_AREA), (int(x0), int(y0), int(x1), int(y1))


def angle_between(rv_a, rv_b) -> float:
    Ra, Rb = idle_motion.rotvec_to_matrix(rv_a), idle_motion.rotvec_to_matrix(rv_b)
    c = np.clip((np.trace(Ra.T @ Rb) - 1) / 2, -1, 1)
    return float(np.degrees(np.arccos(c)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True)
    ap.add_argument("--mask")
    ap.add_argument("--out", required=True)
    ap.add_argument("--repo", default="/opt/lhm")
    ap.add_argument("--model", required=True, help="local snapshot dir of the LHM checkpoint")
    ap.add_argument("--model-id", default="3DAIGC/LHM-500M-HF")
    ap.add_argument("--model-revision", default="dd6392905187a91fd67b3f6962aa74481e943764")
    ap.add_argument("--detail", default="standard", choices=("standard", "high"))
    ap.add_argument("--finetune", action="store_true", help="fine-tune the canonical gaussians against the reference")
    ap.add_argument("--finetune-iters", type=int, default=600)
    ap.add_argument("--finetune-seconds", type=float, default=100)
    ap.add_argument("--frames", type=int, default=48)
    ap.add_argument("--talk-frames", type=int, default=24)
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--quantize", action="store_true")
    ap.add_argument("--dilate", type=int, default=2)
    ap.add_argument("--upright-max-deg", type=float, default=35)
    ap.add_argument("--motion-library", help="dir with motion-library.json + motion-clips.bin (runtime rig clips)")
    a = ap.parse_args()
    repo, out = Path(a.repo), Path(a.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    os.chdir(repo)
    sys.path.insert(0, str(repo))
    t0 = time.time()
    source = out / "source.png"
    raw = np.asarray(Image.open(a.image).convert("RGB"))
    Image.fromarray(raw).save(source)
    if a.mask:
        mask = np.asarray(Image.open(a.mask).convert("L"))
        if mask.shape != raw.shape[:2]:
            raise ValueError("mask.png must match reference.png")
        observed, mask_report = mask, dict(method="caller-supplied mask.png")
    else:
        print("Segmenting the reference with rembg (u2net)", flush=True)
        observed, mask, mask_report = person_mask(raw, a.dilate)
        if not mask_report["portrait"]:
            raise RuntimeError(f"unusable person mask: {mask_report}")
    Image.fromarray(observed).save(out / "observed-mask.png")
    Image.fromarray(mask).save(out / "mask.png")
    timings = {"mask": time.time() - t0}

    import torch
    from accelerate import Accelerator

    torch._dynamo.config.disable = True
    torch.set_num_threads(4)
    torch.backends.cuda.matmul.allow_tf32 = True
    Accelerator()
    from engine.pose_estimation.pose_estimator import PoseEstimator

    pose_rgb = raw.copy()
    pose_rgb[mask < 128] = 255
    Image.fromarray(pose_rgb).save(out / "pose-input.png")
    print("Estimating source pose with official Multi-HMR", flush=True)
    estimator = PoseEstimator("./pretrained_models/human_model_files", device="cuda")
    padded, offset_w, offset_h = estimator.img_center_padding(pose_rgb)
    tensor, annotation = estimator._preprocess(padded)
    K = estimator.get_camera_parameters()
    with torch.inference_mode(), torch.autocast("cuda", dtype=torch.float16):
        people = estimator.mhmr_model(
            tensor, is_training=False, nms_kernel_size=3, det_thresh=0.3, K=K, idx=None, max_dist=None
        )
    if not people:
        raise RuntimeError("No source person pose detected in the reference image")
    person = max(people, key=lambda p: float(p["scores"]))
    pose = {k: v.detach().float().cpu() for k, v in person.items()}
    pad_left, pad_top, factor, _, _ = annotation
    # what maps Multi-HMR's camera onto reference pixels (the fine-tune renders into it)
    camera_annotation = (int(offset_w), int(offset_h), int(pad_left), int(pad_top), float(factor))
    joints = (pose["j2d"].numpy() - [pad_left, pad_top]) / factor - [offset_w, offset_h]
    overlay = raw.copy()
    for x, y in joints:
        cv2.circle(overlay, (round(float(x)), round(float(y))), 5, (255, 0, 0), -1)
    Image.fromarray(overlay).save(out / "estimated-joints.png")
    pose_record = {k: v.numpy().tolist() for k, v in pose.items() if k not in ("v3d", "j3d", "j2d")}
    pose_record.update(
        detectedPeople=len(people),
        method="Official Multi-HMR on masked reference",
        cameraAnnotation=dict(zip(("offsetW", "offsetH", "padLeft", "padTop", "factor"), camera_annotation)),
    )
    (out / "source-pose.json").write_text(json.dumps(pose_record, indent=2))
    del estimator, tensor, K, people, person
    gc.collect()
    torch.cuda.empty_cache()
    timings["pose"] = time.time() - t0

    from LHM.utils.face_detector import FaceDetector

    detector = FaceDetector("./pretrained_models/gagatracker/vgghead/vgg_heads_l.trcd", device="cuda")
    head_box = None
    try:
        head, head_box = prepare_head_input(raw, mask, detector)
        head_detected = True
    except Exception as error:  # noqa: BLE001 - upstream zero-head fallback
        print("No head input; upstream zero-head fallback:", str(error), flush=True)
        head = np.zeros((112, 112, 3), dtype=np.uint8)
        head_detected = False
    Image.fromarray(head).save(out / "head-input.png")
    del detector
    gc.collect()
    torch.cuda.empty_cache()
    image = preprocess(repo, source, mask)
    Image.fromarray((image[0].permute(1, 2, 0).numpy() * 255).astype("uint8")).save(
        out / "model-input.png"
    )
    head_image = torch.from_numpy(head / 255.0).float().permute(2, 0, 1)[None, None]

    from LHM.models import model_dict
    from LHM.utils.hf_hub import wrap_model_hub

    print(f"Loading {a.model_id}", flush=True)
    model = wrap_model_hub(model_dict["human_lrm_sapdino_bh_sd3_5"]).from_pretrained(a.model)
    model.eval()  # upstream overrides train() without returning self, so eval() is not chainable
    model.cuda()
    timings["load"] = time.time() - t0
    params = pose_parameters(pose)
    print("Reconstructing canonical appearance", flush=True)
    with torch.inference_mode():
        attrs, query, neutral = model.infer_single_view(
            image[None].cuda(), head_image.cuda(), None, None, None, None, None, smplx_params=params
        )
        params["transform_mat_neutral_pose"] = neutral
    timings["canonical"] = time.time() - t0
    finetune_report = None
    if a.finetune:
        # inference-mode tensors cannot take part in autograd: work on ordinary copies
        attrs = [
            dataclasses.replace(g, **{k: getattr(g, k).clone() for k in ("offset_xyz", "opacity", "rotation", "scaling", "shs")})
            for g in attrs
        ]
        query = query.clone()
        params = {k: v.clone() for k, v in params.items()}
        neutral = params["transform_mat_neutral_pose"]
        print("Fine-tuning against the reference (source pose, source camera)", flush=True)
        try:
            finetune_report = finetune_actor.finetune(
                model,
                attrs,
                query,
                params,
                raw,
                mask,
                camera_annotation,
                out,
                head_box=head_box,
                iters=a.finetune_iters,
                seconds=a.finetune_seconds,
                log=lambda m: print(m, flush=True),
            )
        except Exception as error:  # noqa: BLE001 - LHM's own avatar is still a complete actor
            import traceback

            finetune_report = dict(applied=False, error=f"{type(error).__name__}: {error}"[:500])
            print("fine-tune failed (LHM output kept):", traceback.format_exc(), flush=True)
        (out / "finetune.json").write_text(json.dumps(finetune_report, indent=2))
        torch.cuda.empty_cache()
        timings["finetune"] = time.time() - t0
    with torch.inference_mode():
        posed = model.animation_infer_gs(attrs, query, params)
        posed.save_ply(str(out / "raw/person-posed.ply"))  # Orbis-equivalent source-pose output
        torch.save(dict(attrs=attrs, query=query, neutral=neutral, params=params), out / "canonical-state.pt")

    estimated_root = pose["rotvec"][0].numpy().astype(np.float64)
    upright_root = np.array([math.pi, 0.0, 0.0])
    root_delta = angle_between(estimated_root, upright_root)
    use_upright = root_delta <= a.upright_max_deg
    print(f"root: Multi-HMR differs from upright by {root_delta:.1f} deg; upright={use_upright}", flush=True)
    base = {k: v.clone() for k, v in params.items()}
    if use_upright:
        base["root_pose"] = torch.tensor(upright_root, dtype=torch.float32).reshape(1, 1, 3).cuda()
    base_body = base["body_pose"].reshape(21, 3).double().cpu().numpy()
    base_jaw = base["jaw_pose"].reshape(3).double().cpu().numpy()

    def render(body, jaw, path):
        p = dict(base)
        p["body_pose"] = torch.tensor(body, dtype=torch.float32).reshape(1, 1, 21, 3).cuda()
        p["jaw_pose"] = torch.tensor(jaw, dtype=torch.float32).reshape(1, 1, 3).cuda()
        with torch.inference_mode():
            gs = model.animation_infer_gs(attrs, query, p)
        if not all(torch.isfinite(x).all() for x in (gs.xyz, gs.opacity, gs.scaling, gs.rotation)):
            raise RuntimeError("Non-finite animated Gaussians")
        gs.save_ply(str(path))

    render(base_body, base_jaw, out / "raw/frozen.ply")
    raw_frames = []
    loops = {"idle": (0, a.frames)}
    plan = [(i, a.frames, False) for i in range(a.frames)]
    if a.talk_frames:
        loops["talk"] = (a.frames, a.talk_frames)
        plan += [(i, a.talk_frames, True) for i in range(a.talk_frames)]
    for n, (i, count, talk) in enumerate(plan):
        body, jaw = idle_motion.frame_pose(base_body, base_jaw, i, count, talk)
        path = out / f"raw/frame_{n:03d}.ply"
        render(body, jaw, path)
        raw_frames.append(path)
        if n % 8 == 0 or n == len(plan) - 1:
            print(f"animated gaussian frame {n + 1}/{len(plan)}", flush=True)
    timings["animate"] = time.time() - t0

    seq = package_actor.package(
        raw_frames,
        out / "sequence",
        fps=a.fps,
        loops=loops,
        frozen=out / "raw/frozen.ply",
        frozen_out=out / "frozen.ply",
        quantize=a.quantize,
        native_frame="opencv-camera",
        extra=dict(
            motionSource="procedural idle/talk (worker/lhm_stages/idle_motion.py) around the "
            "Multi-HMR source pose; LHM native animation_infer_gs skinning",
            rootPose="upright [pi,0,0]" if use_upright else "Multi-HMR estimate",
            lowerBodyProvenance="Inferred by LHM from one generated reference image; legs held "
            "at the source pose (feet planted), only spine/neck/head/arms/jaw move",
            detail=a.detail,
            model=a.model_id,
            **(
                dict(finetune={k: finetune_report.get(k) for k in ("applied", "iterations", "sourceView", "reason", "error") if k in finetune_report})
                if finetune_report is not None
                else {}
            ),
        ),
    )
    timings["package"] = time.time() - t0
    # Runtime rig: canonical splats + skin + skeleton for browser skinning (rig_export.py), with the
    # shared motion library beside it. Optional: the baked sequence above stays the fallback.
    rig_report = None
    try:
        import rig_export

        rig = rig_export.export(
            model,
            dict(state=str(out / "canonical-state.pt"), frozen=str(out / "raw/frozen.ply"), out=str(out / "sequence"), upright=bool(use_upright), canonical=str(out / "rig-canonical.npz")),
        )
        pointer = rig_export.install_in_sequence(out / "sequence", rig, Path(a.motion_library) if a.motion_library else None)
        rig_report = dict(splats=rig["splats"], clips=pointer.get("clipNames"), validation={k: v["runtimeVsLhm"] for k, v in rig["validation"].items()})
        print(f"runtime rig: {rig['splats']} splats, clips {pointer.get('clipNames')}", flush=True)
    except Exception as error:  # noqa: BLE001 - the baked sequence is still a complete actor
        import traceback

        rig_report = dict(error=f"{type(error).__name__}: {error}"[:500])
        print("runtime rig export failed (baked sequence kept):", traceback.format_exc(), flush=True)
    timings["rig"] = time.time() - t0
    meta = dict(
        model=a.model_id,
        modelRevision=a.model_revision,
        detail=a.detail,
        finetune=finetune_report,
        codeRevision="4f88aaeb3629249fbbddb4d0784a06962d9e1338",
        seconds=time.time() - t0,
        timings=timings,
        peakVRAMGB=torch.cuda.max_memory_allocated() / 1e9,
        gpu=torch.cuda.get_device_name(),
        torch=torch.__version__,
        points=seq["gaussiansPerFrame"],
        frames=seq["count"],
        loops=seq["loops"],
        nativeHeight=seq["nativeHeight"],
        bounds=seq["bounds"],
        headDetected=head_detected,
        rig=rig_report,
        mask=mask_report,
        rootDeltaDeg=root_delta,
        uprightRoot=use_upright,
        sourceImageSha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        nativeCoordinates="raw/*.ply: Multi-HMR source camera (x right, y down, z forward). "
        "sequence/*.ply and frozen.ply: avatar-local OpenGL (see sequence.json avatarFrame).",
        coverage="All gaussian geometry and appearance inferred by LHM from one generated image; "
        "hidden surfaces (back, soles) are learned inference.",
    )
    (out / "result.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps({k: meta[k] for k in ("seconds", "peakVRAMGB", "points", "frames", "nativeHeight")}), flush=True)


if __name__ == "__main__":
    main()
