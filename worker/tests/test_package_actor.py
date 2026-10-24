import hashlib
import json

import numpy as np
import pytest

from lhm_stages import package_actor as pa

PROPS = [
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
]  # fmt: skip


def synthetic_person(n=4000, seed=0, sway=0.0):
    """A 1.7 m 'person' 3 m in front of an OpenCV camera, facing it.

    OpenCV: y down, so the head is at y=-1.0 and the feet at y=+0.7. A nose marker sits on the
    camera side of the head (smaller z); the person's LEFT hand is on the image right (+x).
    """
    rng = np.random.default_rng(seed)
    d = np.zeros((n, len(PROPS)), np.float32)
    col = lambda name: PROPS.index(name)  # noqa: E731
    y = rng.uniform(-1.0, 0.7, n)
    x = rng.normal(0, 0.12, n) + 0.4
    z = rng.normal(0, 0.08, n) + 3.0
    x[:200] = 0.4 + 0.7  # left hand cluster at +x (image right)
    y[:200] = 0.0
    x[200:300] = 0.4  # nose: toward the camera
    y[200:300] = -0.85
    z[200:300] = 3.0 - 0.15
    x[300:] += sway * np.sin(y[300:])
    d[:, col("x")], d[:, col("y")], d[:, col("z")] = x, y, z
    d[:, col("opacity")] = 4.0  # sigmoid ~ 0.98
    d[-20:, col("opacity")] = -6.0  # faint outliers far above the head must not set height
    d[-20:, col("y")] = -2.5
    d[:, col("scale_0") : col("scale_2") + 1] = np.log(0.01)
    d[:, col("f_dc_0") : col("f_dc_2") + 1] = rng.normal(size=(n, 3))
    d[:, col("rot_0")] = 1.0  # identity (w,x,y,z)
    return d


@pytest.fixture
def raw(tmp_path):
    raw = tmp_path / "raw"
    raw.mkdir()
    paths = []
    for i in range(6):
        p = raw / f"frame_{i:03d}.ply"
        pa.write_ply(p, PROPS, synthetic_person(sway=0.02 * np.sin(i)))
        paths.append(p)
    pa.write_ply(raw / "frozen.ply", PROPS, synthetic_person())
    return paths


def test_ply_roundtrip(tmp_path):
    d = synthetic_person(100)
    pa.write_ply(tmp_path / "a.ply", PROPS, d)
    props, back = pa.read_ply(tmp_path / "a.ply")
    assert props == PROPS and np.array_equal(back, d)


def test_rejects_non_gaussian_and_truncated_ply(tmp_path):
    pa.write_ply(tmp_path / "pts.ply", ["x", "y", "z"], np.zeros((3, 3), np.float32))
    with pytest.raises(ValueError, match="not a gaussian PLY"):
        pa.read_ply(tmp_path / "pts.ply")
    pa.write_ply(tmp_path / "ok.ply", PROPS, synthetic_person(10))
    (tmp_path / "cut.ply").write_bytes((tmp_path / "ok.ply").read_bytes()[:-4])
    with pytest.raises(ValueError, match="body bytes"):
        pa.read_ply(tmp_path / "cut.ply")


def test_packaged_frame_is_upright_grounded_centred_and_faces_minus_z(tmp_path, raw):
    seq = pa.package(raw, tmp_path / "sequence", fps=12, loops={"idle": (0, 4), "talk": (4, 2)})
    props, f0 = pa.read_ply(tmp_path / "sequence/frame_000.ply")
    xyz = f0[:, :3].astype(np.float64)
    body = xyz[:-20]
    # feet on the floor, head up, 1.7 m tall from opaque splats only
    assert abs(np.percentile(body[:, 1], 0.5)) < 0.02
    assert 1.6 < seq["nativeHeight"] < 1.75
    assert body[:, 1].max() > 1.6
    # centred on the opaque median
    assert abs(np.median(body[:, 0])) < 0.02 and abs(np.median(body[:, 2])) < 0.02
    # the nose (camera side of the head) is now on the -Z side: the avatar faces -Z
    nose = xyz[200:300]
    head = body[(body[:, 1] > 1.4)]
    assert nose[:, 2].mean() < head[:, 2].mean() - 0.1
    # the person's left hand is on -X (facing -Z, +X is the avatar's right): a rotation, no mirror
    assert xyz[:200, 0].mean() < -0.5
    # quaternions rotated by pi about z: identity -> (w,x,y,z) = (0,0,0,1)
    q = f0[:, props.index("rot_0") : props.index("rot_0") + 4]
    assert np.allclose(np.abs(q[:, 3]), 1) and np.allclose(q[:, :3], 0, atol=1e-6)


