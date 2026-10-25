"""Previz Stage prop worker: one reference image of an object -> a vertex-coloured glTF binary.

Image-to-3D with TripoSR (VAST-AI-Research/TripoSR, MIT; weights stabilityai/TripoSR, MIT) on a
Modal L4. Chosen for speed and simplicity: a single feed-forward pass (well under a second of GPU
time at 256³ marching cubes), ~1.7 GB of weights, plain PyTorch with no custom CUDA build, so a
warm call is a few seconds and a cold one (container start + weights from the Volume) well under
two minutes. The heavier alternatives that paint a texture (a diffusion texture stage) take
minutes per object and need compiled rasterisers. Compared with TripoSR's own ``run.py``:

* marching cubes runs through scikit-image (a ``torchmcubes`` stand-in module), so the image
  needs no CUDA compiler; TripoSR's own axis swap is kept, so the surface is the same
* floaters smaller than 5 % of the largest piece are dropped and the mesh is decimated to
  ``max_faces`` (fast-simplification) *before* the colours are queried, so every kept vertex
  gets its colour from the reconstruction (no colour is interpolated away)
* TripoSR keeps the picture's camera frame, so an object shot a little from above leans toward
  the camera by that angle; ``prop_glb.level`` pitches it back using its flat resting face or top
  (from the convex hull), when it has one
* the result is written by ``prop_glb.py``: y up, front +z (glTF), outward winding, linear
  vertex colours, a rough non-metallic material

Entry points (use ``worker/run_prop.py`` rather than calling these directly):

    python3 worker/run_prop.py --check                     # image build + imports, CPU only
    python3 worker/run_prop.py --image ref.png --out model.glb
"""

import sys
import time
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

APP_NAME = "previz-stage-prop"
VOLUME_NAME = "previz-stage-prop-cache"
TRIPOSR_REPO = "https://github.com/VAST-AI-Research/TripoSR"
TRIPOSR_REV = "107cefdc244c39106fa830359024f6a2f1c78871"
WEIGHTS_REPO = "stabilityai/TripoSR"
WEIGHTS_REV = "5b521936b01fbe1890f6f9baed0254ab6351c04a"

# Modal list prices behind the cost estimate (USD / second), as in modal_lhm.py.
L4_PER_S, CPU_CORE_PER_S, GIB_PER_S = 0.000222, 0.0000131, 0.00000222
GPU_CPU, GPU_MEM_GIB = 4, 16

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git", "libgl1", "libglib2.0-0")
    .env({"PYTHONUNBUFFERED": "1", "HF_HOME": "/cache/huggingface", "U2NET_HOME": "/cache/u2net"})
    # torch wheels from PyPI carry their CUDA 12.1 runtime; Modal provides the driver
    .uv_pip_install("torch==2.3.1", "numpy==1.26.4")
    .uv_pip_install(
        "numpy==1.26.4",
        # TripoSR's own pins
        "omegaconf==2.3.0",
        "Pillow==10.1.0",
        "einops==0.7.0",
        "transformers==4.35.0",
        "trimesh==4.0.5",
        "huggingface-hub==0.17.3",
        "imageio==2.34.1",
        # background removal, marching cubes, cleanup, decimation
        "rembg>=2.0.50,<2.1",
        "onnxruntime==1.18.1",
        "scikit-image==0.22.0",
        "scipy==1.13.1",
        "networkx==3.3",
        "fast-simplification>=0.1.7,<0.2",
    )
    .run_commands(
        f"git clone --filter=blob:none {TRIPOSR_REPO} /opt/triposr",
        f"cd /opt/triposr && git checkout {TRIPOSR_REV}",
    )
    .add_local_file(str(HERE / "prop_glb.py"), "/opt/prop/prop_glb.py")
)

app = modal.App(APP_NAME)
cache = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


def install_mcubes_shim():
    """TripoSR imports ``torchmcubes`` (a CUDA extension built from source). Same contract here
    through scikit-image: (vertices in (i2, i1, i0) grid order, faces), as torch tensors."""
    import types

    import numpy as np
    import torch
    from skimage import measure

    def marching_cubes(volume, threshold):
        vol = volume.detach().float().cpu().numpy()
        if not (vol.min() <= threshold <= vol.max()):
            raise RuntimeError("the reconstruction has no surface (empty density field)")
        verts, faces, _normals, _values = measure.marching_cubes(vol, level=float(threshold))
        verts = np.ascontiguousarray(verts[:, ::-1])  # TripoSR swaps these back with [2, 1, 0]
        return torch.from_numpy(verts).float(), torch.from_numpy(faces.astype(np.int64))

    shim = types.ModuleType("torchmcubes")
    shim.marching_cubes = marching_cubes
    sys.modules["torchmcubes"] = shim


def keep_main_pieces(mesh, min_share=0.05):
    """Drops floaters: connected pieces with fewer than `min_share` of the largest piece's faces."""
    import trimesh

    parts = mesh.split(only_watertight=False)
    if len(parts) <= 1:
        return mesh
    biggest = max(len(p.faces) for p in parts)
    kept = [p for p in parts if len(p.faces) >= min_share * biggest]
    return trimesh.util.concatenate(kept)


