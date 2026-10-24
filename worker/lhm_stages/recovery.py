"""Durable generated actor outputs and read-only, inference-free recovery.

Trimmed port of OrbisEngine ``worker/stages/lhm_recovery.py``: the GPU function writes every
output under ``/cache/recovery/<id>/output`` and a finalized ``manifest.json`` (sizes + SHA-256)
before it returns a small receipt; the caller then downloads from the Volume and verifies each
file. A local ``recovery-receipt.json`` is written *before* submission so an interrupted call is
recovered (``run_actor.py --recover``) instead of being paid for twice.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

VOLUME_NAME = "previz-stage-lhm-cache"
SCHEMA = "previz.lhm-recovery/1"
RECEIPT_NAME = "recovery-receipt.json"
MODES = ("actor",)
FORBIDDEN_OUTPUTS = {"reference.png", RECEIPT_NAME, "recovery-manifest.json"}
REQUIRED_OUTPUTS = (
    "modal-run.json",
    "inference.log",
    "result.json",
    "frozen.ply",
    "sequence/sequence.json",
)


def atomic_json(path, value):
    path = Path(path)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    with temporary.open("x") as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def file_hash(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def remote_root(recovery_id):
    if not isinstance(recovery_id, str) or not re.fullmatch(r"[0-9a-f]{32}", recovery_id):
        raise ValueError("Recovery id must be a lowercase UUID hex string")
    return f"recovery/{recovery_id}"


def safe_relative(value):
    if (
        not isinstance(value, str)
        or not value
        or not re.fullmatch(r"[A-Za-z0-9_.\-/]+", value)
        or value.startswith("/")
        or any(part in ("", ".", "..") for part in value.split("/"))
        or PurePosixPath(value).name in FORBIDDEN_OUTPUTS
    ):
        raise ValueError(f"Unsafe or original-input output path: {value!r}")
    return value


def new_receipt(destination, mode="actor", exist_ok=False):
    if mode not in MODES:
        raise ValueError("Invalid recovery mode")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=exist_ok)
    path = destination / RECEIPT_NAME
    if path.exists():
        raise ValueError(f"{path} exists; recover it instead of submitting again")
    recovery_id = uuid.uuid4().hex
    receipt = {
        "schema": SCHEMA,
        "recoveryId": recovery_id,
        "volume": VOLUME_NAME,
        "remotePath": remote_root(recovery_id),
        "destination": str(destination.resolve()),
        "mode": mode,
        "status": "prepared",
        "functionCallId": None,
        "createdAtEpoch": time.time(),
    }
    atomic_json(path, receipt)
    return path, receipt


def load_receipt(path):
    try:
        receipt = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise ValueError("Recovery receipt is missing or unreadable") from None
    if (
        not isinstance(receipt, dict)
        or receipt.get("schema") != SCHEMA
        or receipt.get("volume") != VOLUME_NAME
        or receipt.get("remotePath") != remote_root(receipt.get("recoveryId"))
        or receipt.get("mode") not in MODES
        or not isinstance(receipt.get("destination"), str)
        or not Path(receipt["destination"]).is_absolute()
    ):
        raise ValueError("Invalid recovery receipt")
    return receipt


@contextmanager
def receipt_lock(receipt_path):
    """One local owner per receipt, including while a provider outcome is unknown."""
    receipt_path = Path(receipt_path)
    if receipt_path.is_symlink():
        raise ValueError("Recovery receipt must not be a symlink")
    lock_path = receipt_path.with_name(receipt_path.name + ".lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Receipt is busy; another caller owns submission or recovery") from None
        yield


def submit_once(function, receipt_path, inputs, **kwargs):
    """Persist identity before waiting. An uncertain or interrupted receipt never resubmits."""
    with receipt_lock(receipt_path):
        receipt = load_receipt(receipt_path)
        if receipt.get("status") != "prepared" or receipt.get("functionCallId") is not None:
            raise ValueError("Existing receipt cannot resubmit inference; use --recover")
        receipt["status"] = "submitting"
        atomic_json(receipt_path, receipt)
        try:
            call = function.spawn(inputs, recovery_id=receipt["recoveryId"], **kwargs)
        except BaseException:
            receipt["status"] = "submission_uncertain"
            atomic_json(receipt_path, receipt)
            raise
        receipt["functionCallId"] = call.object_id
        receipt["status"] = "waiting"
        receipt["submittedAtEpoch"] = time.time()
        atomic_json(receipt_path, receipt)
        try:
            result = call.get()
        except BaseException:
            receipt["status"] = "wait_interrupted"
            atomic_json(receipt_path, receipt)
            raise
        check_result(result, receipt)
        receipt["totalWorkerSeconds"] = result.get("totalWorkerSeconds")
        receipt["manifestSha256"] = result["manifestSha256"]
        receipt["report"] = result.get("report")
        receipt["status"] = "checkpoint_available"
        atomic_json(receipt_path, receipt)
        return result


def check_result(result, receipt):
    if (
        not isinstance(result, dict)
        or result.get("recoveryId") != receipt["recoveryId"]
        or result.get("remotePath") != receipt["remotePath"]
        or not re.fullmatch(r"[0-9a-f]{64}", str(result.get("manifestSha256", "")))
    ):
        raise ValueError("Worker returned an invalid checkpoint receipt; use --recover")


def start_checkpoint(cache_root, recovery_id, mode):
    cache_root = Path(cache_root).resolve()
    directory = cache_root / remote_root(recovery_id)
    directory.mkdir(parents=True, exist_ok=False)
    output = directory / "output"
    output.mkdir()
    atomic_json(
        directory / "manifest.json",
        {
            "schema": SCHEMA,
            "recoveryId": recovery_id,
            "mode": mode,
            "status": "running",
            "finalized": False,
            "files": {},
        },
    )
    return directory, output


def output_problems(output, files):
    """Check the export contract independently of the subprocess exit code."""
    output = Path(output)
    problems = []
    for name in REQUIRED_OUTPUTS:
        if name not in files or files[name]["bytes"] == 0:
            problems.append(f"missing or empty required output: {name}")
    if "modal-run.json" in files:
        try:
            if json.loads((output / "modal-run.json").read_text()).get("error"):
                problems.append("worker report contains an inference error")
        except (OSError, ValueError, AttributeError):
            problems.append("malformed required metadata: modal-run.json")
    if "sequence/sequence.json" in files:
        try:
            sequence = json.loads((output / "sequence/sequence.json").read_text())
            frames, hashes = sequence["frames"], sequence["frame_sha256"]
            if (
                not isinstance(frames, list)
                or not frames
                or sequence.get("count") != len(frames)
                or len(hashes) != len(frames)
                or len(set(frames)) != len(frames)
            ):
                raise ValueError("inconsistent frame coverage")
            for name, digest in zip(frames, hashes):
                key = "sequence/" + safe_relative(name)
                if not name.endswith(".ply") or key not in files or files[key]["sha256"] != digest:
                    problems.append(f"sequence frame missing or hash mismatch: {name}")
            motion = sequence.get("motion")
            if motion:
                key = "sequence/" + safe_relative(motion["file"])
                if key not in files or files[key]["sha256"] != motion["sha256"]:
                    problems.append("motion track missing or hash mismatch")
        except (OSError, ValueError, KeyError, TypeError):
            problems.append("sequence metadata is missing, malformed or inconsistent")
    return problems


def finish_checkpoint(directory, *, mode, error=None):
    directory = Path(directory)
    output = directory / "output"
    files = {}
    for path in sorted(output.rglob("*")):
        if path.is_symlink():
            raise ValueError("Generated output symlinks cannot be checkpointed")
        if not path.is_file():
            continue
        name = safe_relative(path.relative_to(output).as_posix())
        files[name] = {"bytes": path.stat().st_size, "sha256": file_hash(path)}
    problems = output_problems(output, files)
    manifest = {
        "schema": SCHEMA,
        "recoveryId": directory.name,
        "mode": mode,
        "status": "failed" if error else "partial" if problems else "complete",
        "finalized": True,
        "files": files,
        "problems": problems,
        "inferenceError": bool(error),
        "finishedAtEpoch": time.time(),
    }
    atomic_json(directory / "manifest.json", manifest)
    return manifest


def validate_manifest(manifest, receipt):
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema") != SCHEMA
        or manifest.get("recoveryId") != receipt["recoveryId"]
        or manifest.get("mode") != receipt["mode"]
        or manifest.get("status") not in ("complete", "partial", "failed")
        or manifest.get("finalized") is not True
        or not isinstance(manifest.get("files"), dict)
        or not manifest["files"]
        or not isinstance(manifest.get("problems"), list)
        or type(manifest.get("inferenceError")) is not bool
        or (
            manifest.get("status") == "complete"
            and (manifest.get("problems") or manifest.get("inferenceError"))
        )
    ):
        raise ValueError("Checkpoint is missing, running or incomplete; do not resubmit inference")
    for name, item in manifest["files"].items():
        safe_relative(name)
        if (
            not isinstance(item, dict)
            or type(item.get("bytes")) is not int
            or item["bytes"] < 0
            or not re.fullmatch(r"[0-9a-f]{64}", str(item.get("sha256", "")))
        ):
            raise ValueError("Malformed output size or hash in recovery manifest")


def local_target(destination, relative):
    safe_relative(relative)
    destination = Path(destination)
    target = destination / relative
    current = destination
    for part in Path(relative).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Recovery output path must not contain symlinks")
    if not target.resolve().is_relative_to(destination.resolve()):
        raise ValueError("Recovery output escapes destination")
    return target


FRAME_PLY = re.compile(r"sequence/frame_\d+\.ply")
MOTION_TRACKS = ("sequence/motion.u16", "sequence/motion.f32")


def wanted(name, include_raw=False, all_frames=False, files=()):
    """What a caller downloads by default.

    raw/ (unpackaged LHM frames) and canonical-state.pt stay in the Volume unless asked for. When
    the checkpoint has a motion track, the browser needs only frame_000.ply (the appearance
    keyframe) plus the track, so the other packaged PLYs (~2.7 MB each, ~190 MB for 72 frames)
    stay remote too unless all_frames; they remain listed and hash-pinned in sequence.json.
    """
    if not include_raw and (name.startswith("raw/") or name == "canonical-state.pt"):
        return False
    if all_frames or not FRAME_PLY.fullmatch(name) or name == "sequence/frame_000.ply":
        return True
    return not any(track in files for track in MOTION_TRACKS)


def recover_outputs(receipt_path, volume, destination=None, include_raw=False, all_frames=False):
    """Download verified output files only; no FunctionCall or inference API is used."""
    with receipt_lock(receipt_path):
        receipt_path = Path(receipt_path)
        receipt = load_receipt(receipt_path)
        data = bytearray()
        try:
            for chunk in volume.read_file(receipt["remotePath"] + "/manifest.json"):
                data.extend(chunk)
                if len(data) > 8 * 1024 * 1024:
                    raise ValueError("Recovery manifest exceeds 8 MiB")
        except Exception as error:
            raise ValueError(
                "Checkpoint manifest unavailable; keep the receipt and do not resubmit"
            ) from error
        digest = hashlib.sha256(data).hexdigest()
        if receipt.get("manifestSha256") and receipt["manifestSha256"] != digest:
            raise ValueError("Recovery manifest differs from completed call receipt")
        manifest = json.loads(data)
        validate_manifest(manifest, receipt)
        destination = Path(destination or receipt["destination"])
        destination.mkdir(parents=True, exist_ok=True)
        for name, item in manifest["files"].items():
            if not wanted(name, include_raw, all_frames, manifest["files"]):
                continue
            target = local_target(destination, name)
            if target.exists():
                if target.stat().st_size != item["bytes"] or file_hash(target) != item["sha256"]:
                    raise ValueError(f"Existing output conflicts with recovery manifest: {name}")
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = target.with_name(target.name + f".{uuid.uuid4().hex}.part")
            try:
                received, computed = 0, hashlib.sha256()
                with temporary.open("xb") as stream:
                    for chunk in volume.read_file(receipt["remotePath"] + "/output/" + name):
                        received += len(chunk)
                        if received > item["bytes"]:
                            raise ValueError(f"Recovery output exceeds manifest size: {name}")
                        computed.update(chunk)
                        stream.write(chunk)
                    stream.flush()
                    os.fsync(stream.fileno())
                if received != item["bytes"] or computed.hexdigest() != item["sha256"]:
                    raise ValueError(f"Recovery output size/hash mismatch: {name}")
                os.link(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
        snapshot = destination / "recovery-manifest.json"
        if not snapshot.exists():
            snapshot.write_bytes(bytes(data))
        receipt.update(
            status="recovered",
            resultStatus=manifest["status"],
            manifestSha256=digest,
            recoveredDestination=str(destination.resolve()),
            recoveredAtEpoch=time.time(),
        )
        atomic_json(receipt_path, receipt)
        return manifest