def test_sequence_json_contract(tmp_path, raw):
    out = tmp_path / "sequence"
    seq = pa.package(
        raw, out, fps=12, loops={"idle": (0, 4), "talk": (4, 2)},
        frozen=raw[0].parent / "frozen.ply", frozen_out=tmp_path / "frozen.ply",
    )  # fmt: skip
    on_disk = json.loads((out / "sequence.json").read_text())
    assert on_disk == json.loads(json.dumps(seq))
    assert seq["schema"] == "previz.actor-sequence/1"
    assert seq["frame_format"] == "gaussian-ply"
    assert seq["frames"] == [f"frame_{i:03d}.ply" for i in range(6)]
    assert seq["count"] == 6 and seq["fps"] == 12 and seq["duration"] == 0.5
    assert seq["timestamps"] == [i / 12 for i in range(6)]
    for name, digest in zip(seq["frames"], seq["frame_sha256"]):
        assert hashlib.sha256((out / name).read_bytes()).hexdigest() == digest
    assert seq["loops"] == {"idle": {"start": 0, "count": 4}, "talk": {"start": 4, "count": 2}}
    assert seq["avatarFrame"]["up"] == [0, 1, 0] and seq["avatarFrame"]["forward"] == [0, 0, -1]
    assert seq["gaussiansPerFrame"] == 4000
    assert (tmp_path / "frozen.ply").exists()


@pytest.mark.parametrize("quantize", [True, False])
def test_motion_track_matches_frames(tmp_path, raw, quantize):
    out = tmp_path / "sequence"
    seq = pa.package(raw, out, fps=12, loops={"idle": (0, 6)}, quantize=quantize)
    m = seq["motion"]
    assert m["schema"] == "previz.actor-motion/1"
    assert m["channels"] == ["x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3"]
    assert m["frames"] == 6 and m["splats"] == 4000 and m["frameFiles"] == seq["frames"]
    payload = (out / m["file"]).read_bytes()
    assert len(payload) == m["bytes"] == 6 * 4000 * 7 * (2 if quantize else 4)
    assert hashlib.sha256(payload).hexdigest() == m["sha256"]
    assert m["base"]["sha256"] == seq["frame_sha256"][0]
    if quantize:
        codes = np.frombuffer(payload, "<u2").reshape(6, 4000, 7).astype(np.float64)
        values = (codes * np.array(m["scale"]) + np.array(m["min"])).astype(np.float32)
    else:
        values = np.frombuffer(payload, "<f4").reshape(6, 4000, 7)
    cols = [PROPS.index(c) for c in pa.CHANNELS]
    for i, name in enumerate(seq["frames"]):
        _, f = pa.read_ply(out / name)
        err = np.abs(values[i] - f[:, cols]).max(0)
        assert np.all(err <= np.array(m["maxAbsError"]) + 1e-7)
    assert max(m["maxAbsError"]) < (1e-4 if quantize else 1e-12)


def test_motion_track_refused_when_appearance_changes(tmp_path, raw):
    props, d = pa.read_ply(raw[3])
    d[:, props.index("f_dc_0")] += 0.1
    pa.write_ply(raw[3], props, d)
    seq = pa.package(raw, tmp_path / "s", fps=12, loops={"idle": (0, 6)})
    assert seq["motion"] is None and "static attributes" in seq["motionSkipped"]


def test_loops_must_partition_frames_and_layouts_must_match(tmp_path, raw):
    with pytest.raises(ValueError, match="partition"):
        pa.package(raw, tmp_path / "s", fps=12, loops={"idle": (0, 5)})
    pa.write_ply(raw[2], PROPS, synthetic_person(n=3000))
    with pytest.raises(ValueError, match="splat count"):
        pa.package(raw, tmp_path / "t", fps=12, loops={"idle": (0, 6)})
