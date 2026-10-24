#!/usr/bin/env python3
"""LHM canonical avatar -> browser runtime rig (canonical splats + skin + SMPL-X skeleton).

Runs inside the Modal GPU image (cwd /opt/lhm) with the LHM model loaded, because the dense
SMPL-X buffers (per-gaussian skinning weights, shape blendshapes, the 55-joint skeleton) live in
``model.renderer.smplx_model``. Input is the ``canonical-state.pt`` lhm_actor.py already saves.

LHM's ``animate_gs_model`` (rev 4f88aaeb) poses gaussian i as

    x_zero = (sum_j w_ij M_j) x_neutral + B_i(betas)      M_j = transform_mat_neutral_pose[j]
    x      = (sum_j w_ij A_j(theta)) x_zero + trans        A_j = batch_rigid_transform(theta, J)

with fixed w (``smplx_model.skinning_weight``: gaussian i is dense SMPL-X vertex i). We export
x_zero / q_zero (the zero pose with the actor's shape), the top-4 weights in Spark's 8-bit skin
format, and J + parents, so the browser computes A_j for any pose and Spark's ``SplatSkinning``
(dual quaternions) skins on the GPU. Every export re-poses the avatar with LHM itself and records
how far the runtime reconstruction lands (``validation`` in rig.json).

    python rig_export.py --job job.json --model MODEL_DIR
    job.json: [{"state": .../canonical-state.pt, "frozen": .../raw/frozen.ply,
                "result": .../result.json, "out": DIR}, ...]

Outputs per job: DIR/canonical.npz (offline rebuild input), DIR/rig.json, DIR/rig-splats.bin
(built by rig_build.py; see worker/README.md "Runtime rig").
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rig_build  # noqa: E402
from package_actor import read_ply  # noqa: E402


def canonical(model, state: dict) -> dict:
    """Zero-pose splats, weights, skeleton (numpy) from LHM's canonical state."""
    import torch
    from LHM.models.rendering.smplx.smplx.lbs import blend_shapes
    from pytorch3d.transforms import matrix_to_quaternion, quaternion_multiply

    sm = model.renderer.smplx_model
    gs = state["attrs"][0]
    query = state["query"][0].float()
    neutral = state["neutral"]
    neutral = neutral[0] if neutral.dim() == 4 else neutral
    params = state["params"]
    betas = params["betas"].float()
    if betas.dim() == 1:
        betas = betas[None]
    with torch.no_grad():
        W = sm.skinning_weight.float()  # [N, 55]
        x_neutral = query + gs.offset_xyz.float()
        T_null = torch.einsum("nj,jab->nab", W, neutral.float())
        x_null = (T_null[:, :3, :3] @ x_neutral[..., None])[..., 0] + T_null[:, :3, 3]
        x_zero = x_null + blend_shapes(betas, sm.shape_dirs)[0]
        r_null = torch.nn.functional.normalize(matrix_to_quaternion(T_null[:, :3, :3]), dim=-1)
        rot = torch.nn.functional.normalize(gs.rotation.float(), dim=-1)
        q_zero = torch.nn.functional.normalize(quaternion_multiply(r_null, rot), dim=-1)
        constrain = sm.is_constrain_body.bool()
        # LHM never rotates the "constrain body" prior subset: keep its canonical orientation
        q_zero[constrain] = rot[constrain]
        J = sm.get_zero_pose_human(shape_param=betas, device=betas.device, face_offset=None, joint_offset=None)[0]
    return dict(
        x_zero=x_zero.double().cpu().numpy(),
        q_zero=q_zero.double().cpu().numpy(),
        q_neutral=rot.double().cpu().numpy(),
        r_null=T_null[:, :3, :3].double().cpu().numpy(),
        weights=W.double().cpu().numpy(),
        joints=J.double().cpu().numpy(),
        parents=sm.smplx_layer.parents.cpu().numpy().astype(np.int64),
        constrain=constrain.cpu().numpy(),
        params={k: v.detach().float().cpu().numpy() for k, v in params.items() if k != "transform_mat_neutral_pose"},
    )


def lhm_pose(model, state: dict, overrides: dict):
    """LHM's own posed gaussians (camera frame) for the source params with `overrides`."""
    import torch

    p = {k: v.clone() for k, v in state["params"].items()}
    for k, v in overrides.items():
        p[k] = torch.tensor(np.asarray(v), dtype=torch.float32, device=p[k].device).reshape(p[k].shape)
    with torch.inference_mode():
        gs = model.animation_infer_gs(state["attrs"], state["query"], p)
    return gs.xyz.double().cpu().numpy(), torch.nn.functional.normalize(gs.rotation.float(), dim=-1).double().cpu().numpy()


