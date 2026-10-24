"""Text-to-motion for the shared actor motion library: HY-Motion 1.0 on Modal (run once).

HY-Motion 1.0 (Tencent Hunyuan, 1.0 B flow-matching DiT, Qwen3-8B + CLIP-L text encoders)
returns SMPL body motion: root + 21 joint rotations (6D) and root translation at 30 fps. Those 22
joints are SMPL-X's first 22, so the clips drive any LHM actor's rig directly (rotations are
body-agnostic; worker/motion_library.py rescales root translation by leg length).

    python3 worker/motion_library.py --generate     # stage (once) + generate + build the library

Volumes: weights in ``previz-stage-motion-cache`` (~22 GB: HY-Motion-1.0 4.2 GB, Qwen3-8B
16.4 GB, CLIP-L 1.7 GB, revisions pinned); raw clips also land in the LHM Volume under
``/cache/motion-library/raw`` next to the built library, where the actor worker copies it from.
"""

from __future__ import annotations

import modal

APP_NAME = "previz-stage-motion"
HY_REPO = "https://github.com/Tencent-Hunyuan/HY-Motion-1.0.git"
HY_REV = "4e426f5a1021cbcf7f375458c37b840ee7225229"
WEIGHTS = {
    "tencent/HY-Motion-1.0": dict(revision="620dd559f8d964aac2f82f1204fe6a35ad8ad14d", allow=["HY-Motion-1.0/*"], dest="tencent"),
    "Qwen/Qwen3-8B": dict(revision="b968826d9c46dd6066d109eabc6255188de91218", allow=["*.json", "*.safetensors", "merges.txt", "vocab.json"], dest="Qwen3-8B"),
    "openai/clip-vit-large-patch14": dict(revision="32bd64288804d66eefd0ccbe215aa642df71cc41", allow=["*.json", "model.safetensors", "merges.txt", "vocab.json"], dest="clip-vit-large-patch14"),
}
# Modal list prices (USD / s): L40S GPU + CPU core + GiB
L40S_PER_S, CPU_CORE_PER_S, GIB_PER_S = 0.000542, 0.0000131, 0.00000222

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "git-lfs")
    .uv_pip_install(
        "torch==2.5.1",
        "torchdiffeq==0.2.5",
        "accelerate==0.30.1",
        "diffusers==0.26.3",
        "transformers==4.53.3",
        "einops==0.8.1",
        "safetensors==0.5.3",
        "numpy<2",
        "scipy>=1.10",
        "transforms3d==0.4.2",
        "PyYAML==6.0.2",
        "omegaconf==2.3.0",
        "huggingface_hub==0.30.0",
        "hf_transfer",
    )
    .run_commands(
        f"git clone {HY_REPO} /opt/hymotion && git -C /opt/hymotion checkout {HY_REV}",
        "cd /opt/hymotion && git lfs install && git lfs pull --include='stats/*,scripts/gradio/static/assets/dump_wooden/*'",
    )
    .env({"PYTHONUNBUFFERED": "1", "HF_HUB_ENABLE_HF_TRANSFER": "1", "USE_HF_MODELS": "0"})
)

app = modal.App(APP_NAME)
weights = modal.Volume.from_name("previz-stage-motion-cache", create_if_missing=True)
library = modal.Volume.from_name("previz-stage-lhm-cache", create_if_missing=False)


@app.function(image=image, volumes={"/weights": weights}, cpu=4, memory=8192, timeout=3600, retries=0)
def stage() -> dict:
    """Download the pinned weights into the weights Volume (idempotent; CPU only)."""
    import time
    from pathlib import Path

    from huggingface_hub import snapshot_download

    t0 = time.time()
    report = {}
    for repo, spec in WEIGHTS.items():
        dest = Path("/weights/ckpts") / spec["dest"]
        marker = dest / f".complete-{spec['revision']}"
        if marker.exists():
            report[repo] = "cached"
            continue
        snapshot_download(repo, revision=spec["revision"], allow_patterns=spec["allow"], local_dir=str(dest))
        marker.write_text("ok")
        weights.commit()
        report[repo] = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file())
    report["seconds"] = time.time() - t0
    report["estimatedComputeUSD"] = report["seconds"] * (4 * CPU_CORE_PER_S + 8 * GIB_PER_S)
    return report


