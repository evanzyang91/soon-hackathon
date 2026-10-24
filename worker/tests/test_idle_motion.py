import numpy as np
import pytest

from lhm_stages import idle_motion as im


def test_rotvec_roundtrip_including_near_pi():
    rng = np.random.default_rng(0)
    for v in list(rng.normal(size=(50, 3))) + [np.array([np.pi, 0, 0]), np.array([0, 3.14159, 0])]:
        R = im.rotvec_to_matrix(v)
        back = im.rotvec_to_matrix(im.matrix_to_rotvec(R))
        assert np.allclose(R, back, atol=1e-9)


def test_frame_zero_is_exactly_the_source_pose():
    rng = np.random.default_rng(1)
    base = rng.normal(scale=0.3, size=(21, 3))
    jaw = np.array([0.05, 0.0, 0.0])
    for talk in (False, True):
        body, j = im.frame_pose(base, jaw, 0, 48, talk)
        assert np.allclose(body, base, atol=1e-12)
        assert np.allclose(j, jaw, atol=1e-12)


@pytest.mark.parametrize("talk", [False, True])
def test_loop_is_seamless_and_bounded(talk):
    base = np.zeros((21, 3))
    n = 48
    poses = [im.frame_pose(base, np.zeros(3), i, n, talk)[0] for i in range(n)]
    steps = [np.abs(poses[i + 1] - poses[i]).max() for i in range(n - 1)]
    seam = np.abs(poses[0] - poses[-1]).max()
    assert seam <= max(steps) * 1.05  # wrapping N-1 -> 0 is no bigger than any other step
    assert max(np.abs(p).max() for p in poses) < 0.3  # gentle


def test_legs_never_move_so_feet_stay_planted():
    base = np.random.default_rng(2).normal(scale=0.2, size=(21, 3))
    for i in range(24):
        body, _ = im.frame_pose(base, np.zeros(3), i, 24, True)
        for name in im.LEG_JOINTS:
            k = im.JOINTS[name] - 1
            assert np.array_equal(body[k], base[k])


def test_jaw_moves_only_when_talking():
    idle = [im.deltas(i, 24, False)[1] for i in range(24)]
    talk = [im.deltas(i, 24, True)[1] for i in range(24)]
    assert all(v == 0 for v in idle)
    assert max(talk) > 0.1 and min(talk) >= 0 and talk[0] == 0


def test_rejects_frames_outside_the_loop():
    with pytest.raises(ValueError):
        im.deltas(48, 48)
