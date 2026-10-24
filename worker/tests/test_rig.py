"""Runtime rig: numpy skinning math, rebinding at the source pose, rig files, motion clips."""

import json

import numpy as np
import pytest

import motion_library as ml
import rig_build as rb
import rig_math as rm

PARENTS = np.array([-1, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 9, 12, 13, 14, 16, 17, 18, 19, 15, 15, 15] + [20] * 15 + [21] * 15)


def skeleton():
    rest = np.zeros((55, 3))
    rest[:22] = np.array(
        [[0, 0.9, 0], [0.1, 0.8, 0], [-0.1, 0.8, 0], [0, 1.0, 0], [0.1, 0.45, 0], [-0.1, 0.45, 0], [0, 1.15, 0],
         [0.1, 0.08, 0], [-0.1, 0.08, 0], [0, 1.25, 0], [0.1, 0.03, 0.12], [-0.1, 0.03, 0.12], [0, 1.5, 0],
         [0.08, 1.42, 0], [-0.08, 1.42, 0], [0, 1.6, 0], [0.18, 1.42, 0], [-0.18, 1.42, 0], [0.45, 1.42, 0],
         [-0.45, 1.42, 0], [0.7, 1.42, 0], [-0.7, 1.42, 0]]
    )  # fmt: skip
    for j in range(22, 55):
        rest[j] = rest[PARENTS[j]]
    return rest


def test_quaternions_round_trip_including_half_turns():
    rng = np.random.default_rng(1)
    v = rng.normal(size=(500, 3))
    v = v / np.linalg.norm(v, axis=1, keepdims=True) * rng.uniform(0, np.pi, (500, 1))
    v[:10] = v[:10] / np.linalg.norm(v[:10], axis=1, keepdims=True) * np.pi  # exactly 180 degrees
    R = rm.rotvec_to_matrix(v)
    assert np.abs(rm.quat_to_matrix(rm.matrix_to_quat(R)) - R).max() < 1e-9


def test_dual_quaternion_skin_matches_lbs_for_rigid_splats():
    rng = np.random.default_rng(2)
    rest = skeleton()
    rot = rm.pose_rotmats(rng.normal(size=3), rng.normal(size=(21, 3)) * 0.4)
    A, posed = rm.rigid_transforms(rot, rest, PARENTS)
    # A maps every rest joint onto its posed position
    assert np.abs(np.einsum("jab,jb->ja", A[:, :3, :3], rest) + A[:, :3, 3] - posed).max() < 1e-12
    n = 500
    x = rng.normal(size=(n, 3))
    W = np.zeros((n, 55))
    W[np.arange(n), rng.integers(0, 55, n)] = 1
    bones, w8 = rm.topk_weights(W)
    assert (w8.astype(int).sum(1) == 255).all()
    qr, qd = rm.dq_from_rigid(A)
    q0 = rm.matrix_to_quat(rm.rotvec_to_matrix(rng.normal(size=(n, 3))))
    xd, _ = rm.dq_skin(x, q0, bones, w8, qr, qd)
    assert np.abs(xd - rm.lbs(x, W, A)).max() < 1e-9


def synthetic_canonical(n=600, seed=3):
    """A canonical state dict shaped like rig_export's canonical.npz (blended weights)."""
    rng = np.random.default_rng(seed)
    rest = skeleton()
    W = np.zeros((n, 55))
    a = rng.integers(0, 22, n)
    b = PARENTS[np.maximum(a, 1)]
    t = rng.uniform(0, 1, n)
    W[np.arange(n), a] = t
    W[np.arange(n), b] += 1 - t
    x = rest[a] * t[:, None] + rest[b] * (1 - t[:, None]) + rng.normal(0, 0.03, (n, 3))
    q = rm.matrix_to_quat(rm.rotvec_to_matrix(rng.normal(0, 0.5, (n, 3))))
    body = rng.normal(0, 0.15, (21, 3))
    return dict(
        x_zero=x,
        q_zero=q,
        q_neutral=q,
        r_null=np.broadcast_to(np.eye(3), (n, 3, 3)).copy(),
        weights=W,
        joints=rest,
        parents=PARENTS,
        constrain=np.zeros(n, bool),
        root=np.array([np.pi, 0, 0]),
        param_root_pose=np.zeros((1, 1, 3)),
        param_body_pose=body.reshape(1, 1, 21, 3),
        param_jaw_pose=np.zeros((1, 1, 3)),
        param_lhand_pose=np.zeros((1, 1, 15, 3)),
        param_rhand_pose=np.zeros((1, 1, 15, 3)),
        param_trans=np.array([0.0, 0.2, 3.0]).reshape(1, 1, 3),
    )


def test_rebind_reproduces_the_source_pose_exactly_and_writes_valid_files(tmp_path):
    c = synthetic_canonical()
    n = len(c["x_zero"])
    props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    static = np.zeros((n, len(props)), np.float32)
    static[:, props.index("opacity")] = 2.0
    static[:, props.index("scale_0") : props.index("scale_2") + 1] = np.log(0.01)
    rig = rb.build(c, props, static, tmp_path)
    v = rig["validation"]
    assert v["source"]["runtimeVsLhm"]["maxMm"] < 1e-3  # exact (float64) at the source pose
    assert v["tpose"]["runtimeVsLhm"]["meanMm"] < 50  # and still sane far from it
    blob = (tmp_path / "rig-splats.bin").read_bytes()
    assert len(blob) == n * 44 == rig["files"]["splats"]["bytes"]
    skin = np.frombuffer(blob, "<u2", offset=rig["files"]["splats"]["layout"]["skin"]["offset"], count=n * 4).reshape(n, 4)
    assert ((skin & 0xFF).sum(1) == 255).all()
    assert json.loads((tmp_path / "rig.json").read_text())["parents"][:3] == [-1, 0, 0]


