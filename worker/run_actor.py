#!/usr/bin/env python3
"""Reference image -> LHM actor on Modal -> verified local sequence/ + frozen.ply.

    python3 worker/run_actor.py --image ref.png --out DIR [--mask m.png] [--frames 48]
                                [--talk-frames 24] [--fps 12] [--lossless] [--include-raw]
                                [--all-frames] [--detail standard|high]
        --detail high: LHM-1B-HF + a bounded fine-tune against the reference (~5 min per actor)
    python3 worker/run_actor.py --check            # Modal auth + CUDA image build + imports, no GPU
    python3 worker/run_actor.py --stage            # one-time weight staging (CPU only, resumable)
    python3 worker/run_actor.py --stage-high       # + LHM-1B-HF (6.85 GB) for --detail high
    python3 worker/run_actor.py --recover DIR/recovery-receipt.json   # no inference
    python3 worker/run_actor.py --rig DIR [DIR ...]   # runtime rig for finished actors (no inference)

Auth: MODAL_TOKEN_ID / MODAL_TOKEN_SECRET from the environment, else from the repo's
.env.local / .env (values are never printed). Uses the deployed app ``previz-stage-lhm`` when
it exists (``modal deploy worker/modal_lhm.py``), otherwise runs it as a detached ephemeral app.
``--check`` runs in the CPU-only ``previz-stage-lhm-setup`` app, so it works on a workspace
without GPU access (Modal refuses to create any app holding an L4 function without billing).

The last stdout line is always ``RESULT {json}`` (``ok`` true/false) for server/pipeline/actors.ts.
Exit codes: 0 ok, 1 failure, 2 usage, 3 checkpoint still running (recover later).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from contextlib import contextmanager, nullcontext
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "lhm_stages"))

from lhm_stages import recovery  # noqa: E402

APP_NAME = "previz-stage-lhm"  # GPU app (modal_lhm.py)
SETUP_APP = "previz-stage-lhm-setup"  # CPU-only app (modal_lhm_stage.py): check + staging
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def result(ok: bool, code: int = 0, **fields) -> int:
    print("RESULT " + json.dumps({"ok": ok, **fields}), flush=True)
    return code


def load_modal_auth() -> bool:
    """Fill MODAL_TOKEN_* from .env.local/.env when the shell has none. Never prints values."""
    keys = ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET")
    for name in (".env.local", ".env"):
        if all(os.environ.get(k) for k in keys):
            break
        path = ROOT / name
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            key, sep, value = line.partition("=")
            key = key.strip()
            value = value.split(" #")[0].strip().strip("'\"")
            if sep and key in keys and value and not os.environ.get(key):
                os.environ[key] = value
    return all(os.environ.get(k) for k in keys) or bool(os.environ.get("MODAL_PROFILE")) or (
        Path.home() / ".modal.toml"
    ).is_file()


@contextmanager
def remote(name: str, app_name: str = APP_NAME, module: str = "modal_lhm"):
    """Yield a Modal Function: the deployed one if present, else a detached ephemeral app."""
    import importlib

    import modal

    try:
        deployed = modal.Function.from_name(app_name, name)
        deployed.hydrate()
    except modal.exception.NotFoundError:
        deployed = None
    if deployed is not None:
        print(f"using deployed {app_name}.{name}", flush=True)
        yield deployed
        return
    mod = importlib.import_module(module)
    print(f"{app_name} not deployed; running {name} in a detached ephemeral app", flush=True)
    with modal.enable_output() if os.environ.get("ACTOR_MODAL_OUTPUT") else nullcontext():
        with mod.app.run(detach=True):
            yield getattr(mod, name)


def validate_image(path: Path) -> None:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{path} is not a PNG")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"{path} exceeds {MAX_IMAGE_BYTES} bytes")
    width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    if height <= width:
        raise ValueError(f"{path} is {width}x{height}; a full-body portrait reference is required")


def summarize(dest: Path, manifest: dict) -> dict:
    seq_path = dest / "sequence" / "sequence.json"
    seq = json.loads(seq_path.read_text()) if seq_path.exists() else {}
    run = json.loads((dest / "modal-run.json").read_text()) if (dest / "modal-run.json").exists() else {}
    ft_path = dest / "finetune.json"
    ft = json.loads(ft_path.read_text()) if ft_path.exists() else None
    return {
        "status": manifest["status"],
        "problems": manifest["problems"],
        "sequenceDir": str(dest / "sequence"),
        "frozen": str(dest / "frozen.ply"),
        "fps": seq.get("fps"),
        "frames": seq.get("count"),
        "loops": seq.get("loops"),
        "nativeHeight": seq.get("nativeHeight"),
        "gaussiansPerFrame": seq.get("gaussiansPerFrame"),
        "workerSeconds": run.get("seconds"),
        "estimatedComputeUSD": run.get("estimatedComputeUSD"),
        "detail": run.get("detail", "standard"),
        "model": run.get("model"),
        "finetune": (
            {k: ft.get(k) for k in ("applied", "iterations", "loopSeconds", "sourceView", "turnViewMeanAbsChange", "reason", "error") if k in ft}
            if ft
            else None
        ),
    }


def network_error(error: BaseException) -> bool:
    """A dropped connection / DNS failure talking to Modal (aiohttp, grpc and socket errors are
    OSErrors), directly or as the cause of a recovery ValueError: worth recovering again later."""
    seen = 0
    while error is not None and seen < 5:
        if isinstance(error, (OSError, ConnectionError, TimeoutError)) or "DNS" in type(error).__name__:
            return True
        error, seen = error.__cause__ or error.__context__, seen + 1
    return False


def retry_later(error: BaseException, receipt: dict) -> int:
    """Exit 3: the checkpoint is (or will be) in the Volume; --recover again, never resubmit."""
    return result(False, 3, error=f"download interrupted, recover later: {type(error).__name__}: {error}"[:600], recoveryId=receipt["recoveryId"], network=True)


def recover(receipt_path: Path, include_raw: bool, all_frames: bool = False) -> int:
    import modal

    receipt = recovery.load_receipt(receipt_path)
    if not receipt.get("functionCallId"):
        return result(False, 1, error="receipt was never submitted to Modal; delete it to run again")
    volume = modal.Volume.from_name(recovery.VOLUME_NAME, create_if_missing=False)
    try:
        manifest = recovery.recover_outputs(
            receipt_path, volume, include_raw=include_raw, all_frames=all_frames
        )
    except Exception as error:  # noqa: BLE001 - classified below
        if network_error(error):
            return retry_later(error, receipt)
        if not isinstance(error, ValueError) or ("running or incomplete" not in str(error) and "unavailable" not in str(error)):
            raise
        try:  # is the remote call still going? (get with timeout=0 never blocks)
            modal.FunctionCall.from_id(receipt["functionCallId"]).get(timeout=0)
        except (TimeoutError, modal.exception.TimeoutError):
            return result(False, 3, error=str(error), recoveryId=receipt["recoveryId"], running=True)
        except Exception as call_error:  # noqa: BLE001 - the call itself failed or was cancelled
            if network_error(call_error):
                return retry_later(call_error, receipt)
            return result(False, 1, error=f"Modal call ended without a checkpoint: {call_error}"[:600])
        try:
            manifest = recovery.recover_outputs(
                receipt_path, volume, include_raw=include_raw, all_frames=all_frames
            )
        except Exception as again:  # noqa: BLE001
            if network_error(again):
                return retry_later(again, receipt)
            raise
    summary = summarize(Path(receipt["destination"]), manifest)
    ok = manifest["status"] == "complete"
    return result(ok, 0 if ok else 1, **summary)


MOTION_LIBRARY = HERE / "motion-library"  # built by worker/motion_library.py --build
MOTION_FILES = ("motion-library.json", "motion-clips.bin")


def install_rig(actor_dir: Path, files: dict, library: Path = MOTION_LIBRARY) -> dict:
    """Write rig.json + rig-splats.bin (+ the shared motion library) into actor_dir/sequence and
    point sequence.json at them. The baked frames stay untouched (they remain the fallback)."""
    import hashlib

    from rig_export import install_in_sequence

    seq_dir = actor_dir / "sequence"
    sequence = json.loads((seq_dir / "sequence.json").read_text())
    rig = json.loads(files["rig.json"])
    blob = files["rig-splats.bin"]
    expect = rig["files"]["splats"]
    if len(blob) != expect["bytes"] or hashlib.sha256(blob).hexdigest() != expect["sha256"]:
        raise ValueError("rig-splats.bin does not match rig.json")
    if rig["splats"] != sequence.get("gaussiansPerFrame"):
        raise ValueError(f"rig has {rig['splats']} splats, sequence {sequence.get('gaussiansPerFrame')}")
    (seq_dir / "rig-splats.bin").write_bytes(blob)
    (seq_dir / "rig.json").write_bytes(files["rig.json"])
    if "canonical.npz" in files:  # offline rebuild / evaluation input; the browser never loads it
        (actor_dir / "rig-canonical.npz").write_bytes(files["canonical.npz"])
    pointer = install_in_sequence(seq_dir, rig, library)
    return {"dir": str(seq_dir), "pointer": pointer, "validation": rig.get("validation"), "measure": rig.get("measure")}


def recovery_id_of(actor_dir: Path) -> str:
    for name in ("recovery-manifest.json", "recovery-receipt.json"):
        path = actor_dir / name
        if path.is_file():
            rid = json.loads(path.read_text()).get("recoveryId")
            if rid:
                return rid
    raise ValueError(f"{actor_dir}: no recovery-manifest.json / recovery-receipt.json with a recoveryId")


def local_rig(actor_dir: Path) -> dict | None:
    """Rebuild the rig from a previously downloaded rig-canonical.npz (numpy only, no Modal)."""
    npz = actor_dir / "rig-canonical.npz"
    if not npz.is_file():
        return None
    import tempfile

    import numpy as np

    import rig_build
    from package_actor import read_ply

    c = dict(np.load(npz))
    refs = {k[4:-2]: (c[k], c[k[:-1] + "q"]) for k in c if k.startswith("ref_") and k.endswith("_x")}
    props, static = read_ply(actor_dir / "sequence" / "frame_000.ply")
    with tempfile.TemporaryDirectory() as tmp:
        rig_build.build(c, props, static, Path(tmp), refs)
        return {name: (Path(tmp) / name).read_bytes() for name in ("rig.json", "rig-splats.bin")}


def rig_actors(dirs: list[str], remote_only: bool = False) -> int:
    actor_dirs = [Path(d) for d in dirs]
    files = {} if remote_only else {d: f for d in actor_dirs if (f := local_rig(d))}
    todo = [d for d in actor_dirs if d not in files]
    seconds = cost = 0.0
    if todo:
        ids = [recovery_id_of(d) for d in todo]
        with remote("rig") as fn:
            out = fn.remote(ids)
        files.update({d: out["files"][rid] for d, rid in zip(todo, ids)})
        seconds, cost = out["seconds"], out["estimatedComputeUSD"]
    installed = [install_rig(d, files[d]) for d in actor_dirs]
    return result(True, 0, installed=installed, rebuiltLocally=[str(d) for d in actor_dirs if d not in todo], workerSeconds=seconds, estimatedComputeUSD=cost)


def run(a) -> int:
    image = Path(a.image)
    validate_image(image)
    inputs = {"reference.png": image.read_bytes()}
    if a.mask:
        inputs["mask.png"] = Path(a.mask).read_bytes()
    dest = Path(a.out)
    receipt_path, receipt = recovery.new_receipt(dest, "actor", exist_ok=True)
    print(f"receipt {receipt_path} -> volume {receipt['remotePath']}", flush=True)
    print(f"recover without inference: python3 worker/run_actor.py --recover {receipt_path}", flush=True)
    started = time.time()
    with remote("actor") as actor:
        call_result = recovery.submit_once(
            actor,
            receipt_path,
            inputs,
            frames=a.frames,
            talk_frames=a.talk_frames,
            fps=a.fps,
            quantize=not a.lossless,
            detail=a.detail,
            finetune=a.finetune,
            finetune_iters=a.finetune_iters,
            finetune_seconds=a.finetune_seconds,
        )
    print(json.dumps(call_result["report"], indent=2), flush=True)
    import modal

    try:
        volume = modal.Volume.from_name(recovery.VOLUME_NAME, create_if_missing=False)
        manifest = recovery.recover_outputs(
            receipt_path, volume, include_raw=a.include_raw, all_frames=a.all_frames
        )
    except Exception as error:  # noqa: BLE001 - the GPU call finished; only the download broke
        if network_error(error):
            return retry_later(error, recovery.load_receipt(receipt_path))
        raise
    summary = summarize(dest, manifest)
    summary["wallSeconds"] = time.time() - started
    ok = manifest["status"] == "complete"
    return result(ok, 0 if ok else 1, **summary)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--image")
    ap.add_argument("--mask")
    ap.add_argument("--out")
    ap.add_argument("--frames", type=int, default=48)
    ap.add_argument("--talk-frames", type=int, default=24)
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--lossless", action="store_true", help="float32 motion track (default uint16)")
    ap.add_argument("--detail", choices=("standard", "high"), default="standard", help="high: LHM-1B-HF + fine-tune (~5 min)")
    ap.add_argument("--finetune", action=argparse.BooleanOptionalAction, default=None, help="force the fine-tune on/off (default: on for --detail high)")
    ap.add_argument("--finetune-iters", type=int, default=600)
    ap.add_argument("--finetune-seconds", type=float, default=100.0)
    ap.add_argument("--include-raw", action="store_true", help="also download raw/ LHM frames")
    ap.add_argument(
        "--all-frames",
        action="store_true",
        help="download every packaged PLY (default: frame_000 + motion track when one exists)",
    )
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--stage", action="store_true")
    ap.add_argument("--stage-high", action="store_true", help="stage LHM-1B-HF for --detail high (CPU only)")
    ap.add_argument("--recover")
    ap.add_argument("--rig", nargs="+", metavar="DIR", help="export the runtime rig for finished actor dirs")
    ap.add_argument("--rig-remote", action="store_true", help="re-export on Modal even when DIR/rig-canonical.npz exists")
    a = ap.parse_args(argv)
    if not load_modal_auth():
        return result(False, 1, error="Modal credentials absent (MODAL_TOKEN_ID/SECRET)")
    try:
        if a.check:
            with remote("check", SETUP_APP, "modal_lhm_stage") as check:
                report = check.remote()
            print(json.dumps(report, indent=2), flush=True)
            return result(report["imports"], 0 if report["imports"] else 1, check=report)
        if a.stage or a.stage_high:
            import subprocess

            phase = ["--phase", "model-1b"] if a.stage_high else []
            code = subprocess.call(
                [sys.executable, "-m", "modal", "run", "--detach", str(HERE / "modal_lhm_stage.py"), *phase]
            )
            return result(code == 0, code)
        if a.recover:
            return recover(Path(a.recover), a.include_raw, a.all_frames)
        if a.rig:
            return rig_actors(a.rig, a.rig_remote)
        if not a.image or not a.out:
            ap.print_usage(sys.stderr)
            return result(False, 2, error="--image and --out are required")
        return run(a)
    except Exception as error:  # noqa: BLE001 - the caller needs one parseable failure line
        return result(False, 1, error=f"{type(error).__name__}: {error}"[:600])


if __name__ == "__main__":
    sys.exit(main())
