import json

import pytest

from lhm_stages import package_actor as pa
from lhm_stages import recovery as rc
from test_package_actor import PROPS, synthetic_person


class FakeCall:
    def __init__(self, fn, inputs, kwargs):
        self.object_id = "fc-test"
        self.fn, self.inputs, self.kwargs = fn, inputs, kwargs

    def get(self):
        return self.fn.run(self.inputs, **self.kwargs)


class FakeFunction:
    """Stands in for modal_lhm.actor: writes a real checkpoint into a local 'volume'."""

    def __init__(self, volume_root, broken=False):
        self.root, self.broken, self.spawned = volume_root, broken, 0

    def spawn(self, inputs, **kwargs):
        self.spawned += 1
        return FakeCall(self, inputs, kwargs)

    def run(self, inputs, recovery_id, **kwargs):
        checkpoint, out = rc.start_checkpoint(self.root, recovery_id, "actor")
        raw = out / "raw"
        raw.mkdir()
        frames = []
        for i in range(3):
            p = raw / f"frame_{i:03d}.ply"
            pa.write_ply(p, PROPS, synthetic_person(500, sway=0.01 * i))
            frames.append(p)
        pa.write_ply(raw / "frozen.ply", PROPS, synthetic_person(500))
        pa.package(frames, out / "sequence", fps=12, loops={"idle": (0, 3)},
                   frozen=raw / "frozen.ply", frozen_out=out / "frozen.ply")  # fmt: skip
        (out / "result.json").write_text("{}")
        (out / "inference.log").write_text("ok\n")
        rc.atomic_json(out / "modal-run.json", {"error": "boom" if self.broken else None})
        manifest = rc.finish_checkpoint(checkpoint, mode="actor", error="boom" if self.broken else None)
        return {
            "recoveryId": recovery_id,
            "remotePath": rc.remote_root(recovery_id),
            "manifestSha256": rc.file_hash(checkpoint / "manifest.json"),
            "status": manifest["status"],
            "report": {"seconds": 1.0},
        }


class FakeVolume:
    def __init__(self, root):
        self.root = root

    def read_file(self, path):
        data = (self.root / path).read_bytes()
        for i in range(0, len(data), 4096):
            yield data[i : i + 4096]


def test_submit_then_recover_downloads_verified_outputs(tmp_path):
    vol = tmp_path / "volume"
    vol.mkdir()
    dest = tmp_path / "actor"
    receipt_path, receipt = rc.new_receipt(dest, "actor")
    assert json.loads(receipt_path.read_text())["status"] == "prepared"
    fn = FakeFunction(vol)
    result = rc.submit_once(fn, receipt_path, {"reference.png": b"x"}, frames=3)
    assert result["status"] == "complete"
    saved = json.loads(receipt_path.read_text())
    assert saved["status"] == "checkpoint_available" and saved["functionCallId"] == "fc-test"
    manifest = rc.recover_outputs(receipt_path, FakeVolume(vol))
    assert manifest["status"] == "complete" and manifest["problems"] == []
    assert (dest / "sequence/sequence.json").exists() and (dest / "frozen.ply").exists()
    assert not (dest / "raw").exists()  # raw frames stay in the volume unless asked for
    assert json.loads(receipt_path.read_text())["status"] == "recovered"
    # recovering again is idempotent; resubmitting is refused
    rc.recover_outputs(receipt_path, FakeVolume(vol))
    with pytest.raises(ValueError, match="cannot resubmit"):
        rc.submit_once(fn, receipt_path, {"reference.png": b"x"})
    assert fn.spawned == 1


def test_include_raw_downloads_repackageable_frames(tmp_path):
    vol = tmp_path / "volume"
    vol.mkdir()
    receipt_path, _ = rc.new_receipt(tmp_path / "a", "actor")
    rc.submit_once(FakeFunction(vol), receipt_path, {})
    rc.recover_outputs(receipt_path, FakeVolume(vol), include_raw=True)
    assert (tmp_path / "a/raw/frame_002.ply").exists()


def test_failed_inference_is_recorded_not_certified(tmp_path):
    vol = tmp_path / "volume"
    vol.mkdir()
    receipt_path, _ = rc.new_receipt(tmp_path / "a", "actor")
    result = rc.submit_once(FakeFunction(vol, broken=True), receipt_path, {})
    assert result["status"] == "failed"
    manifest = rc.recover_outputs(receipt_path, FakeVolume(vol))
    assert manifest["status"] == "failed" and manifest["inferenceError"] is True
    assert json.loads(receipt_path.read_text())["resultStatus"] == "failed"


def test_tampered_download_is_rejected(tmp_path):
    vol = tmp_path / "volume"
    vol.mkdir()
    receipt_path, receipt = rc.new_receipt(tmp_path / "a", "actor")
    rc.submit_once(FakeFunction(vol), receipt_path, {})
    frame = vol / receipt["remotePath"] / "output/sequence/frame_001.ply"
    data = bytearray(frame.read_bytes())
    data[-1] ^= 0xFF
    frame.write_bytes(bytes(data))
    with pytest.raises(ValueError, match="size/hash mismatch"):
        rc.recover_outputs(receipt_path, FakeVolume(vol))


def test_existing_receipt_blocks_a_second_submission(tmp_path):
    rc.new_receipt(tmp_path / "a", "actor")
    with pytest.raises(ValueError, match="exists"):
        rc.new_receipt(tmp_path / "a", "actor", exist_ok=True)


def test_unsafe_output_names_are_refused():
    for bad in ("../x", "/abs", "a//b", "reference.png", "x/recovery-receipt.json"):
        with pytest.raises(ValueError):
            rc.safe_relative(bad)
    assert rc.safe_relative("sequence/frame_000.ply") == "sequence/frame_000.ply"


def test_manifest_flags_missing_frames(tmp_path):
    vol = tmp_path / "v"
    vol.mkdir()
    checkpoint, out = rc.start_checkpoint(vol, "a" * 32, "actor")
    (out / "sequence").mkdir()
    (out / "sequence/sequence.json").write_text(
        json.dumps({"frames": ["frame_000.ply"], "count": 1, "frame_sha256": ["0" * 64]})
    )
    manifest = rc.finish_checkpoint(checkpoint, mode="actor")
    assert manifest["status"] == "partial"
    assert any("frame_000.ply" in p for p in manifest["problems"])
    assert any("frozen.ply" in p for p in manifest["problems"])
