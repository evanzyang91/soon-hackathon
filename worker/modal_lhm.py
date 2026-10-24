"""Previz Stage actor worker: one reference image -> LHM gaussian avatar + idle/talk PLY loop.

A trimmed port of OrbisEngine's ``worker/modal_lhm.py`` (same CUDA image, LHM code revision and
LHM-500M-HF weights, same checkpoint-to-volume + small-receipt discipline). Differences:

* Input is one generated full-body reference PNG (+ optional mask). Without a mask the worker
  segments the person with ``rembg`` (LHM upstream's own fallback when SAM2 is absent).
* Motion is a procedural, seamlessly looping idle (breathing / sway / head turn) and a short talk
  loop (adds jaw + nods) built by perturbing the Multi-HMR source pose's SMPL-X body parameters,
  fed through LHM's native ``animation_infer_gs`` skinning. No video, no stock dance motion.
* The worker packages the frames itself (``lhm_stages/package_actor.py``, pure numpy) into an
  avatar-local OpenGL frame + ``sequence.json`` + a ``wander.person-motion/1`` motion track.

Entry points (use ``worker/run_actor.py`` rather than calling these directly):

    python worker/run_actor.py --check    # image build + LHM imports + weight audit (setup app, no GPU)
    python worker/run_actor.py --stage    # one-time CPU weight staging (worker/modal_lhm_stage.py)
    python worker/run_actor.py --image ref.png --out DIR --frames 48

Every GPU call writes into ``/cache/recovery/<id>/`` and commits the volume before returning a
small receipt; ``python worker/run_actor.py --recover DIR/recovery-receipt.json`` re-downloads a
finished checkpoint without inference.
"""

import sys
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lhm_stages.weights import (  # noqa: E402
    LHM_REV,
    MODEL_ID,
    MODEL_REV,
    VOLUME_NAME,
)

from lhm_image import image  # noqa: E402

APP_NAME = "previz-stage-lhm"

# Modal list prices used by Orbis for its receipts (USD / second).
L4_PER_S, CPU_CORE_PER_S, GIB_PER_S = 0.000222, 0.0000131, 0.00000222
GPU_CPU, GPU_MEM_GIB = 4, 64

app = modal.App(APP_NAME)
cache = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


def link_model_caches(repo=Path("/opt/lhm"), cache_root=Path("/cache"), gfpgan_package=None):
    """Expose the staged public model trees inside the LHM checkout (verbatim from Orbis)."""
    repo, cache_root = Path(repo), Path(cache_root)
    links = []
    for relative, name in (
        ("data/pretrained_models", "pretrained_models"),
        ("data/gfpgan", "gfpgan"),
    ):
        source, target = cache_root / relative, repo / name
        if not source.is_dir() or not source.resolve().is_relative_to(cache_root.resolve()):
            raise RuntimeError(f"Stage the public model cache before inference: {relative}")
        if target.exists() or target.is_symlink():
            if target.resolve() != source.resolve():
                raise RuntimeError(f"Runtime model path conflicts with the staged cache: {name}")
        else:
            target.symlink_to(source, target_is_directory=True)
        links.append({"runtimePath": str(target), "cachePath": str(source)})
    if gfpgan_package is None:
        import importlib.util

        package = importlib.util.find_spec("gfpgan")
        if package is None or package.origin is None:
            raise RuntimeError("GFPGAN must be installed in the native worker image")
        gfpgan_package = Path(package.origin).parent
    source = cache_root / "gfpgan/weights/GFPGANv1.3.pth"
    target = Path(gfpgan_package) / "weights/GFPGANv1.3.pth"
    if not source.is_file() or not source.resolve().is_relative_to(cache_root.resolve()):
        raise RuntimeError("Stage the public GFPGANv1.3 checkpoint before inference")
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() or target.is_symlink():
        if target.resolve() != source.resolve():
            raise RuntimeError("GFPGAN package weight conflicts with the staged cache")
    else:
        target.symlink_to(source)
    links.append({"runtimePath": str(target), "cachePath": str(source)})
    return links


ALLOWED_INPUTS = ("reference.png", "mask.png")


