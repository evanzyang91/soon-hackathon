#!/usr/bin/env python3
"""Canonical LHM avatar (``canonical.npz``) -> browser runtime rig: rig.json + rig-splats.bin.

Pure numpy, so it runs in the GPU worker right after ``rig_export.canonical`` and offline from a
downloaded ``rig-canonical.npz``:

    python3 worker/lhm_stages/rig_build.py ACTOR_DIR      # ACTOR_DIR/rig-canonical.npz -> sequence/

``reference_pose`` is LHM's own posing (``animate_gs_model``) re-implemented in numpy; the export
checks it against ``animation_infer_gs`` (agreement ~0.0003 mm / 0.00003 deg). The browser skins
with Spark's dual quaternions over the top-4 8-bit weights instead of 55-weight LBS, so the bind
positions/rotations are *rebound at the source pose*: every splat gets the inverse of its own
source-pose DQ transform applied to LHM's exact source-pose output. The runtime then reproduces
the frozen avatar exactly at the source pose (what the baked sequence shows) and drifts from LHM's
LBS only as the pose moves away from it (measured per test pose in ``validation``).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rig_math as rm  # noqa: E402
from package_actor import read_ply  # noqa: E402

SCHEMA = "previz.actor-rig/1"
SH_C0 = 0.28209479177387814
PARAM_KEYS = ("root_pose", "body_pose", "jaw_pose", "lhand_pose", "rhand_pose", "trans")


def params_of(c: dict) -> dict:
    return {k[6:]: np.asarray(c[k], dtype=np.float64) for k in c if k.startswith("param_")}


def rotations(c: dict, pose: dict):
    P = params_of(c)
    get = lambda k: np.asarray(pose[k] if k in pose else P[k], dtype=np.float64).reshape(-1)  # noqa: E731
    rot = rm.pose_rotmats(get("root_pose"), get("body_pose"), get("jaw_pose"), get("lhand_pose"), get("rhand_pose"))
    A, _ = rm.rigid_transforms(rot, c["joints"], c["parents"])
    A[:, :3, 3] += get("trans")
    return A


def reference_pose(c: dict, pose: dict):
    """LHM ``animate_gs_model`` in numpy: 55-weight LBS of the zero-pose splats, rotations from
    the quaternion of (blended pose matrix x blended neutral->zero matrix), constrain prior kept."""
    A = rotations(c, pose)
    W = np.asarray(c["weights"], dtype=np.float64)
    T = np.einsum("nj,jab->nab", W, A)
    x = np.einsum("nab,nb->na", T[:, :3, :3], c["x_zero"]) + T[:, :3, 3]
    q = rm.quat_mul(rm.matrix_to_quat(T[:, :3, :3] @ np.asarray(c["r_null"], dtype=np.float64)), c["q_neutral"])
    cons = np.asarray(c["constrain"], dtype=bool)
    q[cons] = c["q_neutral"][cons]
    return x, q, A


def splat_dq(bones, w8, qr, qd):
    """Per-splat blended unit dual quaternion (exactly Spark's shader blend)."""
    n = len(bones)
    w = w8.astype(np.float64) / 255.0
    accr = np.zeros((n, 4))
    accd = np.zeros((n, 4))
    for i in range(bones.shape[1]):
        br = qr[bones[:, i]]
        bd = qd[bones[:, i]]
        if i > 0:
            flip = np.einsum("na,na->n", accr, br) < 0
            br = np.where(flip[:, None], -br, br)
            bd = np.where(flip[:, None], -bd, bd)
        accr += w[:, i : i + 1] * br
        accd += w[:, i : i + 1] * bd
    norm = np.linalg.norm(accr, axis=1, keepdims=True)
    return accr / norm, accd / norm


def rebind(c: dict, source: dict, bones, w8):
    """Bind splats so the runtime DQ skin reproduces LHM's source-pose output exactly."""
    xs, qs, A = reference_pose(c, source)
    qr, qd = rm.dq_from_rigid(A)
    r, d = splat_dq(bones, w8, qr, qd)
    t = 2 * rm.quat_mul(d, r * [1, -1, -1, -1])[:, 1:]
    inv = r * [1, -1, -1, -1]
    return rm.quat_rotate(inv, xs - t), rm.quat_mul(inv, qs)


def error_report(ref_x, x, ref_q=None, q=None, mask=None) -> dict:
    d = np.linalg.norm(ref_x - x, axis=1) * 1000  # mm (native SMPL-X metres)
    r = dict(meanMm=round(float(d.mean()), 3), p99Mm=round(float(np.percentile(d, 99)), 2), maxMm=round(float(d.max()), 2))
    if q is not None:
        a = rm.angle_deg(ref_q, q)
        r.update(meanDeg=round(float(a.mean()), 3), p99Deg=round(float(np.percentile(a, 99)), 2))
        if mask is not None and mask.any():
            r["p99DegConstrainPrior"] = round(float(np.percentile(a[mask], 99)), 2)
    return r


def test_poses(c: dict) -> dict:
    """Source pose and typical performance deformations, all relative to the source body."""
    root = np.asarray(c["root"], dtype=np.float64)
    body = params_of(c)["body_pose"].reshape(21, 3)

    def mod(jaw=None, **joints):
        b = body.copy()
        for name, v in joints.items():
            b[int(name[1:]) - 1] = v  # j16 = SMPL-X joint 16 (left shoulder) = body_pose[15]
        pose = {"root_pose": root, "body_pose": b}
        if jaw is not None:
            pose["jaw_pose"] = jaw
        return pose

    return {
        "source": {"root_pose": root},
        "gesture": mod(j16=[0.0, -0.3, -0.6], j17=[0.2, 0.4, 0.5], j18=[0, -1.3, 0], j19=[0, 1.2, 0]),
        "stride": mod(j1=[-0.45, 0, 0], j2=[0.3, 0, 0], j4=[0.2, 0, 0], j5=[0.6, 0, 0], j16=[0.3, 0, 0], j17=[-0.3, 0, 0]),
        "sit": mod(j1=[-1.5, 0, 0.05], j2=[-1.5, 0, -0.05], j4=[1.55, 0, 0], j5=[1.55, 0, 0]),
        "deformed": mod(jaw=[0.25, 0, 0], j16=[0, 0, -1.2], j18=[0, -1.4, 0], j17=[0.6, 0, 0.9], j2=[-1.4, 0, 0], j5=[1.5, 0, 0], j3=[0, 0.35, 0], j15=[0.3, 0.6, 0]),
        "tpose": {"root_pose": root, "body_pose": np.zeros((21, 3))},
    }


def measure(c: dict, x_bind: np.ndarray, opacity_logit: np.ndarray) -> dict:
    """Stature and grounding numbers in the bind (zero) pose."""
    keep = opacity_logit > 0
    o = x_bind[keep] if keep.sum() >= 16 else x_bind
    lo = np.percentile(o, 0.5, axis=0)
    hi = np.percentile(o, 99.5, axis=0)
    J = np.asarray(c["joints"])
    foot_min = float(min(J[j, 1] for j in rm.FOOT_JOINTS))
    leg = float(np.mean([np.linalg.norm(J[1] - J[4]) + np.linalg.norm(J[4] - J[7]), np.linalg.norm(J[2] - J[5]) + np.linalg.norm(J[5] - J[8])]))
    return dict(
        nativeHeight=round(float(hi[1] - lo[1]), 5),
        soleY=round(float(lo[1]), 5),
        footJointMinY=round(foot_min, 5),
        soleGap=round(float(foot_min - lo[1]), 5),
        legLength=round(leg, 5),
        hipHeight=round(float(J[0, 1] - lo[1]), 5),
        opaqueMin=np.round(lo, 5).tolist(),
        opaqueMax=np.round(hi, 5).tolist(),
    )


def write_splats(path: Path, x: np.ndarray, q: np.ndarray, props: list[str], static: np.ndarray, skin: np.ndarray) -> dict:
    """Struct-of-arrays little-endian binary; offsets/types in the returned layout."""
    n = len(x)
    col = lambda name: static[:, props.index(name)].astype(np.float64)  # noqa: E731
    rgb = np.stack([col(f"f_dc_{k}") for k in range(3)], 1) * SH_C0 + 0.5
    alpha = 1 / (1 + np.exp(-col("opacity")))
    rgba = np.clip(np.round(np.concatenate([rgb, alpha[:, None]], 1) * 255), 0, 255).astype(np.uint8)
    scales = np.exp(np.stack([col(f"scale_{k}") for k in range(3)], 1)).astype("<f4")
    q = q / np.linalg.norm(q, axis=1, keepdims=True)  # (w, x, y, z) -> stored (x, y, z, w) like three.js
    q16 = np.clip(np.round(np.concatenate([q[:, 1:], q[:, :1]], 1) * 32767), -32767, 32767).astype("<i2")
    sections = [
        ("center", x.astype("<f4"), "float32", 3),
        ("quat", q16, "int16-norm (x,y,z,w) * 32767", 4),
        ("scale", scales, "float32 (linear)", 3),
        ("rgba", rgba, "uint8", 4),
        ("skin", skin, "uint16 (weight8 | bone << 8), Spark SplatSkinning layout", 4),
    ]
    layout, offset, blob = {}, 0, bytearray()
    for name, arr, kind, comps in sections:
        arr = np.ascontiguousarray(arr)
        assert arr.shape == (n, comps), (name, arr.shape)
        layout[name] = dict(offset=offset, type=kind, components=comps)
        blob += arr.tobytes()
        offset += arr.nbytes
    path.write_bytes(bytes(blob))
    return dict(file=path.name, bytes=len(blob), sha256=hashlib.sha256(blob).hexdigest(), layout=layout)


def build(c: dict, props: list[str], static: np.ndarray, out: Path, lhm_refs: dict | None = None) -> dict:
    """Writes out/rig.json + out/rig-splats.bin; returns the rig record.

    ``static``: any packaged/raw frame of this avatar (colour, opacity and scale are identical in
    every frame; positions are not used). ``lhm_refs``: {pose: (x, q)} from animation_infer_gs.
    """
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    n = len(c["x_zero"])
    if len(static) != n:
        raise ValueError(f"static frame has {len(static)} splats, canonical state {n}")
    bones, w8 = rm.topk_weights(c["weights"], 4)
    skin = rm.spark_skin_words(bones, w8)
    poses = test_poses(c)
    x_bind, q_bind = rebind(c, poses["source"], bones, w8)
    cons = np.asarray(c["constrain"], dtype=bool)
    validation = {}
    for name, pose in poses.items():
        ref_x, ref_q, A = reference_pose(c, pose)
        qr, qd = rm.dq_from_rigid(A)
        x, q = rm.dq_skin(x_bind, q_bind, bones, w8, qr, qd)
        v = dict(runtimeVsLhm=error_report(ref_x, x, ref_q, q, cons))
        if lhm_refs and name in lhm_refs:
            lx, lq = lhm_refs[name]
            v["numpyReferenceVsLhm"] = error_report(lx, ref_x, lq, ref_q)
        validation[name] = v
    P = params_of(c)
    root = np.asarray(c["root"], dtype=np.float64)
    splats = write_splats(out / "rig-splats.bin", x_bind, q_bind, props, static, skin)
    rig = dict(
        schema=SCHEMA,
        splats=n,
        bones=55,
        frame="SMPL-X canonical: +Y up, the body faces +Z, metres (LHM native). Bind = the zero "
        "pose (T-pose) with the actor's shape, rebound so the DQ skin is exact at sourcePose. "
        "Viewer: rotation.y = pi faces -Z (ActorHandle forward).",
        joints=list(rm.SMPLX_JOINTS),
        parents=[int(p) for p in c["parents"]],
        rest=np.round(c["joints"], 6).tolist(),
        sourcePose=dict(
            root=root.tolist(),
            body=np.round(P["body_pose"].reshape(21, 3), 6).tolist(),
            jaw=np.round(P["jaw_pose"].reshape(3), 6).tolist(),
            lhand=np.round(P["lhand_pose"].reshape(15, 3), 6).tolist(),
            rhand=np.round(P["rhand_pose"].reshape(15, 3), 6).tolist(),
        ),
        measure=measure(c, x_bind, static[:, props.index("opacity")]),
        constrainedSplats=int(cons.sum()),
        skinning="dual quaternion, top-4 bones, 8-bit weights (Spark SplatSkinning), rebound at sourcePose",
        files=dict(splats=splats),
        validation=validation,
        source=dict(model="3DAIGC/LHM-500M-HF", codeRevision="4f88aaeb3629249fbbddb4d0784a06962d9e1338"),
    )
    (out / "rig.json").write_text(json.dumps(rig, indent=1))
    return rig


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("actor_dir", help="dir with rig-canonical.npz and sequence/frame_000.ply")
    ap.add_argument("--out", help="default: ACTOR_DIR/sequence")
    a = ap.parse_args()
    actor = Path(a.actor_dir)
    c = dict(np.load(actor / "rig-canonical.npz"))
    refs = {k[4:-2]: (c[k], c[k[:-1] + "q"]) for k in c if k.startswith("ref_") and k.endswith("_x")}
    props, static = read_ply(actor / "sequence" / "frame_000.ply")
    rig = build(c, props, static, Path(a.out) if a.out else actor / "sequence", refs)
    print(json.dumps({"measure": rig["measure"], "validation": rig["validation"]}, indent=1))


if __name__ == "__main__":
    main()
