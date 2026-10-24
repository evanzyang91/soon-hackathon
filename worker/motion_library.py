#!/usr/bin/env python3
"""Shared actor motion library: HY-Motion clips -> seamless SMPL-X loops for the browser rig.

    python3 worker/motion_library.py --generate   # HY-Motion on Modal (L40S, once): raw/*.npz
    python3 worker/motion_library.py --build      # numpy: raw/*.npz -> motion-library.json + motion-clips.bin
    python3 worker/motion_library.py --upload     # copy the built library into the LHM Volume
    python3 worker/motion_library.py --gestures spec.json --out DIR   # one-shot beat gestures

Generated clips (every seed, raw/) and review builds stay in data/motion-library/ (untracked);
the built library (~160 KB) is committed in worker/motion-library/ and uploaded to the LHM Volume
(/cache/motion-library), where new actors pick it up. Motion is
body-agnostic: clips store 22 local joint rotations (SMPL-X joints 0..21 = SMPL body) and a root
offset; the browser (web/src/viewer/actors/rig.ts) adds the actor's own hands/jaw, grounds the
lowest foot every frame and rescales root travel by leg length.

Post-processing per clip (``build_clip``):

* heading: the clip is turned so its mean facing direction is +Z (SMPL-X forward), and the heading
  drift over the loop is removed linearly;
* loop: the window [a, b) whose end matches its start (pose a few frames either side, so the
  velocities match too) is cut out and its last ``SEAM_S`` cross-fade into the frames just before
  a, so the last frame flows into the first;
* root: x/z re-derived from the feet (``planted_root``: contacts are low and slow in the world;
  the root moves opposite their velocity), which removes the generator's foot skate; the walk
  cycle's mean forward velocity is stored as ``speed`` and taken out (the browser moves the actor);
* seed: the lowest ``score`` (loop mismatch, jitter, walk foot skate), unless ``PICK`` pins a seed
  after review (``--build --review`` writes every seed for the motion-review dev page).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "lhm_stages"))
import rig_math as rm  # noqa: E402

# generated clips + review builds (large, untracked) vs. the built library every actor ships with
WORK = ROOT / "data" / "motion-library"
LIBRARY = HERE / "motion-library"
SCHEMA = "previz.motion-library/1"
FPS = 30
SEEDS = [11, 23, 37, 41]
SEAM_S = 0.6

# name, pose, speaking, seconds, prompt (HY-Motion prompts: short, one action, < 30 words)
PROMPTS = [
    ("idle-listen", "standing", False, 8.0, "A person stands still, listening to someone, nodding slightly now and then, with relaxed arms and a small shift of weight between the feet."),
    ("talk-1", "standing", True, 8.0, "A person stands in place talking to someone, gesturing naturally with both hands in front of the body as they explain something."),
    ("talk-2", "standing", True, 8.0, "A person stands and talks to someone in front of them, now and then opening both palms outward as if asking a question, then lowering the hands."),
    ("sit-idle", "sitting", False, 8.0, "A person sits on a chair, relaxed, hands resting on the thighs, looking around calmly."),
    ("sit-talk", "sitting", True, 8.0, "A person sits upright on a chair and talks to someone, moving both hands in front of the chest as they speak."),
    ("walk", "walking", False, 5.0, "A person walks forward in a straight line at a relaxed, normal pace."),
]
SMPL_PARENTS = np.array([-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19])
# seed index per clip after visual review (None = automatic score)
# (reviewed 2026-10-24 on MAYA, contact sheets per seed: the most natural, least repetitive loop)
PICK: dict[str, int | None] = {"idle-listen": 0, "talk-1": 3, "talk-2": 0, "sit-talk": 0}


def load_auth():
    sys.path.insert(0, str(HERE))
    from run_actor import load_modal_auth

    if not load_modal_auth():
        raise SystemExit("Modal credentials absent (MODAL_TOKEN_ID/SECRET)")


def generate(names: list[str] | None = None) -> dict:
    load_auth()
    import modal

    import modal_motion

    prompts = [dict(name=n, text=t, seconds=s) for n, _, _, s, t in PROMPTS if not names or n in names]
    raw = WORK / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    with modal.enable_output() if os.environ.get("MOTION_MODAL_OUTPUT") else _null():
        with modal_motion.app.run():
            out = modal_motion.generate.remote(prompts, SEEDS)
    for name, data in out["clips"].items():
        (raw / f"{name}.npz").write_bytes(data)
    report = {k: v for k, v in out.items() if k != "clips"}
    report["wallSeconds"] = time.time() - t0
    (raw / "generate-report.json").write_text(json.dumps(report, indent=1))
    return report


class _null:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


# ---------------------------------------------------------------------------------------------
# Post-processing (pure numpy, unit tested)
# ---------------------------------------------------------------------------------------------


def yaw_of(R: np.ndarray) -> np.ndarray:
    """Heading (rad about +Y) of root rotations (..., 3, 3): angle of R @ +Z in the XZ plane."""
    f = R[..., :, 2]
    return np.arctan2(f[..., 0], f[..., 2])


def rot_y(a) -> np.ndarray:
    a = np.asarray(a, dtype=np.float64)
    c, s = np.cos(a), np.sin(a)
    z, o = np.zeros_like(a), np.ones_like(a)
    return np.stack([c, z, s, z, o, z, -s, z, c], -1).reshape(*a.shape, 3, 3)


def pose_distance(Ra: np.ndarray, Rb: np.ndarray) -> np.ndarray:
    """Sum over joints of rotation angle between (..., 22, 3, 3) poses (root tilt only: yaw free)."""
    rel = np.einsum("...jba,...jbc->...jac", Ra, Rb)
    tr = np.clip((np.trace(rel, axis1=-2, axis2=-1) - 1) / 2, -1, 1)
    return np.arccos(tr).sum(-1)


def unwrap_yaw(R: np.ndarray, transl: np.ndarray, target=0.0):
    """Rotate the whole clip about +Y so the mean heading becomes `target`."""
    yaw = np.unwrap(yaw_of(R[:, 0]))
    turn = rot_y(target - np.mean(yaw))
    R = R.copy()
    R[:, 0] = turn @ R[:, 0]
    return R, transl @ turn.T


def world_rots(Rf: np.ndarray) -> np.ndarray:
    G = np.empty_like(Rf)
    for j, p in enumerate(SMPL_PARENTS):
        G[j] = Rf[j] if p < 0 else G[p] @ Rf[j]
    return G


def rest_skeleton(R: np.ndarray, K: np.ndarray) -> np.ndarray:
    """The generator's rest joints (22, 3), recovered from frame 0's local rotations and posed
    keypoints: offset_j = G_parent^T (k_j - k_parent)."""
    G = world_rots(R[0])
    J = np.zeros((22, 3))
    J[0] = K[0, 0]
    for j in range(1, 22):
        p = SMPL_PARENTS[j]
        J[j] = J[p] + G[p].T @ (K[0, j] - K[0, p])
    return J


def clip_joints(R: np.ndarray, rest: np.ndarray, root: np.ndarray) -> np.ndarray:
    """(L, 22, 3) joint positions for local rotations R (L, 22, 3, 3) on a rest skeleton."""
    out = np.zeros((len(R), 22, 3))
    for f in range(len(R)):
        _, posed = rm.rigid_transforms(R[f], rest, SMPL_PARENTS)
        out[f] = posed + root[f]
    return out


def tilt_only(R0: np.ndarray) -> np.ndarray:
    """Root rotations with their heading removed (compare posture, not facing)."""
    return rot_y(-yaw_of(R0)) @ R0


def find_loop(R: np.ndarray, lo: int, min_len: int, max_len: int, ctx: int = 3) -> tuple[int, int, float]:
    """Best loop window [a, b): pose(b) ~ pose(a), also `ctx` frames before and after (so the
    velocities match too). a >= lo, b <= n - 1 - ctx. Returns (a, b, cost in rad summed over 22
    joints)."""
    n = len(R)
    P = R.copy()
    P[:, 0] = tilt_only(R[:, 0])
    best = (lo, min(n - 1 - ctx, lo + max_len), np.inf)
    for a in range(max(lo, ctx), n - ctx - min_len):
        bs = np.arange(a + min_len, min(a + max_len, n - 1 - ctx) + 1)
        if not len(bs):
            continue
        cost = pose_distance(P[a][None], P[bs])
        cost = cost + 0.5 * (pose_distance(P[a - ctx][None], P[bs - ctx]) + pose_distance(P[a + ctx][None], P[bs + ctx]))
        cost = cost - 0.0005 * (bs - a)  # mild preference for longer loops (less repetition)
        k = int(np.argmin(cost))
        if cost[k] < best[2]:
            best = (a, int(bs[k]), float(cost[k]))
    return best


def slerp_mats(Ra: np.ndarray, Rb: np.ndarray, w: float) -> np.ndarray:
    qa = rm.matrix_to_quat(Ra)
    qb = rm.matrix_to_quat(Rb)
    dot = np.einsum("...a,...a->...", qa, qb)
    qb = np.where(dot[..., None] < 0, -qb, qb)
    q = qa * (1 - w) + qb * w
    return rm.quat_to_matrix(q / np.linalg.norm(q, axis=-1, keepdims=True))


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)


def foot_skate(joints: np.ndarray, fps: float, speed: float = 0.0, contact_m: float = 0.025) -> float:
    """Mean horizontal speed (m/s) of foot joints in ground contact (within `contact_m` of the
    lowest foot height of the clip), in the world frame where the body travels at `speed` along
    +Z (0 = in place). Planted feet read ~0; sliding feet read their slide speed."""
    feet = joints[:, [7, 8, 10, 11]].copy()
    feet[..., 2] += speed * np.arange(len(feet))[:, None] / fps
    floor = feet[..., 1].min()
    v = np.linalg.norm(np.diff(feet[..., [0, 2]], axis=0), axis=-1) * fps
    contact = (feet[1:, :, 1] < floor + contact_m) & (feet[:-1, :, 1] < floor + contact_m)
    return float(v[contact].mean()) if contact.any() else 0.0


def planted_root(joints: np.ndarray, fps: float, guess: np.ndarray, contact_m: float = 0.035, slide: float = 0.45) -> tuple[np.ndarray, float, float]:
    """Root x/z per frame that keeps feet in ground contact still (foot locking).

    joints: in-place joint positions of a looping clip (L, 22, 3); guess: the generator's own root
    x/z per frame (L, 2), used only to tell a planted foot from one dragged forward low over the
    ground (world speed > `slide` m/s). Contact weight falls from 1 at the clip's floor to 0 at
    `contact_m` above it; the root moves opposite to the weighted contact velocity (two passes,
    the second gated by the first pass's root). Returns (root (L, 2) in place, forward speed
    (+Z m/s), lateral drift speed)."""
    feet = joints[:, [7, 8, 10, 11]]
    L = len(feet)
    floor = feet[..., 1].min()
    nxt = np.roll(feet, -1, axis=0)  # wraps: frame L-1 -> 0
    vel = (nxt[..., [0, 2]] - feet[..., [0, 2]]) * fps
    h = np.maximum(feet[..., 1], nxt[..., 1]) - floor
    w_h = np.clip(1 - h / contact_m, 0, 1) ** 2
    root_v = (np.roll(guess, -1, axis=0) - guess) * fps
    root_v[-1] = root_v[-2]
    for _ in range(2):
        world = vel + root_v[:, None, :]
        w = w_h * (np.linalg.norm(world, axis=-1) < slide)
        new_v = np.zeros((L, 2))
        last = root_v[0]
        for f in range(L):
            if w[f].sum() > 1e-6:
                last = -(w[f, :, None] * vel[f]).sum(0) / w[f].sum()
            new_v[f] = last
        root_v = new_v
    pos = np.concatenate([np.zeros((1, 2)), np.cumsum(root_v[:-1], 0) / fps])
    net = (pos[-1] + root_v[-1] / fps) / (L / fps)  # mean velocity over the loop
    pos -= np.outer(np.arange(L) / fps, net)
    pos -= pos.mean(0)
    return pos, float(net[1]), float(net[0])


def build_clip(name: str, pose: str, speaking: bool, rotmats: np.ndarray, transl: np.ndarray, keypoints: np.ndarray, fps=FPS) -> dict:
    """One seed's raw motion -> a seamless loop (local rotations + in-place root) and metrics."""
    R, T = unwrap_yaw(rotmats.astype(np.float64), transl.astype(np.float64))
    K = keypoints.astype(np.float64)
    J = rest_skeleton(rotmats.astype(np.float64), K)
    leg = float(np.mean([np.linalg.norm(J[1] - J[4]) + np.linalg.norm(J[4] - J[7]), np.linalg.norm(J[2] - J[5]) + np.linalg.norm(J[5] - J[8])]))
    n = len(R)
    walking = pose == "walking"
    seam = int((0.2 if walking else SEAM_S) * fps)
    lo = max(seam, n // 3 if walking else int(0.5 * fps))
    min_len, max_len = (int(0.8 * fps), int(1.7 * fps)) if walking else (int(4.0 * fps), n)
    a, b, cost = find_loop(R, lo, min_len, max_len)
    Re = R[a - seam : b + 1].copy()
    Te = T[a - seam : b + 1].copy()
    ia, ib = seam, len(Re) - 1
    idx = np.arange(len(Re))
    # heading drift over the loop -> 0 (frame b faces where frame a does)
    yaw = np.unwrap(yaw_of(Re[:, 0]))
    drift = yaw[ib] - yaw[ia]
    Re[:, 0] = rot_y(-drift * (idx - ia) / (ib - ia)) @ Re[:, 0]
    Te = Te - Te[ia]
    speed = 0.0
    if walking:
        d = Te[ib, [0, 2]]
        speed = float(np.linalg.norm(d)) / ((b - a) / fps)
        turn = rot_y(-np.arctan2(d[0], d[1]))
        Re[:, 0] = turn @ Re[:, 0]
        Te = Te @ turn.T
        Te[:, 2] -= speed * (idx - ia) / fps
        Te[:, 0] -= (Te[ib, 0] - Te[ia, 0]) * (idx - ia) / (ib - ia)
    else:
        for ax in (0, 2):
            Te[:, ax] -= (Te[ib, ax] - Te[ia, ax]) * (idx - ia) / (ib - ia)
    Te[:, [0, 2]] -= Te[ia:ib, [0, 2]].mean(0)
    L = b - a
    Rl = Re[ia:ib].copy()
    Tl = Te[ia:ib].copy()
    for i in range(seam):  # tail -> the frames just before a, so frame L-1 flows into frame 0
        w = float(smoothstep((i + 1) / (seam + 1)))
        Rl[L - seam + i] = slerp_mats(Rl[L - seam + i], Re[i], w)
        Tl[L - seam + i] = Tl[L - seam + i] * (1 - w) + Te[i] * w
    # root x/z from the feet (no skating), y kept for reference (the browser grounds the feet)
    inplace = clip_joints(Rl, J, np.zeros_like(Tl))
    guess = Tl[:, [0, 2]].copy()
    if walking:
        guess[:, 1] += speed * np.arange(L) / fps
    root_xz, fwd, lateral = planted_root(inplace, fps, guess)
    if walking:
        speed = fwd
    Tl[:, 0] = root_xz[:, 0]
    Tl[:, 2] = root_xz[:, 1]
    # metrics on the final loop (wrapped)
    Rw = np.concatenate([Rl, Rl[:1]])
    step = pose_distance(Rw[1:, 1:], Rw[:-1, 1:])
    joints = clip_joints(Rl, J, Tl)
    return dict(
        name=name,
        pose=pose,
        speaking=speaking,
        R=Rl,
        root=Tl,
        window=[int(a), int(b)],
        loopCost=float(cost),
        seamJump=float(step[-1]),
        medianStep=float(np.median(step)),
        maxStep=float(step.max()),
        speed=speed,
        legLength=leg,
        footSkate=foot_skate(joints, fps, speed),
        lateralDrift=lateral,
        frames=int(L),
    )


# ---------------------------------------------------------------------------------------------
# One-shot gestures for beats ("slams both palms on the table"): played once on the scene clock
# ---------------------------------------------------------------------------------------------

GESTURE_SEEDS = [11, 23]
#: generator warm-up trimmed from the start of a gesture take (s)
GESTURE_TRIM_S = 0.2
#: blend of the first / last frames toward the neighbouring idle (s), so it eases in and out
GESTURE_EASE_S = 0.25


def build_gesture(name: str, pose: str, rotmats: np.ndarray, transl: np.ndarray, keypoints: np.ndarray, fps=FPS) -> dict:
    """One seed's raw motion -> a one-shot clip: facing +Z, starting and ending where it stood
    (root x/z drift removed linearly, feet planted), generator warm-up trimmed."""
    R, T = unwrap_yaw(rotmats.astype(np.float64), transl.astype(np.float64))
    K = keypoints.astype(np.float64)
    J = rest_skeleton(rotmats.astype(np.float64), K)
    leg = float(np.mean([np.linalg.norm(J[1] - J[4]) + np.linalg.norm(J[4] - J[7]), np.linalg.norm(J[2] - J[5]) + np.linalg.norm(J[5] - J[8])]))
    a = min(int(GESTURE_TRIM_S * fps), max(0, len(R) - 2 * fps))
    R = R[a:].copy()
    T = T[a:].copy()
    n = len(R)
    idx = np.arange(n)
    # the heading at the start is the actor's facing; drift over the take is removed linearly
    yaw = np.unwrap(yaw_of(R[:, 0]))
    R[:, 0] = rot_y(-(yaw[-1] - yaw[0]) * idx / max(n - 1, 1)) @ R[:, 0]
    T = T - T[0]
    inplace = clip_joints(R, J, np.zeros_like(T))
    root_xz, _, lateral = planted_root(inplace, fps, T[:, [0, 2]].copy())
    T[:, 0], T[:, 2] = root_xz[:, 0], root_xz[:, 1]
    for ax in (0, 2):  # end where it started: the actor's mark does not move during a gesture
        T[:, ax] -= T[0, ax] + (T[-1, ax] - T[0, ax]) * idx / max(n - 1, 1)
    step = pose_distance(R[1:, 1:], R[:-1, 1:])
    return dict(
        name=name,
        pose=pose,
        speaking=False,
        R=R,
        root=T,
        window=[int(a), int(a + n)],
        loopCost=0.0,
        seamJump=0.0,
        medianStep=float(np.median(step)),
        maxStep=float(step.max()),
        speed=0.0,
        legLength=leg,
        footSkate=foot_skate(clip_joints(R, J, T), fps),
        lateralDrift=lateral,
        frames=int(n),
    )


def gesture_score(c: dict) -> float:
    """Lower is better: jitter (worst step vs the median) and foot skate."""
    return c["maxStep"] / max(c["medianStep"], 1e-6) + 4 * c["footSkate"]


def library_json(clip_file: str, blob: bytes, meta: list[dict]) -> dict:
    return dict(
        schema=SCHEMA,
        fps=FPS,
        joints=22,
        file=clip_file,
        bytes=len(blob),
        sha256=hashlib.sha256(blob).hexdigest(),
        layout="per clip at `offset`: frames x 22 x int16 [x,y,z,w]*32767 local rotations (SMPL-X joints 0..21, root = "
        "global orientation, +Y up, faces +Z), then frames x float32 [x,y,z] root offset (source metres; x/z in place)",
        source="HY-Motion 1.0 (tencent/HY-Motion-1.0 @620dd559, code @4e426f5a), text guidance 5.0, 50 Euler steps, 30 fps; "
        "seamless loops by worker/motion_library.py",
        clips=meta,
    )


def write_gesture(out: Path, key: str, prompt: str, pose: str, npz) -> dict:
    """Best seed of one generated gesture -> out/<key>.json + out/<key>.bin (a one-clip library)."""
    cands = []
    for s in range(npz["rotmats"].shape[0]):
        c = build_gesture(key, pose, npz["rotmats"][s], npz["transl"][s], npz["keypoints"][s])
        c["seed"] = int(npz["seeds"][s])
        c["prompt"] = prompt
        cands.append(c)
    best = min(cands, key=gesture_score)
    blob, meta = encode([best])
    meta[0]["oneShot"] = True
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{key}.bin").write_bytes(blob)
    lib = library_json(f"{key}.bin", blob, meta)
    (out / f"{key}.json").write_text(json.dumps(lib, indent=1))
    return meta[0]


def gestures(spec_path: str, out_dir: str) -> dict:
    """spec: {"gestures": [{"key", "prompt", "seconds", "pose"}]} -> every key cached in out_dir
    (generated on Modal only when out_dir/<key>.json is missing; one GPU call for all of them)."""
    spec = json.loads(Path(spec_path).read_text())["gestures"]
    out = Path(out_dir)
    missing = [g for g in spec if not (out / f"{g['key']}.json").exists()]
    report: dict = {"cached": len(spec) - len(missing), "generated": [], "estimatedComputeUSD": 0.0}
    if missing:
        load_auth()
        import io

        import modal

        import modal_motion

        prompts = [dict(name=g["key"], text=g["prompt"], seconds=float(g["seconds"])) for g in missing]
        t0 = time.time()
        with modal.enable_output() if os.environ.get("MOTION_MODAL_OUTPUT") else _null():
            with modal_motion.app.run():
                res = modal_motion.generate.remote(prompts, GESTURE_SEEDS)
        for g in missing:
            npz = np.load(io.BytesIO(res["clips"][g["key"]]))
            meta = write_gesture(out, g["key"], g["prompt"], g.get("pose", "standing"), npz)
            report["generated"].append(dict(key=g["key"], frames=meta["frames"], seed=meta["seed"]))
        report["estimatedComputeUSD"] = res.get("estimatedComputeUSD", 0.0)
        report["gpuSeconds"] = res.get("seconds")
        report["wallSeconds"] = time.time() - t0
    return report


def score(c: dict) -> float:
    """Lower is better: raw loop mismatch (before the seam blend), the worst frame-to-frame jump
    relative to the median (jitter), and foot skate for the walk cycle."""
    s = c["loopCost"] + 0.2 * c["maxStep"] / max(c["medianStep"], 1e-6)
    if c["pose"] == "walking":
        s += 4 * c["footSkate"]
    return s


def encode(clips: list[dict]) -> tuple[bytes, list[dict]]:
    blob = bytearray()
    meta = []
    for c in clips:
        q = rm.matrix_to_quat(c["R"])  # (L, 22, 4) w,x,y,z
        q_xyzw = np.concatenate([q[..., 1:], q[..., :1]], -1)
        # keep consecutive frames in one hemisphere per joint (nlerp in the browser)
        for f in range(1, len(q_xyzw)):
            flip = np.einsum("ja,ja->j", q_xyzw[f], q_xyzw[f - 1]) < 0
            q_xyzw[f, flip] *= -1
        q16 = np.clip(np.round(q_xyzw * 32767), -32767, 32767).astype("<i2")
        offset = len(blob)
        blob += q16.tobytes()
        blob += c["root"].astype("<f4").tobytes()
        meta.append(
            dict(
                name=c["name"],
                pose=c["pose"],
                speaking=c["speaking"],
                frames=c["frames"],
                offset=offset,
                speed=round(c["speed"], 4),
                legLength=round(c["legLength"], 4),
                seconds=round(c["frames"] / FPS, 3),
                seed=c.get("seed"),
                window=c["window"],
                seamJump=round(c["seamJump"], 4),
                medianStep=round(c["medianStep"], 4),
                prompt=c.get("prompt"),
            )
        )
        while len(blob) % 4:
            blob += b"\0"
    return bytes(blob), meta


def build(review: bool = False) -> dict:
    """Builds the library from raw/; review=True writes motion-library-review.* with every seed
    (clip names "<name>#<seed index>") for side-by-side review in the motion-review dev page."""
    raw = WORK / "raw"
    chosen = []
    every = []
    report = {}
    for name, pose, speaking, _, prompt in PROMPTS:
        path = raw / f"{name}.npz"
        if not path.exists():
            raise SystemExit(f"{path} missing; run --generate first")
        d = np.load(path)
        cands = []
        for s in range(d["rotmats"].shape[0]):
            c = build_clip(name, pose, speaking, d["rotmats"][s], d["transl"][s], d["keypoints"][s])
            c["seed"] = int(d["seeds"][s])
            c["seedIndex"] = s
            c["prompt"] = prompt
            c["score"] = score(c)
            cands.append(c)
        pick = PICK.get(name)
        best = cands[pick] if pick is not None else min(cands, key=lambda c: c["score"])
        chosen.append(best)
        every += [{**c, "name": f"{name}#{c['seedIndex']}"} for c in cands]
        report[name] = [
            dict(seed=c["seed"], score=round(c["score"], 3), loopCost=round(c["loopCost"], 3), seam=round(c["seamJump"], 4), step=round(c["medianStep"], 4), maxStep=round(c["maxStep"], 4), skate=round(c["footSkate"], 3), frames=c["frames"], speed=round(c["speed"], 3), chosen=c is best)
            for c in cands
        ]
    blob, meta = encode(every if review else chosen)
    stem = "motion-library-review" if review else "motion-library"
    clip_file = "motion-clips-review.bin" if review else "motion-clips.bin"
    lib = dict(
        schema=SCHEMA,
        fps=FPS,
        joints=22,
        file=clip_file,
        bytes=len(blob),
        sha256=hashlib.sha256(blob).hexdigest(),
        layout="per clip at `offset`: frames x 22 x int16 [x,y,z,w]*32767 local rotations (SMPL-X joints 0..21, root = "
        "global orientation, +Y up, faces +Z), then frames x float32 [x,y,z] root offset (source metres; x/z in place)",
        source="HY-Motion 1.0 (tencent/HY-Motion-1.0 @620dd559, code @4e426f5a), text guidance 5.0, 50 Euler steps, 30 fps; "
        "seamless loops by worker/motion_library.py",
        clips=meta,
    )
    dest = WORK if review else LIBRARY
    dest.mkdir(parents=True, exist_ok=True)
    (dest / clip_file).write_bytes(blob)
    (dest / f"{stem}.json").write_text(json.dumps(lib, indent=1))
    if not review:
        (WORK / "build-report.json").write_text(json.dumps(report, indent=1))
        # local cache next to the generated clips (the tracked copy is the one actors ship with)
        for f in (clip_file, f"{stem}.json"):
            (WORK / f).write_bytes((LIBRARY / f).read_bytes())
    return dict(bytes=len(blob), clips=[(m["name"], m["frames"], m["seed"], m["speed"]) for m in meta], report=report)


def upload() -> None:
    load_auth()
    import modal

    vol = modal.Volume.from_name("previz-stage-lhm-cache", create_if_missing=False)
    with vol.batch_upload(force=True) as batch:
        for f in ("motion-library.json", "motion-clips.bin"):
            batch.put_file(str(LIBRARY / f), f"/motion-library/{f}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--generate", nargs="*", metavar="NAME", help="generate (all, or the named clips)")
    ap.add_argument("--build", action="store_true")
    ap.add_argument("--review", action="store_true", help="with --build: every seed, for review")
    ap.add_argument("--upload", action="store_true")
    ap.add_argument("--gestures", metavar="SPEC", help="one-shot beat gestures from a JSON spec (with --out)")
    ap.add_argument("--out", metavar="DIR", help="with --gestures: the gesture cache directory")
    a = ap.parse_args(argv)
    if a.gestures:
        if not a.out:
            ap.error("--gestures needs --out")
        print("RESULT " + json.dumps(gestures(a.gestures, a.out)), flush=True)
        return 0
    if a.generate is not None:
        print(json.dumps(generate(a.generate or None), indent=1))
    if a.build:
        out = build(a.review)
        print(json.dumps({k: v for k, v in out.items() if k != "report"}, indent=1))
    if a.upload:
        upload()
        print("uploaded to previz-stage-lhm-cache:/motion-library/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
