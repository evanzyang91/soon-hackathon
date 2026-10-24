"""Procedural, seamlessly looping SMPL-X idle and talk motion around a measured source pose.

LHM animates its canonical gaussians with native SMPL-X linear blend skinning
(``model.animation_infer_gs``); any SMPL-X parameter sequence works. LHM's sample motions
(``motion_video.tar`` -> ``train_data/motion_video/mimo1/smplx_params``, 3.5 GB) are full-body
dance clips with root translation, which is wrong for an actor standing on a mark. Instead we
perturb the Multi-HMR source pose of the reference image:

* idle: breathing (spine pitch), lateral sway (spine roll), a slow head turn, arm sway.
* talk: idle plus quicker nods and jaw opening on a syllable-like rhythm.

Every term is ``sin(2*pi*k*i/N)`` with integer ``k``, so frame N would equal frame 0 (seamless
loop) and frame 0 equals the source pose exactly (the frozen avatar is frame 0). Only joints above
the pelvis move, so the feet stay planted. Pure numpy; unit tested in worker/tests.
"""

from __future__ import annotations

import numpy as np

# SMPL-X body joints; body_pose[k] is joint k+1 (pelvis/root is separate).
JOINTS = {
    "left_hip": 1,
    "right_hip": 2,
    "spine1": 3,
    "left_knee": 4,
    "right_knee": 5,
    "spine2": 6,
    "left_ankle": 7,
    "right_ankle": 8,
    "spine3": 9,
    "left_foot": 10,
    "right_foot": 11,
    "neck": 12,
    "left_collar": 13,
    "right_collar": 14,
    "head": 15,
    "left_shoulder": 16,
    "right_shoulder": 17,
    "left_elbow": 18,
    "right_elbow": 19,
    "left_wrist": 20,
    "right_wrist": 21,
}
LEG_JOINTS = ("left_hip", "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_foot", "right_foot")

# (joint, axis, amplitude rad, cycles per loop, phase) — axes in the SMPL-X canonical frame:
# x = pitch (nod/bend forward), y = yaw (turn), z = roll (lateral bend / arm raise).
IDLE_TERMS = (
    ("spine1", 0, 0.012, 1, 0.0),  # breathing
    ("spine2", 0, 0.010, 1, 0.0),
    ("spine3", 0, 0.008, 1, 0.0),
    ("spine1", 2, 0.015, 1, 0.25),  # weight-shift sway
    ("spine3", 2, -0.010, 1, 0.25),
    ("neck", 1, 0.05, 1, 0.5),  # slow look around
    ("head", 1, 0.04, 1, 0.5),
    ("head", 0, 0.02, 2, 0.1),
    ("left_shoulder", 2, 0.035, 1, 0.0),  # arms breathe with the chest
    ("right_shoulder", 2, -0.035, 1, 0.0),
    ("left_elbow", 1, 0.04, 1, 0.3),
    ("right_elbow", 1, -0.04, 1, 0.3),
)
TALK_EXTRA = (
    ("neck", 0, 0.03, 4, 0.0),  # emphatic nods
    ("head", 0, 0.035, 6, 0.2),
    ("head", 2, 0.02, 3, 0.4),
    ("right_elbow", 1, -0.12, 2, 0.1),  # a little gesturing
    ("right_shoulder", 0, -0.08, 2, 0.1),
)
JAW_OPEN_MAX = 0.22  # radians about SMPL-X jaw x (positive opens)
JAW_SYLLABLES = 8  # syllable peaks per talk loop


def rotvec_to_matrix(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, dtype=np.float64)
    theta = np.linalg.norm(v)
    if theta < 1e-12:
        return np.eye(3)
    k = v / theta
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(theta) * K + (1 - np.cos(theta)) * (K @ K)


def matrix_to_quat(m: np.ndarray) -> np.ndarray:
    """(w, x, y, z) from a rotation matrix (Shepperd; matches pytorch3d.matrix_to_quaternion)."""
    m = np.asarray(m, dtype=np.float64)
    t = np.trace(m)
    if t > 0:
        s = np.sqrt(t + 1) * 2
        q = [s / 4, (m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s]
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        q = [(m[2, 1] - m[1, 2]) / s, s / 4, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s]
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        q = [(m[0, 2] - m[2, 0]) / s, (m[0, 1] + m[1, 0]) / s, s / 4, (m[1, 2] + m[2, 1]) / s]
    else:
        s = np.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
        q = [(m[1, 0] - m[0, 1]) / s, (m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, s / 4]
    q = np.array(q)
    return q / np.linalg.norm(q)


def matrix_to_rotvec(R: np.ndarray) -> np.ndarray:
    q = matrix_to_quat(R)
    if q[0] < 0:
        q = -q
    n = np.linalg.norm(q[1:])
    if n < 1e-12:
        return 2 * q[1:]  # small-angle limit
    return q[1:] / n * (2 * np.arctan2(n, q[0]))


def compose(delta: np.ndarray, base: np.ndarray) -> np.ndarray:
    """delta applied in the parent frame after the base joint rotation (both rotvecs)."""
    return matrix_to_rotvec(rotvec_to_matrix(delta) @ rotvec_to_matrix(base))


def deltas(frame: int, count: int, talk: bool = False) -> tuple[np.ndarray, float]:
    """(21, 3) body rotvec offsets and the jaw opening (rad) for one frame of the loop."""
    if count <= 0 or not 0 <= frame < count:
        raise ValueError("frame outside loop")
    u = frame / count
    out = np.zeros((21, 3))
    for name, axis, amp, cycles, phase in IDLE_TERMS + (TALK_EXTRA if talk else ()):
        # phase shifts use sin(2pi(k u + p)) - sin(2pi p) so frame 0 stays exactly the source pose
        out[JOINTS[name] - 1, axis] += amp * (
            np.sin(2 * np.pi * (cycles * u + phase)) - np.sin(2 * np.pi * phase)
        )
    jaw = 0.0
    if talk:
        # half-rectified syllables with uneven heights; zero at frame 0 and at the loop seam
        s = np.sin(np.pi * JAW_SYLLABLES * u) ** 2
        envelope = 0.65 + 0.35 * np.sin(2 * np.pi * 3 * u) ** 2
        jaw = float(JAW_OPEN_MAX * s * envelope)
    return out, jaw


def frame_pose(
    base_body: np.ndarray, base_jaw: np.ndarray, frame: int, count: int, talk: bool = False
) -> tuple[np.ndarray, np.ndarray]:
    """Body pose (21, 3) and jaw pose (3,) rotvecs for one loop frame."""
    base_body = np.asarray(base_body, dtype=np.float64).reshape(21, 3)
    base_jaw = np.asarray(base_jaw, dtype=np.float64).reshape(3)
    d, jaw = deltas(frame, count, talk)
    body = base_body.copy()
    for j in range(21):
        if np.any(d[j]):
            body[j] = compose(d[j], base_body[j])
    jaw_pose = compose(np.array([jaw, 0.0, 0.0]), base_jaw) if jaw else base_jaw.copy()
    return body, jaw_pose


def loop(base_body, base_jaw, count: int, talk: bool = False):
    return [frame_pose(base_body, base_jaw, i, count, talk) for i in range(count)]
