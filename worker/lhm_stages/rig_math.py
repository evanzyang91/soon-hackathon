"""SMPL-X rig math in numpy: forward kinematics, LBS, Spark-style dual-quaternion skinning.

Shared by ``rig_export.py`` (validates the exported runtime rig against LHM's own
``animation_infer_gs``) and ``motion_library.py`` (grounding / foot metrics of motion clips).
The browser mirrors ``rigid_transforms`` + ``dq_from_rigid`` in web/src/viewer/actors/rig.ts and
Spark evaluates ``dq_skin`` on the GPU (``SplatSkinning`` dual-quaternion mode).

Quaternions here are (w, x, y, z) unless a name says ``xyzw``.
"""

from __future__ import annotations

import numpy as np

SMPLX_JOINTS = (
    "pelvis", "left_hip", "right_hip", "spine1", "left_knee", "right_knee", "spine2",
    "left_ankle", "right_ankle", "spine3", "left_foot", "right_foot", "neck", "left_collar",
    "right_collar", "head", "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "jaw", "left_eye", "right_eye",
    *(f"left_{f}{i}" for f in ("index", "middle", "pinky", "ring", "thumb") for i in (1, 2, 3)),
    *(f"right_{f}{i}" for f in ("index", "middle", "pinky", "ring", "thumb") for i in (1, 2, 3)),
)  # fmt: skip
assert len(SMPLX_JOINTS) == 55
JAW, LEFT_EYE, RIGHT_EYE = 22, 23, 24
LHAND = slice(25, 40)
RHAND = slice(40, 55)
FOOT_JOINTS = (7, 8, 10, 11)  # ankles, feet (toe bases)


def rotvec_to_matrix(v: np.ndarray) -> np.ndarray:
    """(..., 3) axis-angle -> (..., 3, 3)."""
    v = np.asarray(v, dtype=np.float64)
    theta = np.linalg.norm(v, axis=-1, keepdims=True)
    k = v / np.where(theta < 1e-12, 1.0, theta)
    x, y, z = k[..., 0], k[..., 1], k[..., 2]
    zero = np.zeros_like(x)
    K = np.stack([zero, -z, y, z, zero, -x, -y, x, zero], -1).reshape(*v.shape[:-1], 3, 3)
    s = np.sin(theta)[..., None]
    c = np.cos(theta)[..., None]
    eye = np.broadcast_to(np.eye(3), K.shape)
    return eye + s * K + (1 - c) * (K @ K)


