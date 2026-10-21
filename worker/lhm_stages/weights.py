"""Pinned LHM code/weights and where each staged file lives inside the cache Volume.

Shared by ``worker/modal_lhm.py`` (GPU inference app) and ``worker/modal_lhm_stage.py`` (CPU-only
staging app). Revisions are pinned so a rebuilt image produces the same avatars.
"""

from pathlib import Path

VOLUME_NAME = "previz-stage-lhm-cache"
LHM_REV = "4f88aaeb3629249fbbddb4d0784a06962d9e1338"
MODEL_ID = "3DAIGC/LHM-500M-HF"
MODEL_REV = "dd6392905187a91fd67b3f6962aa74481e943764"
# "High detail" actors (run_actor --detail high): the larger checkpoint (same architecture and
# 40,000 gaussians, 15 instead of 5 transformer layers),
# 6.85 GB of safetensors at this revision.
LARGE_MODEL_ID = "3DAIGC/LHM-1B-HF"
LARGE_MODEL_REV = "92372582f660066b9f1b9513860744357265b3d5"
MODELS = {"standard": (MODEL_ID, MODEL_REV), "high": (LARGE_MODEL_ID, LARGE_MODEL_REV)}

PRIOR_URL = "https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LHM/LHM_prior_model.tar"
PRIOR_BYTES = 18_818_365_440
REQUIRED_PRIORS = ("human_model_files", "gagatracker", "dense_sample_points", "voxel_grid")

# path inside the Volume -> (public url, expected bytes or None)
AUX_WEIGHTS = {
    "torch/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth": (
        "https://dl.fbaipublicfiles.com/dinov2/dinov2_vitl14/dinov2_vitl14_reg4_pretrain.pth",
        1_217_607_321,
    ),
    "gfpgan/weights/GFPGANv1.3.pth": (
        "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.3.pth",
        348_632_874,
    ),
    "data/gfpgan/weights/detection_Resnet50_Final.pth": (
        "https://github.com/xinntao/facexlib/releases/download/v0.1.0/detection_Resnet50_Final.pth",
        None,
    ),
    "data/gfpgan/weights/parsing_parsenet.pth": (
        "https://github.com/xinntao/facexlib/releases/download/v0.2.2/parsing_parsenet.pth",
        None,
    ),
    # rembg person matte when the caller sends no mask (LHM upstream's own no-SAM2 fallback)
    "u2net/u2net.onnx": (
        "https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net.onnx",
        None,
    ),
}


def model_staged(root, model_id, revision):
    return any(
        (Path(root) / "huggingface/hub").glob(f"models--{model_id.replace('/', '--')}/snapshots/{revision}")
    )


def staged_weight_report(root="/cache"):
    """What a GPU call needs and whether the Volume has it. Pure filesystem reads.

    `ready` covers standard actors (LHM-500M); `largeModel` says whether `--detail high` can run.
    """
    root = Path(root)
    priors = root / "data/pretrained_models"
    receipts = root / "setup-receipts"
    report = {
        "priors": {name: (priors / name).exists() for name in REQUIRED_PRIORS},
        "aux": {path: (root / path).is_file() for path in AUX_WEIGHTS},
        "model": model_staged(root, MODEL_ID, MODEL_REV),
        "largeModel": model_staged(root, LARGE_MODEL_ID, LARGE_MODEL_REV),
        "receipts": sorted(p.name for p in receipts.glob("*.json")) if receipts.is_dir() else [],
    }
    # subtrees appear early during extraction; only the completion receipt means "all there"
    report["priorsComplete"] = (receipts / "lhm-priors.json").is_file()
    report["ready"] = bool(
        report["priorsComplete"]
        and all(report["priors"].values())
        and all(report["aux"].values())
        and report["model"]
    )
    return report