@app.function(
    image=image,
    gpu="L4",
    cpu=GPU_CPU,
    memory=GPU_MEM_GIB * 1024,
    timeout=900,
    retries=0,
    max_containers=1,
    volumes={"/cache": cache},
    scaledown_window=2,
)
def prop(image_png: bytes, resolution: int = 256, max_faces: int = 50000, foreground_ratio: float = 0.85) -> dict:
    """One object picture -> {glb: bytes, faces, vertices, seconds, timings, estimatedComputeUSD}."""
    import io
    import os

    t0 = time.time()
    timings = {}

    def log(message):
        print(f"[prop] {message}", flush=True)

    def mark(name, since):
        timings[name] = round(time.time() - since, 2)
        return time.time()

    sys.path.insert(0, "/opt/triposr")
    sys.path.insert(0, "/opt/prop")
    install_mcubes_shim()
    import numpy as np
    import torch
    import trimesh
    from huggingface_hub import hf_hub_download
    from PIL import Image

    import prop_glb

    t = time.time()
    log("loading TripoSR (the first run downloads 1.7 GB of weights)")
    import rembg
    from tsr.system import TSR
    from tsr.utils import remove_background, resize_foreground

    config = hf_hub_download(WEIGHTS_REPO, "config.yaml", revision=WEIGHTS_REV)
    hf_hub_download(WEIGHTS_REPO, "model.ckpt", revision=WEIGHTS_REV)
    model = TSR.from_pretrained(os.path.dirname(config), config_name="config.yaml", weight_name="model.ckpt")
    model.renderer.set_chunk_size(8192)
    model.to("cuda")
    session = rembg.new_session("u2net")
    cache.commit()
    t = mark("load", t)

    log("cutting the object out of the picture")
    picture = Image.open(io.BytesIO(image_png)).convert("RGB")
    cut = resize_foreground(remove_background(picture, session), foreground_ratio)
    rgba = np.asarray(cut).astype(np.float32) / 255.0
    rgb = rgba[:, :, :3] * rgba[:, :, 3:4] + (1 - rgba[:, :, 3:4]) * 0.5  # TripoSR wants mid grey
    cond = Image.fromarray((rgb * 255.0).astype(np.uint8))
    t = mark("matte", t)

    log("reconstructing the object (TripoSR)")
    with torch.no_grad():
        codes = model([cond], device="cuda")
    t = mark("reconstruct", t)

    log("extracting the surface")
    mesh = model.extract_mesh(codes, False, resolution=resolution)[0]
    raw_faces = len(mesh.faces)
    mesh = keep_main_pieces(mesh)
    vertices, faces = np.asarray(mesh.vertices), np.asarray(mesh.faces)
    if len(faces) > max_faces:
        try:
            import fast_simplification

            vertices, faces = fast_simplification.simplify(
                vertices.astype(np.float32), faces.astype(np.int32), target_reduction=1.0 - max_faces / len(faces)
            )
        except Exception as error:  # noqa: BLE001 - a heavier model is still a model
            log(f"decimation skipped ({type(error).__name__}: {error})")
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=True)
    vertices, faces = np.asarray(mesh.vertices), prop_glb.outward(np.asarray(mesh.vertices), np.asarray(mesh.faces))
    t = mark("surface", t)

    log("colouring the surface")
    with torch.no_grad():
        color = model.renderer.query_triplane(
            model.decoder, torch.tensor(vertices, dtype=torch.float32, device="cuda"), codes[0]
        )["color"]
    colors = prop_glb.srgb_to_linear(color.float().cpu().numpy())
    upright, leveled = prop_glb.triposr_to_gltf(vertices), 0.0
    try:
        # the picture is taken a little from above: stand the object back up on its flat face
        upright, leveled = prop_glb.level(upright)
        if leveled:
            log(f"levelled: pitched back {leveled:.1f} degrees")
    except Exception as error:  # noqa: BLE001 - a leaning model is still a model
        log(f"levelling skipped ({type(error).__name__}: {error})")
    glb = prop_glb.write_glb(upright, faces, colors, name="generated-prop")
    t = mark("package", t)

    seconds = time.time() - t0
    cost = seconds * (L4_PER_S + GPU_CPU * CPU_CORE_PER_S + GPU_MEM_GIB * GIB_PER_S)
    log(f"done: {len(faces)} triangles ({raw_faces} before cleanup), {len(glb)} bytes in {seconds:.1f}s")
    buf = io.BytesIO()
    cond.save(buf, format="PNG")
    return {
        "glb": glb,
        "cutout": buf.getvalue(),
        "faces": int(len(faces)),
        "rawFaces": int(raw_faces),
        "vertices": int(len(vertices)),
        "leveledDeg": round(leveled, 1),
        "seconds": round(seconds, 2),
        "timings": timings,
        "estimatedComputeUSD": round(cost, 5),
        "model": f"TripoSR {TRIPOSR_REV[:7]} / weights {WEIGHTS_REV[:7]}",
        "gpu": "L4",
    }


@app.function(image=image, cpu=1, memory=4096, timeout=600, volumes={"/cache": cache})
def check() -> dict:
    """Image build + imports + what the Volume holds; no GPU."""
    import os

    sys.path.insert(0, "/opt/triposr")
    sys.path.insert(0, "/opt/prop")
    install_mcubes_shim()
    import fast_simplification  # noqa: F401
    import rembg  # noqa: F401
    import torch
    from tsr.system import TSR  # noqa: F401

    import prop_glb  # noqa: F401

    hub = "/cache/huggingface/hub"
    return {
        "ok": True,
        "torch": torch.__version__,
        "triposr": TRIPOSR_REV,
        "weightsCached": os.path.isdir(f"{hub}/models--stabilityai--TripoSR"),
        "u2netCached": os.path.isfile("/cache/u2net/u2net.onnx"),
    }