def matrix_to_quat(m: np.ndarray) -> np.ndarray:
    """(..., 3, 3) -> (..., 4) (w, x, y, z), w >= 0. Robust for slightly non-orthonormal input."""
    m = np.asarray(m, dtype=np.float64)
    shape = m.shape[:-2]
    m = m.reshape(-1, 3, 3)
    m00, m11, m22 = m[:, 0, 0], m[:, 1, 1], m[:, 2, 2]
    # Shepperd: build from the largest of 4w^2, 4x^2, 4y^2, 4z^2 (stable at 180 degrees too)
    d = np.stack([1 + m00 + m11 + m22, 1 + m00 - m11 - m22, 1 - m00 + m11 - m22, 1 - m00 - m11 + m22], 1)
    best = np.argmax(d, 1)
    s = np.sqrt(np.maximum(d[np.arange(len(m)), best], 1e-12)) * 2  # = 4 * |component|
    a, b, c = m[:, 2, 1] - m[:, 1, 2], m[:, 0, 2] - m[:, 2, 0], m[:, 1, 0] - m[:, 0, 1]
    e, f, g = m[:, 0, 1] + m[:, 1, 0], m[:, 0, 2] + m[:, 2, 0], m[:, 1, 2] + m[:, 2, 1]
    q = np.empty((len(m), 4))
    cases = (
        (s / 4, a / s, b / s, c / s),
        (a / s, s / 4, e / s, f / s),
        (b / s, e / s, s / 4, g / s),
        (c / s, f / s, g / s, s / 4),
    )
    for k, comps in enumerate(cases):
        rows = best == k
        q[rows] = np.stack([x[rows] for x in comps], 1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q *= np.where(q[:, :1] < 0, -1.0, 1.0)
    return q.reshape(*shape, 4)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    q = np.asarray(q, dtype=np.float64)
    q = q / np.linalg.norm(q, axis=-1, keepdims=True)
    w, x, y, z = q[..., 0], q[..., 1], q[..., 2], q[..., 3]
    return np.stack(
        [
            1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
            2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
            2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
        ],
        -1,
    ).reshape(*q.shape[:-1], 3, 3)  # fmt: skip


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Hamilton product, broadcasting (..., 4) (w, x, y, z)."""
    aw, ax, ay, az = np.moveaxis(np.asarray(a, dtype=np.float64), -1, 0)
    bw, bx, by, bz = np.moveaxis(np.asarray(b, dtype=np.float64), -1, 0)
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        -1,
    )


def quat_rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    return (quat_to_matrix(q) @ np.asarray(v, dtype=np.float64)[..., None])[..., 0]


def rigid_transforms(rotmats: np.ndarray, joints: np.ndarray, parents) -> tuple[np.ndarray, np.ndarray]:
    """SMPL ``batch_rigid_transform`` for one pose.

    rotmats (J, 3, 3) local joint rotations, joints (J, 3) rest joint positions (zero pose),
    parents (J,) with parents[0] < 0. Returns (A, posed_joints): A (J, 4, 4) maps a rest-pose
    point skinned 100% to joint j to its posed position; posed_joints (J, 3).
    """
    J = len(joints)
    joints = np.asarray(joints, dtype=np.float64)
    G = np.zeros((J, 4, 4))
    for j in range(J):
        local = np.eye(4)
        local[:3, :3] = rotmats[j]
        p = parents[j]
        local[:3, 3] = joints[j] - (joints[p] if p >= 0 else 0)
        G[j] = local if p < 0 else G[p] @ local
    posed = G[:, :3, 3].copy()
    A = G.copy()
    A[:, :3, 3] -= np.einsum("jab,jb->ja", G[:, :3, :3], joints)
    return A, posed


def lbs(x: np.ndarray, weights: np.ndarray, A: np.ndarray) -> np.ndarray:
    """Linear blend skinning: x (N, 3), weights (N, J), A (J, 4, 4) -> (N, 3)."""
    T = np.einsum("nj,jab->nab", weights, A)
    return np.einsum("nab,nb->na", T[:, :3, :3], x) + T[:, :3, 3]


def topk_weights(weights: np.ndarray, k: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Top-k bones per vertex with 8-bit weights summing to exactly 255 (Spark skin texture).

    Returns (bones uint8 (N, k), w8 uint8 (N, k)); unused slots have weight 0.
    """
    weights = np.asarray(weights, dtype=np.float64)
    idx = np.argsort(-weights, axis=1)[:, :k]
    w = np.take_along_axis(weights, idx, 1)
    w = np.maximum(w, 0)
    w = w / np.maximum(w.sum(1, keepdims=True), 1e-12)
    w8 = np.floor(w * 255).astype(np.int64)
    # largest-remainder rounding so every row sums to 255
    rem = w * 255 - w8
    short = 255 - w8.sum(1)
    order = np.argsort(-rem, axis=1)
    for r in range(k):
        add = short > r
        rows = np.nonzero(add)[0]
        w8[rows, order[rows, r]] += 1
    return idx.astype(np.uint8), w8.astype(np.uint8)


def spark_skin_words(bones: np.ndarray, w8: np.ndarray) -> np.ndarray:
    """(N, 4) uint16 words exactly as ``SplatSkinning.setSplatBones`` packs them."""
    return (w8.astype(np.uint16) + (bones.astype(np.uint16) << 8)).astype("<u2")


def dq_from_rigid(A: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(J, 4, 4) rigid -> real (J, 4) and dual (J, 4) quaternions (w, x, y, z), dual = t*q/2."""
    qr = matrix_to_quat(A[:, :3, :3])
    t = np.concatenate([np.zeros((len(A), 1)), A[:, :3, 3]], 1)
    qd = 0.5 * quat_mul(t, qr)
    return qr, qd


def dq_skin(x, rot, bones, w8, qr, qd):
    """Mirror of Spark's ``applyGsplatSkinning``: returns posed centres (N, 3) and rotations (N, 4).

    rot (N, 4) (w, x, y, z). Weights are w8 / 255 and blending flips each next bone into the
    hemisphere of the running sum, then normalises (exactly the shader's order).
    """
    n = len(x)
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
    accr /= norm
    accd /= norm
    conj = accr * np.array([1, -1, -1, -1])
    t = 2 * quat_mul(accd, conj)[:, 1:]
    return quat_rotate(accr, x) + t, quat_mul(accr, rot)


def pose_rotmats(root, body, jaw=None, lhand=None, rhand=None, eyes=None) -> np.ndarray:
    """55 local rotation matrices from SMPL-X axis-angle groups (missing groups = zero)."""
    rv = np.zeros((55, 3))
    rv[0] = root
    rv[1:22] = np.asarray(body).reshape(21, 3)
    if jaw is not None:
        rv[JAW] = jaw
    if eyes is not None:
        rv[LEFT_EYE], rv[RIGHT_EYE] = eyes
    if lhand is not None:
        rv[LHAND] = np.asarray(lhand).reshape(15, 3)
    if rhand is not None:
        rv[RHAND] = np.asarray(rhand).reshape(15, 3)
    return rotvec_to_matrix(rv)


def angle_deg(qa: np.ndarray, qb: np.ndarray) -> np.ndarray:
    """Rotation angle between unit quaternions (degrees), sign-agnostic."""
    qa = qa / np.linalg.norm(qa, axis=-1, keepdims=True)
    qb = qb / np.linalg.norm(qb, axis=-1, keepdims=True)
    d = np.clip(np.abs(np.einsum("...a,...a->...", qa, qb)), 0, 1)
    return np.degrees(2 * np.arccos(d))