@app.function(
    image=image,
    gpu="L40S",
    cpu=4,
    memory=32768,
    volumes={"/weights": weights, "/cache": library},
    timeout=1800,
    retries=0,
    max_containers=1,
    scaledown_window=2,
)
def generate(prompts: list, seeds: list) -> dict:
    """prompts: [{name, text, seconds}] -> {name: npz bytes (rotmats (S,L,22,3,3), transl (S,L,3),
    keypoints (S,L,22,3), seeds)} at 30 fps. Raw npz are also kept in /cache/motion-library/raw."""
    import io
    import os
    import sys
    import time
    from pathlib import Path

    import numpy as np
    import torch
    import yaml

    t0 = time.time()
    os.chdir("/opt/hymotion")
    sys.path.insert(0, "/opt/hymotion")
    ckpts = Path("/opt/hymotion/ckpts")  # the repo ships ckpts/README.md: link each staged tree in
    ckpts.mkdir(exist_ok=True)
    for spec in WEIGHTS.values():
        link = ckpts / spec["dest"]
        if not link.exists():
            link.symlink_to(Path("/weights/ckpts") / spec["dest"], target_is_directory=True)
    from hymotion.utils.geometry import rot6d_to_rotation_matrix
    from hymotion.utils.loaders import load_object

    model_dir = ckpts / "tencent/HY-Motion-1.0"
    config = yaml.safe_load((model_dir / "config.yml").read_text())
    pipe = load_object(config["train_pipeline"], config["train_pipeline_args"], network_module=config["network_module"], network_module_args=config["network_module_args"])
    pipe.load_in_demo(str(model_dir / "latest.ckpt"), build_text_encoder=True)
    pipe.to(torch.device("cuda"))
    timings = {"load": time.time() - t0}
    out_dir = Path("/cache/motion-library/raw")
    out_dir.mkdir(parents=True, exist_ok=True)
    results = {}
    for p in prompts:
        t1 = time.time()
        with torch.no_grad():
            out = pipe.generate(p["text"], list(seeds), p["seconds"])
        rot6d = out["rot6d"].float()  # (S, L, 22, 6)
        S, L = rot6d.shape[:2]
        rotmats = rot6d_to_rotation_matrix(rot6d.reshape(-1, 6)).reshape(S, L, 22, 3, 3).numpy()
        buf = io.BytesIO()
        np.savez_compressed(
            buf,
            rotmats=rotmats.astype(np.float32),
            transl=out["transl"].float().numpy().astype(np.float32),
            keypoints=out["keypoints3d"].float().numpy().astype(np.float32),
            seeds=np.array(seeds),
            fps=np.array(30),
            text=np.array(p["text"]),
        )
        data = buf.getvalue()
        (out_dir / f"{p['name']}.npz").write_bytes(data)
        results[p["name"]] = data
        timings[p["name"]] = time.time() - t1
        print(f"{p['name']}: {S} x {L} frames in {timings[p['name']]:.1f}s", flush=True)
    library.commit()
    seconds = time.time() - t0
    return {
        "clips": results,
        "timings": timings,
        "seconds": seconds,
        "peakVRAMGB": torch.cuda.max_memory_allocated() / 1e9,
        "estimatedComputeUSD": seconds * (L40S_PER_S + 4 * CPU_CORE_PER_S + 32 * GIB_PER_S),
    }


@app.local_entrypoint()
def main():
    raise SystemExit("use: python3 worker/motion_library.py --generate")