def raw_clip(frames=240, fps=30, walk_speed=0.0, sway=0.05):
    """Synthetic generator output: a breathing / swaying body (or a walk) with a drifting heading."""
    rest = skeleton()[:22]
    t = np.arange(frames) / fps
    R = np.broadcast_to(np.eye(3), (frames, 22, 3, 3)).copy()
    yaw = 0.3 + 0.1 * t / t[-1]  # heading drift
    R[:, 0] = ml.rot_y(yaw)
    R[:, 3] = rm.rotvec_to_matrix(np.stack([sway * np.sin(2 * np.pi * 0.37 * t), 0 * t, 0 * t], -1))
    R[:, 16] = rm.rotvec_to_matrix(np.stack([0 * t, 0 * t, -1.2 + 0.2 * np.sin(2 * np.pi * 0.61 * t)], -1))
    K = np.stack([rm.rigid_transforms(R[f], rest, ml.SMPL_PARENTS)[1] for f in range(frames)])
    T = np.zeros((frames, 3))
    T[:, 1] = 0.0
    T[:, 0] = 0.02 * t  # slow drift to remove
    if walk_speed:
        T[:, 2] = walk_speed * t
    return R, T, K


def test_build_clip_makes_a_seamless_in_place_loop_facing_plus_z():
    R, T, K = raw_clip()
    c = ml.build_clip("idle", "standing", False, R, T, K)
    assert c["frames"] >= 120
    # the wrap (last -> first frame) is no bigger than an ordinary step
    assert c["seamJump"] <= 2.5 * c["medianStep"] + 1e-3
    # heading canonicalised to +Z (yaw ~0), drift removed, root in place
    yaw = ml.yaw_of(c["R"][:, 0])
    assert np.abs(yaw).max() < 0.08
    assert np.abs(c["root"][:, [0, 2]]).max() < 0.05


def test_planted_root_removes_foot_skate():
    rest = skeleton()[:22]
    frames, fps = 60, 30
    t = np.arange(frames) / fps
    R = np.broadcast_to(np.eye(3), (frames, 22, 3, 3)).copy()
    R[:, 3] = rm.rotvec_to_matrix(np.stack([0 * t, 0 * t, 0.15 * np.sin(2 * np.pi * t / 2)], -1))  # lean
    joints = np.stack([rm.rigid_transforms(R[f], rest, ml.SMPL_PARENTS)[1] for f in range(frames)])
    # the generator's legs slide (in place) while its root says "standing still": the planted root
    # must cancel the slide so the feet come out still in the world
    slide = np.stack([0.1 * np.sin(2 * np.pi * t / 2), 0 * t, 0 * t], -1)
    root, fwd, lateral = ml.planted_root(joints + slide[:, None], fps, np.zeros((frames, 2)))
    world = joints + slide[:, None]
    world[..., 0] += root[:, None, 0]
    world[..., 2] += root[:, None, 1]
    assert ml.foot_skate(world, fps) < 0.01
    assert abs(fwd) < 1e-6


def test_encode_round_trip(tmp_path):
    R, T, K = raw_clip(frames=150)
    c = ml.build_clip("idle", "standing", False, R, T, K)
    blob, meta = ml.encode([c])
    q = np.frombuffer(blob, "<i2", count=c["frames"] * 22 * 4).reshape(c["frames"], 22, 4) / 32767
    back = rm.quat_to_matrix(np.concatenate([q[..., 3:], q[..., :3]], -1))
    assert np.abs(back - c["R"]).max() < 1e-3
    assert meta[0]["frames"] == c["frames"] and meta[0]["offset"] == 0


def test_build_gesture_is_one_shot_in_place_facing_plus_z():
    R, T, K = raw_clip(frames=90)
    T[:, 2] += 0.3 * np.arange(90) / 90  # a step forward the actor must not keep
    c = ml.build_gesture("slam", "standing", R, T, K)
    assert c["frames"] == 90 - int(ml.GESTURE_TRIM_S * ml.FPS)
    assert np.abs(ml.yaw_of(c["R"][:, 0])).max() < 0.08  # facing +Z
    assert np.abs(c["root"][0, [0, 2]]).max() < 1e-9  # starts on the mark
    assert np.abs(c["root"][-1, [0, 2]]).max() < 1e-9  # and ends there
    assert c["speed"] == 0 and not c["speaking"]


def test_write_gesture_picks_the_steadier_seed_and_writes_a_one_clip_library(tmp_path):
    R, T, K = raw_clip(frames=90)
    jittery = R.copy()
    jittery[40, 16] = rm.rotvec_to_matrix(np.array([0.0, 0.0, 1.2]))  # a one-frame arm pop
    npz = dict(rotmats=np.stack([jittery, R]), transl=np.stack([T, T]), keypoints=np.stack([K, K]), seeds=np.array([11, 23]))
    meta = ml.write_gesture(tmp_path, "g1", "A person slams both palms down.", "standing", npz)
    assert meta["seed"] == 23 and meta["oneShot"] and meta["offset"] == 0
    lib = json.loads((tmp_path / "g1.json").read_text())
    blob = (tmp_path / "g1.bin").read_bytes()
    assert lib["schema"] == ml.SCHEMA and lib["file"] == "g1.bin" and lib["bytes"] == len(blob)
    assert lib["clips"][0]["prompt"] == "A person slams both palms down."
    assert len(blob) >= meta["frames"] * (22 * 8 + 12)


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
