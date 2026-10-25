#!/usr/bin/env python3
"""Reference image of an object -> TripoSR on Modal -> a vertex-coloured glTF binary.

    python3 worker/run_prop.py --image ref.png --out model.glb [--report run.json]
                               [--resolution 256] [--max-faces 50000] [--foreground-ratio 0.85]
    python3 worker/run_prop.py --check      # Modal auth + image build + imports (CPU only, no GPU)

Used by server/pipeline/props.ts ("Generate from a description…"). Auth: MODAL_TOKEN_ID /
MODAL_TOKEN_SECRET from the environment, else from the repo's .env.local / .env (values are never
printed). Uses the deployed app ``previz-stage-prop`` when it exists (``modal deploy
worker/modal_prop.py``), otherwise runs it as an ephemeral app (the first run builds the image).

Progress lines start with ``[prop]`` (the server shows them as the job's note); the last stdout
line is always ``RESULT {json}`` (``ok`` true/false). Exit codes: 0 ok, 1 failure, 2 usage.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from contextlib import contextmanager
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))

APP_NAME = "previz-stage-prop"
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def result(ok: bool, code: int = 0, **fields) -> int:
    print("RESULT " + json.dumps({"ok": ok, **fields}), flush=True)
    return code


def log(message: str) -> None:
    print(f"[prop] {message}", flush=True)


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
def remote(name: str):
    """Yield a Modal Function: the deployed one if present, else an ephemeral app's."""
    import modal

    try:
        deployed = modal.Function.from_name(APP_NAME, name)
        deployed.hydrate()
    except modal.exception.NotFoundError:
        deployed = None
    if deployed is not None:
        log(f"using the deployed {APP_NAME}.{name}")
        yield deployed
        return
    import modal_prop

    log("starting the Modal app (the first run builds the image: a few minutes)")
    # container output streams through, so its own "[prop] …" stages reach the server too
    with modal.enable_output():
        with modal_prop.app.run():
            yield getattr(modal_prop, name)


def validate_image(path: Path) -> bytes:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError(f"{path} is not a PNG")
    if len(data) > MAX_IMAGE_BYTES:
        raise ValueError(f"{path} exceeds {MAX_IMAGE_BYTES} bytes")
    return data


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--image")
    ap.add_argument("--out")
    ap.add_argument("--report", help="write the run's receipt (timings, cost, triangles) here")
    ap.add_argument("--resolution", type=int, default=256, help="marching cubes grid (TripoSR's default 256)")
    ap.add_argument("--max-faces", type=int, default=50000, help="decimate to at most this many triangles")
    ap.add_argument("--foreground-ratio", type=float, default=0.85)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args(argv)

    if not load_modal_auth():
        return result(False, 1, error="Modal auth missing: set MODAL_TOKEN_ID / MODAL_TOKEN_SECRET")
    try:
        import modal  # noqa: F401
    except ImportError:
        return result(False, 1, error="the modal client is not installed (pip install modal)")

    if args.check:
        try:
            with remote("check") as check:
                return result(True, 0, **check.remote())
        except Exception as error:  # noqa: BLE001 - reported to the caller
            return result(False, 1, error=f"{type(error).__name__}: {error}"[:600])

    if not args.image or not args.out:
        print("usage: run_prop.py --image ref.png --out model.glb", file=sys.stderr)
        return result(False, 2, error="--image and --out are required")
    try:
        png = validate_image(Path(args.image))
    except (OSError, ValueError) as error:
        return result(False, 2, error=str(error))

    t0 = time.time()
    try:
        with remote("prop") as fn:
            log("meshing on an L4 (TripoSR)")
            out = fn.remote(png, resolution=args.resolution, max_faces=args.max_faces, foreground_ratio=args.foreground_ratio)
    except Exception as error:  # noqa: BLE001 - reported to the caller
        return result(False, 1, error=f"Modal call failed: {type(error).__name__}: {error}"[:600], wallSeconds=round(time.time() - t0, 1))

    glb = out.pop("glb", b"")
    cutout = out.pop("cutout", b"")
    if not glb[:4] == b"glTF":
        return result(False, 1, error="the worker returned no glTF binary", wallSeconds=round(time.time() - t0, 1))
    dest = Path(args.out)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    tmp.write_bytes(glb)
    tmp.replace(dest)
    if cutout:
        (dest.parent / "cutout.png").write_bytes(cutout)
    receipt = {**out, "bytes": len(glb), "wallSeconds": round(time.time() - t0, 1), "out": str(dest)}
    if args.report:
        Path(args.report).write_text(json.dumps(receipt, indent=2) + "\n")
    log(f"saved {dest.name}: {receipt['faces']} triangles, {len(glb)} bytes, {receipt['wallSeconds']}s wall")
    return result(True, 0, **receipt)


if __name__ == "__main__":
    sys.exit(main())
