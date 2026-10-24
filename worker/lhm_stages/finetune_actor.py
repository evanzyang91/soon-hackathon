#!/usr/bin/env python3
"""Short photometric fine-tune of an LHM avatar against its own reference image ("high detail").

LHM predicts the canonical gaussians in one feed-forward pass, so fine texture (face, print,
seams) comes out softer than the reference photo it was built from. This stage renders the
avatar at the Multi-HMR source pose into the source camera, compares it with the reference and
optimises the canonical gaussians for a bounded number of steps (Orbis-style, after
``scripts/finetune_gsplat.py``: masked L1 + 0.2 D-SSIM, a quadratic tether of positions / log
scales to their LHM values, a hard clamp on the displacement, nothing densified or pruned):

    colour      rgb (clamped to [0, 1], what every viewer displays)
    opacity     logit
    scale       log, tethered, clamped to LHM's clip (0.05)
    position    canonical offset, tethered, clamped to +-1 cm (native SMPL-X metres)

Rotations, skinning and the gaussian count are untouched, so the frozen PLY, the baked frames and
the runtime rig are produced from the fine-tuned state exactly as from LHM's own (lhm_actor.py
just continues with the updated ``attrs``). Splats the source view never sees get no photometric
gradient and stay LHM's (back, soles); the turn-view drift is measured and reported.

Posing is affine in the canonical offset (LHM's LBS uses fixed per-gaussian weights), so the loop
does not call LHM at all: the posed position is ``base + M_i @ offset`` with ``M_i`` measured once
by finite differences through ``model.animation_infer_gs`` (the residual is recorded). Rendering
uses the same diff-gaussian-rasterization LHM renders with.

The source camera is Multi-HMR's (fov 60 on a 20 %-padded, 896-px letterboxed copy of the
reference); `source_camera` maps it to reference pixels. The rasteriser assumes a centred
principal point, so the render window is centred on it (`render_window`).

numpy helpers at the top are pure and unit tested (worker/tests/test_finetune.py); `finetune`
needs CUDA, torch and the LHM checkout.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

SSIM_WEIGHT = 0.2
HEAD_WEIGHT = 3.0
ALPHA_WEIGHT = 0.1
SCALE_CLIP = 0.05  # LHM GSLayer clip_scaling at inference (hyper_step to the max step)


# ---------------------------------------------------------------------------------------------
# Camera geometry (pure)
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SourceCamera:
    """Pinhole intrinsics of the Multi-HMR source camera in reference-image pixels."""

    fx: float
    fy: float
    cx: float
    cy: float
    width: int
    height: int


def estimator_annotation(raw_w: int, raw_h: int, img_size: int = 896, pad_ratio: float = 0.2):
    """What PoseEstimator.img_center_padding + _preprocess do to a raw_w x raw_h image:
    (offset_w, offset_h, pad_left, pad_top, scale_factor)."""
    w, h = round((1 + pad_ratio) * raw_w), round((1 + pad_ratio) * raw_h)
    offset_h, offset_w = (h - raw_h) // 2, (w - raw_w) // 2
    factor = min(img_size / w, img_size / h)
    # F.interpolate(scale_factor=f) -> floor(size * f)
    rw, rh = math.floor(w * factor), math.floor(h * factor)
    return offset_w, offset_h, (img_size - rw) // 2, (img_size - rh) // 2, factor


def source_camera(raw_w, raw_h, annotation=None, img_size: int = 896, fov_deg: float = 60.0) -> SourceCamera:
    """Multi-HMR's K (focal img_size / (2 tan(fov/2)), centre img_size // 2) in raw pixels:
    u_raw = (u_896 - pad_left) / factor - offset_w (LHM's own j2d mapping)."""
    offset_w, offset_h, pad_left, pad_top, factor = annotation or estimator_annotation(raw_w, raw_h, img_size)
    f = img_size / (2 * math.tan(math.radians(fov_deg) / 2))
    c = img_size // 2
    return SourceCamera(
        fx=f / factor,
        fy=f / factor,
        cx=(c - pad_left) / factor - offset_w,
        cy=(c - pad_top) / factor - offset_h,
        width=int(raw_w),
        height=int(raw_h),
    )


def project(cam: SourceCamera, xyz: np.ndarray) -> np.ndarray:
    """OpenCV camera-frame points (x right, y down, z forward) -> reference pixels."""
    z = np.maximum(xyz[:, 2], 1e-6)
    return np.stack([cam.fx * xyz[:, 0] / z + cam.cx, cam.fy * xyz[:, 1] / z + cam.cy], 1)


@dataclass(frozen=True)
class Window:
    """A render window centred on the principal point: reference pixel (x0 + i / s, y0 + j / s)
    is render pixel (i, j); `s` downsamples large windows."""

    x0: int
    y0: int
    width: int  # in reference pixels
    height: int
    scale: float

    @property
    def size(self) -> tuple[int, int]:
        return round(self.width * self.scale), round(self.height * self.scale)


def render_window(cam: SourceCamera, box, margin: float = 0.06, max_side: int = 1280) -> Window:
    """Smallest window centred on (cx, cy) covering `box` (x0, y0, x1, y1) plus `margin` of its
    size; rendered at most `max_side` pixels tall/wide."""
    bx0, by0, bx1, by1 = box
    m = margin * max(bx1 - bx0, by1 - by0)
    hw = max(cam.cx - (bx0 - m), (bx1 + m) - cam.cx, 16)
    hh = max(cam.cy - (by0 - m), (by1 + m) - cam.cy, 16)
    w, h = 2 * math.ceil(hw), 2 * math.ceil(hh)
    scale = min(1.0, max_side / max(w, h))
    return Window(x0=round(cam.cx - w / 2), y0=round(cam.cy - h / 2), width=w, height=h, scale=scale)


def window_intrinsics(cam: SourceCamera, win: Window) -> tuple[float, float, int, int]:
    """(fx, fy, width, height) of the window render; its principal point is the centre."""
    w, h = win.size
    return cam.fx * win.scale, cam.fy * win.scale, w, h


def crop_to_window(image: np.ndarray, win: Window, fill) -> np.ndarray:
    """Reference pixels inside `win` (outside the image: `fill`), resampled to `win.size`."""
    h, w = image.shape[:2]
    out = np.empty((win.height, win.width) + image.shape[2:], dtype=image.dtype)
    out[...] = fill
    sx0, sy0 = max(0, win.x0), max(0, win.y0)
    sx1, sy1 = min(w, win.x0 + win.width), min(h, win.y0 + win.height)
    if sx1 > sx0 and sy1 > sy0:
        out[sy0 - win.y0 : sy1 - win.y0, sx0 - win.x0 : sx1 - win.x0] = image[sy0:sy1, sx0:sx1]
    size = win.size
    if size != (win.width, win.height):
        import cv2

        out = cv2.resize(out, size, interpolation=cv2.INTER_AREA)
    return out


def json_safe(value):
    """Reports go into sequence.json, which browsers JSON.parse: no NaN / Infinity."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def box_of(mask: np.ndarray, threshold: float = 0.5):
    ys, xs = np.where(mask > threshold)
    if not len(xs):
        return None
    return float(xs.min()), float(ys.min()), float(xs.max() + 1), float(ys.max() + 1)


def iou(a: np.ndarray, b: np.ndarray, threshold: float = 0.5) -> float:
    a, b = a > threshold, b > threshold
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


def masked_psnr(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    """PSNR (dB) over pixels where mask > 0.5; images in [0, 1], H x W x 3."""
    sel = mask > 0.5
    if not sel.any():
        return float("nan")
    mse = float(((a[sel] - b[sel]) ** 2).mean())
    return 10 * math.log10(1 / max(mse, 1e-10))


def similarity_fix(render_box, mask_box) -> tuple[float, float, float]:
    """(s, du, dv) with u' = s * u + du mapping the rendered silhouette's box onto the mask's
    (same height, same centre): a weak-perspective correction of the focal / principal point."""
    rx0, ry0, rx1, ry1 = render_box
    mx0, my0, mx1, my1 = mask_box
    s = (my1 - my0) / max(ry1 - ry0, 1e-6)
    return s, (mx0 + mx1) / 2 - s * (rx0 + rx1) / 2, (my0 + my1) / 2 - s * (ry0 + ry1) / 2


def corrected(cam: SourceCamera, fix) -> SourceCamera:
    s, du, dv = fix
    return SourceCamera(cam.fx * s, cam.fy * s, cam.cx * s + du, cam.cy * s + dv, cam.width, cam.height)


# ---------------------------------------------------------------------------------------------
# GPU fine-tune (torch + LHM)
# ---------------------------------------------------------------------------------------------


def _ssim(x, y, win):
    import torch.nn.functional as F

    c1, c2 = 0.01**2, 0.03**2
    mu_x = F.conv2d(x, win, padding=5, groups=3)
    mu_y = F.conv2d(y, win, padding=5, groups=3)
    sxx = F.conv2d(x * x, win, padding=5, groups=3) - mu_x**2
    syy = F.conv2d(y * y, win, padding=5, groups=3) - mu_y**2
    sxy = F.conv2d(x * y, win, padding=5, groups=3) - mu_x * mu_y
    return ((2 * mu_x * mu_y + c1) * (2 * sxy + c2)) / ((mu_x**2 + mu_y**2 + c1) * (sxx + syy + c2))


def _gaussian_window(dev, size=11, sigma=1.5):
    import torch

    g = torch.arange(size, dtype=torch.float32, device=dev) - size // 2
    g = torch.exp(-g * g / (2 * sigma * sigma))
    g = g / g.sum()
    return (g[:, None] * g[None, :])[None, None].repeat(3, 1, 1, 1)


class Rasterizer:
    """diff-gaussian-rasterization (what LHM renders with) for one pinhole camera at the origin
    of the OpenCV camera frame, principal point at the image centre."""

    def __init__(self, fx, fy, width, height, dev, bg=(1.0, 1.0, 1.0)):
        import torch
        from diff_gaussian_rasterization import GaussianRasterizationSettings, GaussianRasterizer

        self.width, self.height = int(width), int(height)
        fovx, fovy = 2 * math.atan(width / (2 * fx)), 2 * math.atan(height / (2 * fy))
        znear, zfar = 0.01, 100.0
        tx, ty = math.tan(fovx / 2), math.tan(fovy / 2)
        P = torch.zeros(4, 4, device=dev)
        P[0, 0], P[1, 1] = 1 / tx, 1 / ty
        P[3, 2], P[2, 2], P[2, 3] = 1.0, zfar / (zfar - znear), -(zfar * znear) / (zfar - znear)
        view = torch.eye(4, device=dev)  # world = camera frame
        full = (view.unsqueeze(0).bmm(P.T.unsqueeze(0))).squeeze(0)
        self.settings = GaussianRasterizationSettings(
            image_height=self.height,
            image_width=self.width,
            tanfovx=tx,
            tanfovy=ty,
            bg=torch.tensor(bg, dtype=torch.float32, device=dev),
            scale_modifier=1.0,
            viewmatrix=view,
            projmatrix=full,
            sh_degree=0,
            campos=torch.zeros(3, device=dev),
            prefiltered=False,
            debug=False,
        )
        self.raster = GaussianRasterizer(raster_settings=self.settings)

    def __call__(self, xyz, rgb, opacity, scaling, rotation, bg=None, depth=False):
        import torch
        from diff_gaussian_rasterization import GaussianRasterizer

        raster = self.raster if bg is None else GaussianRasterizer(raster_settings=self.settings._replace(bg=bg))
        means2d = torch.zeros_like(xyz, requires_grad=True)
        image, radii, d, alpha = raster(
            means3D=xyz,
            means2D=means2d,
            shs=None,
            colors_precomp=rgb,
            opacities=opacity,
            scales=scaling,
            rotations=rotation,
            cov3D_precomp=None,
        )
        if depth:  # accumulated sum(T a z): divide by alpha for the surface depth
            return image, alpha, radii, d
        return image, alpha, radii  # [3,H,W], [1,H,W], [N]


def surface_normals(xyz, k: int = 16, chunk: int = 2048):
    """Unit normals of a point cloud by local PCA (smallest-variance axis of the k nearest)."""
    import torch

    out = torch.empty_like(xyz)
    for i in range(0, len(xyz), chunk):
        part = xyz[i : i + chunk]
        idx = torch.cdist(part, xyz).topk(k, largest=False).indices  # [c, k]
        nb = xyz[idx] - xyz[idx].mean(1, keepdim=True)
        cov = nb.transpose(1, 2) @ nb
        out[i : i + chunk] = torch.linalg.eigh(cov).eigenvectors[..., 0]
    return out


def observed_weights(xyz, alpha, depth, mask, fx, fy, tol: float = 0.03, erode_px: int = 4):
    """How much each splat may change, 0..1: it must be the front-most surface at its pixel
    (camera z within `tol` of the rendered surface depth), land inside the reference mask eroded by
    `erode_px`, and face the camera (weight fades from |cos| 0.25 to 0.6, so splats seen edge-on,
    whose painted texture would smear from the side, stay LHM's)."""
    import torch
    import torch.nn.functional as F

    _, h, w = alpha.shape
    z = xyz[:, 2].clamp(min=1e-4)
    u = (fx * xyz[:, 0] / z + (w - 1) / 2).round().long()
    v = (fy * xyz[:, 1] / z + (h - 1) / 2).round().long()
    inside = (u >= 0) & (u < w) & (v >= 0) & (v < h)
    uc, vc = u.clamp(0, w - 1), v.clamp(0, h - 1)
    m = mask[None, None]
    if erode_px > 0:  # erosion = 1 - dilation of the complement
        m = 1 - F.max_pool2d(1 - m, 2 * erode_px + 1, stride=1, padding=erode_px)
    m = m[0, 0]
    a = alpha[0][vc, uc]
    surface = depth[0][vc, uc] / a.clamp(min=1e-6)
    front = inside & (m[vc, uc] > 0.5) & (a > 0.5) & (z <= surface + tol)
    n = surface_normals(xyz)
    cos = (n * (-xyz / xyz.norm(dim=1, keepdim=True))).sum(1).abs()
    facing = ((cos - 0.25) / 0.35).clamp(0, 1)
    return front.float() * facing, front, cos


def posed_basis(model, attrs, query, params, probe: float = 0.01) -> dict:
    """Posed gaussians at `params` plus d(posed xyz)/d(canonical offset) per gaussian (3x3), by
    finite differences through LHM itself; `affineError` = max |prediction - LHM| for a random
    offset (posing is affine in the offset, so this is float noise)."""
    import dataclasses

    import torch

    gs = attrs[0]

    def pose(offset):
        a = dataclasses.replace(gs, offset_xyz=offset)
        with torch.no_grad():
            return model.animation_infer_gs([a], query, params)

    base = pose(gs.offset_xyz)
    cols = []
    for k in range(3):
        e = torch.zeros_like(gs.offset_xyz)
        e[:, k] = probe
        cols.append((pose(gs.offset_xyz + e).xyz - base.xyz) / probe)
    M = torch.stack(cols, -1)  # [N, 3, 3]
    r = (torch.rand_like(gs.offset_xyz) - 0.5) * 0.01
    pred = base.xyz + (M @ r[..., None])[..., 0]
    err = float((pose(gs.offset_xyz + r).xyz - pred).abs().max())
    return dict(
        xyz=base.xyz.detach().clone(),
        M=M.detach().clone(),
        rotation=torch.nn.functional.normalize(base.rotation.detach().clone(), dim=-1),
        scaling=gs.scaling.detach().clone(),
        opacity=gs.opacity.detach().clone(),
        rgb=gs.shs.detach().clone().reshape(-1, 3),
        affineError=err,
    )


def _turn(xyz, M, center, deg):
    """Rotate posed points about the camera-frame vertical (y) axis through `center`."""
    import torch

    a = math.radians(deg)
    R = torch.tensor([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]], device=xyz.device, dtype=xyz.dtype)
    return (xyz - center) @ R.T + center, R


def _quat_of(R):
    """3x3 rotation -> (w, x, y, z)."""
    import torch

    m = R
    w = torch.sqrt(torch.clamp(1 + m[0, 0] + m[1, 1] + m[2, 2], min=1e-12)) / 2
    return torch.stack([w, (m[2, 1] - m[1, 2]) / (4 * w), (m[0, 2] - m[2, 0]) / (4 * w), (m[1, 0] - m[0, 1]) / (4 * w)])


def _qmul(a, b):
    import torch

    aw, ax, ay, az = a.unbind(-1)
    bw, bx, by, bz = b.unbind(-1)
    return torch.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        -1,
    )


