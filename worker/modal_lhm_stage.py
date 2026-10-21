"""One-time, CPU-only staging of LHM weights into the actor Volume. Never starts a GPU.

Each phase (prior archive, model weights, auxiliary weights) writes a receipt under
``/cache/setup-receipts/`` and is idempotent: a rerun reuses what is already there,
and the 18.8 GB prior archive resumes with pinned HTTP ranges (If-Match on the ETag) instead of
starting over.

    python worker/run_actor.py --stage          # preferred: loads keys from .env.local
    python worker/run_actor.py --stage-high     # LHM-1B-HF only (6.85 GB), for --detail high
    python worker/run_actor.py --check          # CUDA image + LHM imports + weight audit, no GPU
    modal run --detach worker/modal_lhm_stage.py   # equivalent, needs Modal auth in the shell
"""

import sys
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lhm_stages.weights import (  # noqa: E402
    AUX_WEIGHTS,
    LARGE_MODEL_ID,
    LARGE_MODEL_REV,
    MODEL_ID,
    MODEL_REV,
    PRIOR_BYTES,
    PRIOR_URL,
    REQUIRED_PRIORS,
    VOLUME_NAME,
    staged_weight_report,
)

from lhm_image import image as lhm_image  # noqa: E402

CPU_CORE_PER_S, GIB_PER_S = 0.0000131, 0.00000222

stage_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("huggingface_hub==0.28.1")
    .add_local_dir(HERE / "lhm_stages", "/root/lhm_stages", ignore=["__pycache__", "*.pyc"])
    .add_local_python_source("lhm_image")
)
# CPU-only app: it must never hold a GPU function, so `check` works on accounts without GPU access.
app = modal.App("previz-stage-lhm-setup")
cache = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


class RangeReader:
    """Seekable read-only HTTP object; reconnects with Range + If-Match on drops and seeks."""

    def __init__(self, url, size, etag):
        self.url, self.size, self.etag = url, size, etag
        self.pos, self.resp, self.requests, self.received = 0, None, 0, 0

    def _open(self):
        import urllib.request

        headers = {"Range": f"bytes={self.pos}-"}
        if self.etag:
            headers["If-Match"] = self.etag
        self.resp = urllib.request.urlopen(
            urllib.request.Request(self.url, headers=headers), timeout=60
        )
        self.requests += 1
        if self.pos and self.resp.status != 206:
            raise IOError(f"range request answered {self.resp.status}")

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        target = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        if self.resp is not None and 0 < target - self.pos <= 8 * 1024 * 1024:
            # tarfile seeks over block padding after every member: read through, don't reconnect
            self.read(target - self.pos)
        elif target != self.pos:
            if self.resp is not None:
                self.resp.close()
            self.resp = None
            self.pos = target
        return self.pos

    def read(self, size=-1):
        import time

        if size is None or size < 0:
            size = self.size - self.pos
        size = min(size, self.size - self.pos)
        out = bytearray()
        failures = 0
        while len(out) < size:
            try:
                if self.resp is None:
                    self._open()
                chunk = self.resp.read(size - len(out))
                if not chunk:
                    raise IOError("connection closed early")
            except Exception as error:  # noqa: BLE001 - reconnect at the exact offset
                failures += 1
                if failures > 20:
                    raise
                print(f"range reader: {type(error).__name__} at {self.pos}; retrying", flush=True)
                try:
                    if self.resp is not None:
                        self.resp.close()
                except Exception:  # noqa: BLE001
                    pass
                self.resp = None
                time.sleep(min(30, 2**failures))
                continue
            out.extend(chunk)
            self.pos += len(chunk)
            self.received += len(chunk)
        return bytes(out)


def write_receipt(path, document):
    import json

    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(document, indent=2))
    tmp.replace(path)


def download(url, target, expected=None):
    import hashlib
    import shutil
    import urllib.request

    target = Path(target)
    if target.is_file() and (expected is None or target.stat().st_size == expected):
        return {"url": url, "destination": str(target), "reused": True}
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_name(target.name + ".incomplete")
    with urllib.request.urlopen(url, timeout=60) as response, partial.open("wb") as out:
        length = int(response.headers.get("Content-Length") or 0)
        if expected is not None and length and length != expected:
            raise ValueError(f"upstream size changed for {url}: {length} != {expected}")
        shutil.copyfileobj(response, out, 4 * 1024 * 1024)
    size = partial.stat().st_size
    if (expected is not None and size != expected) or (length and size != length):
        raise ValueError(f"short download for {url}")
    digest = hashlib.sha256(partial.read_bytes()).hexdigest()
    partial.rename(target)
    return {"url": url, "destination": str(target), "bytes": size, "sha256": digest}