@app.function(
    image=image,
    gpu="L4",
    cpu=GPU_CPU,
    memory=GPU_MEM_GIB * 1024,
    timeout=1800,
    retries=0,
    max_containers=1,
    volumes={"/cache": cache},
    scaledown_window=2,
)
def actor(
    inputs: dict,
    frames: int = 48,
    talk_frames: int = 24,
    fps: float = 12.0,
    quantize: bool = True,
    recovery_id: str = "",
):
    import json
    import os
    import subprocess
    import tempfile
    import time
    import traceback

    from lhm_stages.recovery import (
        atomic_json,
        file_hash,
        finish_checkpoint,
        remote_root,
        start_checkpoint,
    )

    start = time.time()
    checkpoint, out = start_checkpoint("/cache", recovery_id, "actor")
    cache.commit()
    error = None
    proc = None
    try:
        if not 1 <= frames <= 240 or not 0 <= talk_frames <= 240 or not 1 <= fps <= 60:
            raise ValueError("frames/talk_frames/fps outside the bounded experiment range")
        from huggingface_hub import snapshot_download

        prepared = Path(tempfile.mkdtemp(prefix="actor-"))
        for name, data in inputs.items():
            if name not in ALLOWED_INPUTS:
                raise ValueError(f"Unexpected actor input {name}")
            (prepared / name).write_bytes(data)
        if "reference.png" not in inputs:
            raise ValueError("reference.png is required")
        links = link_model_caches()
        (out / "cache-links.json").write_text(json.dumps(links, indent=2))
        os.chdir("/opt/lhm")
        model = snapshot_download(MODEL_ID, revision=MODEL_REV, local_files_only=True)
        command = [
            "python",
            "/root/lhm_stages/lhm_actor.py",
            "--image",
            str(prepared / "reference.png"),
            "--out",
            str(out),
            "--model",
            model,
            "--frames",
            str(frames),
            "--talk-frames",
            str(talk_frames),
            "--fps",
            str(fps),
        ]
        if (prepared / "mask.png").exists():
            command += ["--mask", str(prepared / "mask.png")]
        if quantize:
            command += ["--quantize"]
        with (out / "inference.log").open("w") as log:
            proc = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                env={
                    **os.environ,
                    "PYTHONPATH": "/root:/root/lhm_stages:/opt/lhm",
                    # rembg -> pymatting compiles numba kernels on import (~50 s per cold
                    # container); cached in the Volume it loads in ~1.4 s (measured). The
                    # cache is keyed by host CPU model, so compile for a generic CPU to make
                    # it portable across Modal hosts.
                    "NUMBA_CACHE_DIR": "/cache/numba",
                    "NUMBA_CPU_NAME": "generic",
                },
            )
            for line in proc.stdout:
                print(line, end="", flush=True)
                log.write(line)
                log.flush()
            if proc.wait() != 0:
                raise RuntimeError(f"LHM actor inference exited {proc.returncode}")
    except Exception:  # noqa: BLE001 - preserve artifacts for any model/dependency failure
        error = traceback.format_exc()
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        print(error, flush=True)
        with (out / "inference.log").open("a") as log:
            log.write(error)
    elapsed = time.time() - start
    report = {
        "seconds": elapsed,
        "error": error,
        "experiment": "reference-image-procedural-idle",
        "gpu": "L4",
        "cpu": GPU_CPU,
        "memoryGiB": GPU_MEM_GIB,
        "timeoutSeconds": 1800,
        "estimatedComputeUSD": elapsed
        * (L4_PER_S + GPU_CPU * CPU_CORE_PER_S + GPU_MEM_GIB * GIB_PER_S),
        "timingScope": "worker setup and inference; excludes final output hashing and volume commit",
        "codeRevision": LHM_REV,
        "model": MODEL_ID,
        "modelRevision": MODEL_REV,
        "frames": frames,
        "talkFrames": talk_frames,
        "fps": fps,
        "recoveryId": recovery_id,
        "remotePath": remote_root(recovery_id),
    }
    atomic_json(out / "modal-run.json", report)
    manifest = finish_checkpoint(checkpoint, mode="actor", error=error)
    # Outputs are durable before this small receipt returns; the caller downloads from the volume.
    cache.commit()
    return {
        "report": report,
        "recoveryId": recovery_id,
        "remotePath": remote_root(recovery_id),
        "manifestSha256": file_hash(checkpoint / "manifest.json"),
        "status": manifest["status"],
        "totalWorkerSeconds": time.time() - start,
    }


@app.local_entrypoint()
def main():
    raise SystemExit("use: python3 worker/run_actor.py --image ref.png --out DIR (or --check)")