def finetune(
    model,
    attrs,
    query,
    params,
    reference: np.ndarray,
    mask: np.ndarray,
    annotation,
    out_dir,
    head_box=None,
    iters: int = 600,
    seconds: float = 100.0,
    clamp_pos: float = 0.01,
    sigma_pos: float = 0.004,
    sigma_scale: float = 0.3,
    lambda_reg: float = 0.02,
    sigma_color: float = 0.2,
    lambda_color: float = 0.01,
    min_iou: float = 0.6,
    log=print,
):
    """Fine-tunes `attrs` (LHM's canonical GaussianAppOutput list) in place against `reference`
    (H x W x 3 uint8) / `mask` (H x W, 0/255, the dilated LHM input mask). Returns the report.
    When the source-view silhouette cannot be aligned (IoU < `min_iou`), nothing changes and the
    report says why."""
    import dataclasses
    from pathlib import Path

    import torch
    from PIL import Image

    t0 = time.time()
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    dev = query.device
    h, w = mask.shape
    cam = source_camera(w, h, annotation)
    basis = posed_basis(model, attrs, query, params)
    xyz0, M, rot, sc0, op0, rgb0 = (basis[k].float() for k in ("xyz", "M", "rotation", "scaling", "opacity", "rgb"))
    n = len(xyz0)
    mbox = box_of(mask / 255.0)
    if mbox is None:
        raise ValueError("empty reference mask")

    def render_at(c: SourceCamera, xyz, rgb, op, sc, rotation=rot):
        win = render_window(c, mbox)
        fx, fy, rw, rh = window_intrinsics(c, win)
        r = Rasterizer(fx, fy, rw, rh, dev)
        # the window is centred on the principal point: shift nothing, just render
        return r(xyz, rgb.clamp(0, 1), op, sc, rotation), win

    # --- alignment of the source camera with the reference silhouette -------------------------
    with torch.no_grad():
        (img, alpha, _), win = render_at(cam, xyz0, rgb0, op0, sc0)
    target_mask = crop_to_window(mask.astype(np.float32) / 255.0, win, 0.0)
    a_np = alpha[0].cpu().numpy()
    iou0 = iou(a_np, target_mask)
    fix = (1.0, 0.0, 0.0)
    if iou0 < 0.9:
        rb = box_of(a_np)
        if rb is not None:
            # boxes in reference pixels
            to_ref = lambda b: (win.x0 + b[0] / win.scale, win.y0 + b[1] / win.scale, win.x0 + b[2] / win.scale, win.y0 + b[3] / win.scale)  # noqa: E731
            fix = similarity_fix(to_ref(rb), mbox)
            cam2 = corrected(cam, fix)
            with torch.no_grad():
                (img2, alpha2, _), win2 = render_at(cam2, xyz0, rgb0, op0, sc0)
            tm2 = crop_to_window(mask.astype(np.float32) / 255.0, win2, 0.0)
            iou2 = iou(alpha2[0].cpu().numpy(), tm2)
            if iou2 > iou0:
                cam, win, target_mask, iou0 = cam2, win2, tm2, iou2
            else:
                fix = (1.0, 0.0, 0.0)
    report = dict(
        method="photometric fine-tune vs the reference at the source pose (L1 + 0.2 D-SSIM over a random "
        "background, head x3, alpha 0.1) on the splats the reference shows (front-most, inside the mask, "
        "facing the camera, not the hands); tethered colour / positions, scales shrink only, +-1 cm clamp",
        splats=n,
        camera=dict(fx=cam.fx, fy=cam.fy, cx=cam.cx, cy=cam.cy, similarityFix=list(fix)),
        window=dict(x0=win.x0, y0=win.y0, width=win.width, height=win.height, scale=win.scale),
        affineError=basis["affineError"],
        silhouetteIoU=iou0,
    )
    if iou0 < min_iou:
        report.update(applied=False, reason=f"source-view silhouette IoU {iou0:.2f} < {min_iou}: camera not aligned, LHM output kept")
        report["seconds"] = time.time() - t0
        log(f"fine-tune skipped: {report['reason']}")
        return json_safe(report)

    ref = crop_to_window(reference.astype(np.float32) / 255.0, win, 1.0)
    target = torch.from_numpy(ref).permute(2, 0, 1).float().to(dev)
    tmask = torch.from_numpy(target_mask).float().to(dev)[None]
    weight = torch.ones_like(tmask)
    if head_box is not None:
        hx0, hy0, hx1, hy1 = head_box
        i0, i1 = round((hx0 - win.x0) * win.scale), round((hx1 - win.x0) * win.scale)
        j0, j1 = round((hy0 - win.y0) * win.scale), round((hy1 - win.y0) * win.scale)
        weight[:, max(0, j0) : max(0, j1), max(0, i0) : max(0, i1)] = HEAD_WEIGHT
    weight = weight / weight.mean()
    fx, fy, rw, rh = window_intrinsics(cam, win)
    raster = Rasterizer(fx, fy, rw, rh, dev)
    ssim_win = _gaussian_window(dev)

    # which splats the reference really shows (front-most, inside the mask, not edge-on)
    with torch.no_grad():
        img_w, alpha_w, _, depth_w = raster(xyz0, rgb0.clamp(0, 1), op0, sc0, rot, depth=True)
        free, front, cos = observed_weights(xyz0, alpha_w, depth_w, tmask[0], fx, fy)
    # hands stay LHM's: a reference hand pose never matches the SMPL-X fingers closely enough, and
    # painting the photo onto them shows as pale streaks from the side
    sm = model.renderer.smplx_model
    hands = torch.zeros(n, dtype=torch.bool, device=dev)
    for name in ("is_lhand", "is_rhand"):
        part = getattr(sm, name, None)
        if part is not None and part.numel() == n:
            hands |= part.to(dev).bool().reshape(n)
    free = free * (~hands).float()
    free = free[:, None]
    geo = (free > 0.5).float()  # positions / scales move only on clearly facing splats

    d_off = torch.zeros(n, 3, device=dev, requires_grad=True)
    d_ls = torch.zeros(n, 3, device=dev, requires_grad=True)
    d_op = torch.zeros(n, 1, device=dev, requires_grad=True)
    d_rgb = torch.zeros(n, 3, device=dev, requires_grad=True)
    logit0 = torch.logit(op0.clamp(1e-4, 1 - 1e-4))
    logs0 = torch.log(sc0.clamp(min=1e-7))
    groups = [
        dict(params=[d_rgb], lr=5e-3),
        dict(params=[d_op], lr=5e-3),
        dict(params=[d_ls], lr=3e-3),
        dict(params=[d_off], lr=1e-4),
    ]
    opt = torch.optim.Adam(groups, eps=1e-15)
    base_lr = [g["lr"] for g in opt.param_groups]

    def state():
        off = (M @ (d_off * geo)[..., None])[..., 0]
        return (
            xyz0 + off,
            (rgb0 + d_rgb * free).clamp(0, 1),
            torch.sigmoid(logit0 + d_op * free),
            torch.exp(logs0 + d_ls * geo).clamp(max=SCALE_CLIP),
        )

    fg = target * tmask  # reference person; the background is re-coloured every step
    white = torch.ones(3, device=dev)

    def losses(img, alpha, bg=white):
        tgt = fg + bg[:, None, None] * (1 - tmask)
        l1 = ((img - tgt).abs() * weight).mean()
        ssim = (_ssim(img[None], tgt[None], ssim_win)[0] * weight).mean()
        a = ((alpha - tmask).abs() * weight).mean()
        return l1, ssim, a

    with torch.no_grad():
        before_img, before_alpha, _ = raster(*state(), rot)
        l1b, ssimb, ab = losses(before_img, before_alpha)
    steps = 0
    t_loop = time.time()
    history = []
    gen = torch.Generator(device=dev).manual_seed(0)
    for it in range(iters):
        frac = it / max(1, iters - 1)
        for g, lr in zip(opt.param_groups, base_lr):
            g["lr"] = lr * (0.1 + 0.9 * 0.5 * (1 + math.cos(math.pi * frac)))
        # a random background each step: splats outside the person must turn transparent instead
        # of learning the studio white
        bg = torch.rand(3, device=dev, generator=gen)
        xyz, rgb, op, sc = state()
        img, alpha, _ = raster(xyz, rgb, op, sc, rot, bg=bg)
        l1, ssim, a = losses(img, alpha, bg)
        reg = (d_off.pow(2).sum(1) / sigma_pos**2 + d_ls.pow(2).sum(1) / sigma_scale**2).mean()
        creg = (d_rgb.pow(2).sum(1) / sigma_color**2).mean()
        loss = l1 + SSIM_WEIGHT * (1 - ssim) + ALPHA_WEIGHT * a + lambda_reg * reg + lambda_color * creg
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        with torch.no_grad():
            d_off.clamp_(-clamp_pos, clamp_pos)
            # shrink only: growth along the view axis is invisible here and streaks from the side
            d_ls.clamp_(-1.0, 0.0)
            d_rgb.clamp_(-0.5, 0.5)
        steps += 1
        if it % 100 == 0 or it == iters - 1:
            history.append(dict(step=it, l1=float(l1), ssim=float(ssim), alpha=float(a), reg=float(reg), colorReg=float(creg)))
            log(f"fine-tune step {it}: L1 {float(l1):.4f} SSIM {float(ssim):.4f} alpha {float(a):.4f}")
        if time.time() - t_loop > seconds:
            log(f"fine-tune: time budget {seconds:.0f}s reached at step {it}")
            break
    loop_s = time.time() - t_loop

    with torch.no_grad():
        xyz, rgb, op, sc = state()
        after_img, after_alpha, _ = raster(xyz, rgb, op, sc, rot)
        l1a, ssima, aa = losses(after_img, after_alpha)
        to_np = lambda t: t.permute(1, 2, 0).clamp(0, 1).cpu().numpy()  # noqa: E731
        white_target = fg + (1 - tmask)
        tgt_np, b_np, a_np = to_np(white_target), to_np(before_img), to_np(after_img)
        psnr_b, psnr_a = masked_psnr(b_np, tgt_np, target_mask), masked_psnr(a_np, tgt_np, target_mask)
        # turn views: how much did what the reference cannot see change? (mean |after - before|
        # over the body's pixels, 0..1 per channel)
        center = xyz0[front].median(0).values if front.any() else xyz0.median(0).values
        turns = {}
        strips = []
        for deg in (35.0, -35.0, 180.0):
            pb, R = _turn(xyz0, M, center, deg)
            pa, _ = _turn(xyz, M, center, deg)
            q = _quat_of(R)[None].expand(n, 4)
            rr = _qmul(q, rot)
            ib, ab_t, _ = raster(pb, rgb0.clamp(0, 1), op0, sc0, rr)
            ia, _, _ = raster(pa, rgb, op, sc, rr)
            body = (ab_t[0] > 0.5).float()
            turns[f"{deg:+.0f}"] = float(((ia - ib).abs().mean(0) * body).sum() / body.sum().clamp(min=1))
            strips.append((to_np(ib), to_np(ia)))
        dpos = (M @ (d_off * geo)[..., None])[..., 0].norm(dim=1)
        new_scaling = sc
        new_opacity = op
        new_rgb = rgb

    # write back into LHM's canonical attributes (posing applies M to the offset)
    gs = attrs[0]
    attrs[0] = dataclasses.replace(
        gs,
        offset_xyz=(gs.offset_xyz + d_off.detach()).to(gs.offset_xyz.dtype),
        scaling=new_scaling.detach().to(gs.scaling.dtype),
        opacity=new_opacity.detach().to(gs.opacity.dtype),
        shs=new_rgb.detach().reshape(gs.shs.shape).to(gs.shs.dtype),
    )

    u8 = lambda x: (np.clip(x, 0, 1) * 255).round().astype(np.uint8)  # noqa: E731
    Image.fromarray(np.concatenate([u8(tgt_np), u8(b_np), u8(a_np)], 1)).save(out_dir / "finetune-source.png")
    Image.fromarray(
        np.concatenate([np.concatenate([u8(b), u8(a)], 0) for b, a in strips], 1)
    ).save(out_dir / "finetune-turns.png")
    report.update(
        applied=True,
        iterations=steps,
        loopSeconds=loop_s,
        seconds=time.time() - t0,
        observedSplats=int(front.sum()),
        freeSplats=int((free[:, 0] > 0.5).sum()),
        handSplatsKept=int(hands.sum()),
        meanFacingCos=float(cos[front].mean()) if front.any() else None,
        sourceView=dict(
            psnrBefore=psnr_b,
            psnrAfter=psnr_a,
            l1Before=float(l1b),
            l1After=float(l1a),
            ssimBefore=float(ssimb),
            ssimAfter=float(ssima),
            alphaBefore=float(ab),
            alphaAfter=float(aa),
        ),
        turnViewMeanAbsChange=turns,
        displacement=dict(
            meanMm=float(dpos.mean() * 1000), p99Mm=float(dpos.quantile(0.99) * 1000), maxMm=float(dpos.max() * 1000)
        ),
        history=history,
        images=["finetune-source.png (reference | LHM | fine-tuned)", "finetune-turns.png (+35, -35, back: LHM over fine-tuned)"],
    )
    log(
        f"fine-tune: {steps} steps in {loop_s:.1f}s, source-view PSNR {psnr_b:.2f} -> {psnr_a:.2f} dB, "
        f"turn-view change {turns}"
    )
    return json_safe(report)
