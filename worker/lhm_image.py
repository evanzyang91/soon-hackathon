"""The LHM CUDA worker image, shared by the GPU app (modal_lhm.py) and the CPU setup app.

Exactly OrbisEngine's worker image (CUDA 12.1 devel, torch 2.3.0, pytorch3d / diff-gaussian-
rasterization / simple-knn built for sm_89 = L4, LHM at the pinned revision). The stage scripts
in lhm_stages/ are mounted at container start, so editing them never rebuilds the image.
"""

import sys
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from lhm_stages.weights import LHM_REV  # noqa: E402

image = (
    modal.Image.from_registry("nvidia/cuda:12.1.1-cudnn8-devel-ubuntu22.04", add_python="3.10")
    .apt_install(
        "git", "build-essential", "ninja-build", "ffmpeg", "libgl1", "libglib2.0-0", "libegl1"
    )
    .env(
        {
            "TORCH_CUDA_ARCH_LIST": "8.9",
            "FORCE_CUDA": "1",
            "MAX_JOBS": "4",
            "PYTHONUNBUFFERED": "1",
            "HF_HOME": "/cache/huggingface",
            "TORCH_HOME": "/cache/torch",
            "U2NET_HOME": "/cache/u2net",
            "PYOPENGL_PLATFORM": "egl",
        }
    )
    .uv_pip_install(
        "torch==2.3.0",
        "torchvision==0.18.0",
        "xformers==0.0.26.post1",
        "numpy==1.23.5",
        "setuptools==74.0.0",
        "wheel",
        "ninja",
    )
    .uv_pip_install(
        "numpy==1.23.5",
        "scipy==1.14.1",
        "pillow==10.4.0",
        "opencv-python-headless==4.11.0.86",
        "einops",
        "roma",
        "accelerate",
        "smplx",
        "decord==0.6.0",
        "diffusers==0.32.0",
        "gsplat==1.4.0",
        "huggingface_hub==0.28.1",
        "safetensors",
        "imageio==2.34.1",
        "imageio-ffmpeg",
        "jaxtyping==0.2.38",
        "kornia==0.7.2",
        "loguru",
        "lpips",
        "matplotlib==3.8.4",
        "omegaconf",
        "plyfile==1.0.3",
        "pygltflib",
        "pyrender",
        "pyyaml",
        "requests",
        "timm==1.0.15",
        "trimesh==4.4.9",
        "transformers==4.41.2",
        "tqdm",
        "typeguard==2.13.3",
        "iopath",
        "fvcore",
        "rembg==2.0.63",
        "onnxruntime",
        "addict",
        "future",
        "lmdb",
        "scikit-image==0.22.0",
        "tb-nightly",
        "yapf",
    )
    .uv_pip_install("pip==24.3.1")
    .uv_pip_install("chumpy==0.70", extra_options="--no-build-isolation --no-deps")
    .run_commands(
        "git clone https://github.com/XPixelGroup/BasicSR.git /opt/basicsr && git -C /opt/basicsr checkout 8d56e3a045f9fb3e1d8872f92ee4a4f07f886b0a",
    )
    .uv_pip_install("/opt/basicsr", extra_options="--no-deps")
    .uv_pip_install(
        "gfpgan==1.3.8", "facexlib==0.3.0", "filterpy==1.4.5", extra_options="--no-deps"
    )
    .run_commands(
        "git clone https://github.com/facebookresearch/pytorch3d.git /opt/pytorch3d && git -C /opt/pytorch3d checkout 89653419d0973396f3eff1a381ba09a07fffc2ed",
    )
    .uv_pip_install(
        "/opt/pytorch3d",
        extra_options="--no-build-isolation --no-deps",
        env={"CC": "gcc", "CXX": "g++", "CUB_HOME": "/usr/local/cuda/include"},
    )
    .run_commands(
        "git clone --recursive https://github.com/ashawkey/diff-gaussian-rasterization.git /opt/diff-gaussian-rasterization && git -C /opt/diff-gaussian-rasterization checkout 8829d14f814fccdaf840b7b0f3021a616583c0a1",
    )
    .uv_pip_install(
        "/opt/diff-gaussian-rasterization",
        extra_options="--no-build-isolation --no-deps",
        env={"CC": "gcc", "CXX": "g++"},
    )
    .run_commands(
        "git clone https://github.com/camenduru/simple-knn.git /opt/simple-knn && git -C /opt/simple-knn checkout 60f461f4a56b7967e5d8045bf92f8c33f36976d0",
    )
    .uv_pip_install(
        "/opt/simple-knn",
        extra_options="--no-build-isolation --no-deps",
        env={"CC": "gcc", "CXX": "g++"},
    )
    .run_commands(
        f"git clone https://github.com/aigc3d/LHM.git /opt/lhm && git -C /opt/lhm checkout {LHM_REV}",
    )
    .add_local_dir(HERE / "lhm_stages", "/root/lhm_stages", ignore=["__pycache__", "*.pyc"])
    .add_local_python_source("lhm_image")
)