def stage_priors(report):
    import tarfile
    import time
    import urllib.request

    destination = Path("/cache/data")
    receipt = Path("/cache/setup-receipts/lhm-priors.json")
    if receipt.exists() and all(
        (destination / "pretrained_models" / n).exists() for n in REQUIRED_PRIORS
    ):
        report["steps"].append({"name": "lhm-priors", "reused": True})
        return
    with urllib.request.urlopen(urllib.request.Request(PRIOR_URL, method="HEAD"), timeout=60) as head:
        etag = head.headers.get("ETag")
        size = int(head.headers["Content-Length"])
    if size != PRIOR_BYTES:
        raise ValueError("upstream prior archive size changed")
    reader = RangeReader(PRIOR_URL, size, etag)
    extracted = reused = 0
    last_commit = last_log = time.time()
    with tarfile.open(fileobj=reader, mode="r:") as archive:
        for member in archive:
            parts = Path(member.name).parts
            if not parts:
                continue
            if parts[0] not in ("pretrained_models", "gfpgan") or ".." in parts:
                raise ValueError(f"unexpected prior archive member {member.name}")
            target = destination / member.name
            if member.isfile() and target.is_file() and target.stat().st_size == member.size:
                reused += 1  # resume: tarfile seeks past the member data on next()
                continue
            archive.extract(member, path=destination, filter="data")
            extracted += 1
            now = time.time()
            if now - last_log > 30:
                print(
                    f"priors: extracted {extracted}, reused {reused}, "
                    f"{reader.pos / 1e9:.2f}/{size / 1e9:.2f} GB",
                    flush=True,
                )
                last_log = now
            if now - last_commit > 300:
                cache.commit()
                last_commit = now
    missing = [n for n in REQUIRED_PRIORS if not (destination / "pretrained_models" / n).exists()]
    if missing:
        raise ValueError(f"required prior subtrees missing: {missing}")
    step = {
        "name": "lhm-priors",
        "url": PRIOR_URL,
        "bytes": PRIOR_BYTES,
        "etag": etag,
        "extracted": extracted,
        "reused": reused,
        "rangeRequests": reader.requests,
        "bytesReceived": reader.received,
    }
    write_receipt(receipt, step)
    report["steps"].append(step)


def stage_large_model(report):
    """LHM-1B-HF at the pinned revision (the "high detail" actor checkpoint), next to 500M."""
    from huggingface_hub import snapshot_download

    snapshot = snapshot_download(
        LARGE_MODEL_ID, revision=LARGE_MODEL_REV, cache_dir="/cache/huggingface/hub", max_workers=4
    )
    step = {"name": "lhm-model-1b", "model": LARGE_MODEL_ID, "revision": LARGE_MODEL_REV, "snapshot": snapshot}
    write_receipt("/cache/setup-receipts/lhm-model-1b.json", step)
    report["steps"].append(step)


def stage_model_and_aux(report):
    from huggingface_hub import snapshot_download

    snapshot = snapshot_download(
        MODEL_ID, revision=MODEL_REV, cache_dir="/cache/huggingface/hub", max_workers=4
    )
    step = {"name": "lhm-model", "model": MODEL_ID, "revision": MODEL_REV, "snapshot": snapshot}
    write_receipt("/cache/setup-receipts/lhm-model.json", step)
    report["steps"].append(step)
    cache.commit()
    aux = []
    for relative, (url, expected) in AUX_WEIGHTS.items():
        aux.append({"name": relative, **download(url, Path("/cache") / relative, expected)})
        print(f"staged {relative}", flush=True)
    write_receipt("/cache/setup-receipts/aux-weights.json", {"steps": aux})
    report["steps"].extend(aux)


@app.function(
    image=stage_image,
    cpu=2,
    memory=4096,
    timeout=6 * 3600,
    retries=0,
    volumes={"/cache": cache},
    scaledown_window=2,
)
def stage_weights(phase: str):
    """phase: 'priors' (18.8 GB LHM prior tar), 'model+aux' (HF model + small weights) or
    'model-1b' (LHM-1B-HF for high-detail actors)."""
    import time

    phases = {"priors": stage_priors, "model+aux": stage_model_and_aux, "model-1b": stage_large_model}
    if phase not in phases:
        raise ValueError("unknown staging phase")
    started = time.time()
    report = {"phase": phase, "status": "started", "startedEpoch": started, "steps": []}
    attempt = Path(f"/cache/setup-receipts/{phase.replace('+', '-')}-attempt.json")
    write_receipt(attempt, report)
    cache.commit()
    try:
        phases[phase](report)
        report["status"] = "complete"
    except Exception as error:  # noqa: BLE001 - always leave a failure receipt
        report["status"] = "failed"
        report["errorType"] = type(error).__name__
        report["error"] = str(error)[:400]
    finally:
        report["elapsedSeconds"] = time.time() - started
        report["computeUpperEstimateUSD"] = report["elapsedSeconds"] * (
            2 * CPU_CORE_PER_S + 4 * GIB_PER_S
        )
        write_receipt(attempt, report)
        cache.commit()
    return report


@app.function(image=stage_image, volumes={"/cache": cache}, timeout=120)
def audit():
    cache.reload()
    return staged_weight_report("/cache")


@app.function(image=lhm_image, cpu=2, memory=8192, timeout=900, volumes={"/cache": cache})
def check():
    """No-GPU smoke: the CUDA worker image builds, LHM imports, and the Volume has the weights."""
    import subprocess
    import time

    from lhm_stages.weights import LHM_REV

    started = time.time()
    probe = subprocess.run(
        [
            "python",
            "-c",
            "import torch, pytorch3d, diff_gaussian_rasterization, gsplat, rembg; "
            "from LHM.models import model_dict; print(torch.__version__, sorted(model_dict))",
        ],
        cwd="/opt/lhm",
        capture_output=True,
        text=True,
    )
    cache.reload()
    return {
        "imports": probe.returncode == 0,
        "importOutput": (probe.stdout + probe.stderr)[-2000:],
        "weights": staged_weight_report("/cache"),
        "codeRevision": LHM_REV,
        "model": MODEL_ID,
        "modelRevision": MODEL_REV,
        "seconds": time.time() - started,
    }


@app.local_entrypoint()
def main(phase: str = "all"):
    """`all` = what standard actors need; `model-1b` stages the high-detail checkpoint."""
    import json

    phases = ("priors", "model+aux") if phase == "all" else (phase,)
    calls = [stage_weights.spawn(p) for p in phases]
    failed = False
    for call in calls:
        report = call.get()
        failed |= report["status"] != "complete"
        print(json.dumps({k: v for k, v in report.items() if k != "steps"}, indent=2), flush=True)
    print(json.dumps(audit.remote(), indent=2))
    if failed:
        raise SystemExit("staging incomplete; rerun to resume")