def lhm_test_poses(c: dict, root: np.ndarray) -> dict:
    """Poses LHM itself renders to prove rig_build.reference_pose is exact."""
    poses = rig_build.test_poses({**{f"param_{k}": v for k, v in c["params"].items()}, "root": root})
    return {k: poses[k] for k in ("source", "deformed")}


def export(model, job: dict) -> dict:
    import torch

    t0 = time.time()
    out = Path(job["out"])
    out.mkdir(parents=True, exist_ok=True)
    state = torch.load(job["state"], map_location="cuda")
    c = canonical(model, state)
    result = json.loads(Path(job["result"]).read_text()) if job.get("result") and Path(job["result"]).exists() else {}
    upright = job["upright"] if "upright" in job else result.get("uprightRoot", True)
    root = np.array([math.pi, 0, 0]) if upright else c["params"]["root_pose"].reshape(3)
    refs = {name: lhm_pose(model, state, pose) for name, pose in lhm_test_poses(c, root).items()}
    canon = dict(
        x_zero=c["x_zero"], q_zero=c["q_zero"], q_neutral=c["q_neutral"], r_null=c["r_null"].astype(np.float32),
        weights=c["weights"].astype(np.float32), joints=c["joints"], parents=c["parents"], constrain=c["constrain"],
        root=root, **{f"param_{k}": v for k, v in c["params"].items()},
        **{f"ref_{k}_x": v[0] for k, v in refs.items()}, **{f"ref_{k}_q": v[1] for k, v in refs.items()},
    )
    # everything needed to rebuild / re-evaluate the rig offline (numpy only)
    np.savez_compressed(Path(job.get("canonical") or out / "canonical.npz"), **canon)
    props, static = read_ply(job["frozen"])
    canon["weights"] = c["weights"]  # build from the exact float64 weights
    rig = rig_build.build(canon, props, static, out, refs)
    rig["seconds"] = time.time() - t0
    return rig


MOTION_FILES = ("motion-library.json", "motion-clips.bin")


def install_in_sequence(seq_dir: Path, rig: dict, library: Path | None) -> dict:
    """Copy the shared motion library next to rig.json and point sequence.json at both."""
    import hashlib
    import shutil

    seq_dir = Path(seq_dir)
    pointer = {"schema": rig["schema"], "file": "rig.json", "sha256": hashlib.sha256((seq_dir / "rig.json").read_bytes()).hexdigest()}
    if library and all((Path(library) / f).is_file() for f in MOTION_FILES):
        for f in MOTION_FILES:
            shutil.copyfile(Path(library) / f, seq_dir / f)
        lib = json.loads((seq_dir / "motion-library.json").read_text())
        pointer.update(
            clips="motion-library.json",
            clipsSha256=hashlib.sha256((seq_dir / "motion-library.json").read_bytes()).hexdigest(),
            clipNames=[c["name"] for c in lib["clips"]],
        )
    path = seq_dir / "sequence.json"
    sequence = json.loads(path.read_text())
    sequence["rig"] = pointer
    path.write_text(json.dumps(sequence, indent=2))
    return pointer


def load_model(model_dir: str):
    import torch
    from accelerate import Accelerator

    torch._dynamo.config.disable = True
    torch.backends.cuda.matmul.allow_tf32 = False  # exact fp32 for the validation comparison
    Accelerator()  # LHM logs through accelerate, which refuses to log before this exists
    from LHM.models import model_dict
    from LHM.utils.hf_hub import wrap_model_hub

    model = wrap_model_hub(model_dict["human_lrm_sapdino_bh_sd3_5"]).from_pretrained(model_dir)
    model.eval()
    model.cuda()
    return model


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--repo", default="/opt/lhm")
    a = ap.parse_args()
    os.chdir(a.repo)
    sys.path.insert(0, a.repo)
    jobs = json.loads(Path(a.job).read_text())
    t0 = time.time()
    model = load_model(a.model)
    print(f"model loaded in {time.time() - t0:.1f}s", flush=True)
    for job in jobs:
        rig = export(model, job)
        print(json.dumps({"out": job["out"], "splats": rig["splats"], "constrained": rig["constrainedSplats"], "measure": rig["measure"], "validation": rig["validation"], "seconds": rig["seconds"]}), flush=True)


if __name__ == "__main__":
    main()
