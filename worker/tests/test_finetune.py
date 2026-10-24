"""The fine-tune's camera geometry (pure numpy; the GPU loop itself is exercised on Modal)."""

import math

import numpy as np
import pytest

from lhm_stages import finetune_actor as ft


def lhm_j2d_to_raw(u896, v896, annotation):
    """LHM's own mapping (PoseEstimator.__call__): (j2d - pad) / factor - offset."""
    offset_w, offset_h, pad_left, pad_top, factor = annotation
    return (u896 - pad_left) / factor - offset_w, (v896 - pad_top) / factor - offset_h


def test_estimator_annotation_matches_the_padding_arithmetic_for_a_1024x1536_reference():
    offset_w, offset_h, pad_left, pad_top, factor = ft.estimator_annotation(1024, 1536)
    # 20 % padding -> 1229 x 1843, letterboxed into 896 by height
    assert (offset_w, offset_h) == (102, 153)
    assert factor == pytest.approx(896 / 1843)
    assert (pad_left, pad_top) == ((896 - math.floor(1229 * factor)) // 2, 0)


def test_source_camera_reproduces_lhm_projection_into_reference_pixels():
    ann = ft.estimator_annotation(1024, 1536)
    cam = ft.source_camera(1024, 1536, ann)
    f896 = 896 / (2 * math.tan(math.radians(30)))
    pts = np.array([[0.1, -0.4, 2.1], [-0.3, 0.8, 2.4], [0.0, 0.0, 3.0]])
    uv = ft.project(cam, pts)
    for (x, y, z), (u, v) in zip(pts, uv):
        ru, rv = lhm_j2d_to_raw(f896 * x / z + 448, f896 * y / z + 448, ann)
        assert u == pytest.approx(ru)
        assert v == pytest.approx(rv)


def test_render_window_is_centred_on_the_principal_point_and_covers_the_box():
    cam = ft.SourceCamera(fx=1600, fy=1600, cx=513.0, cy=768.5, width=1024, height=1536)
    box = (217, 77, 809, 1483)
    win = ft.render_window(cam, box, margin=0.05, max_side=4096)
    assert win.x0 + win.width / 2 == pytest.approx(cam.cx, abs=0.5)
    assert win.y0 + win.height / 2 == pytest.approx(cam.cy, abs=0.5)
    assert win.x0 <= box[0] and win.x0 + win.width >= box[2]
    assert win.y0 <= box[1] and win.y0 + win.height >= box[3]
    assert win.scale == 1


def test_large_windows_are_downscaled_with_the_focal_length():
    cam = ft.SourceCamera(fx=1600, fy=1600, cx=500, cy=800, width=1024, height=1536)
    win = ft.render_window(cam, (0, 0, 1000, 1600), max_side=800)
    w, h = win.size
    assert max(w, h) <= 801
    fx, fy, rw, rh = ft.window_intrinsics(cam, win)
    assert fx == pytest.approx(1600 * win.scale)
    assert (rw, rh) == (w, h)


def test_crop_to_window_pads_outside_the_image_with_the_fill():
    img = np.arange(12, dtype=np.float32).reshape(3, 4)
    win = ft.Window(x0=-1, y0=1, width=3, height=3, scale=1.0)
    out = ft.crop_to_window(img, win, fill=-1.0)
    assert out.tolist() == [[-1, 4, 5], [-1, 8, 9], [-1, -1, -1]]


def test_similarity_fix_maps_the_render_box_onto_the_mask_box():
    fix = ft.similarity_fix((100, 200, 300, 1200), (90, 180, 310, 1280))
    s, du, dv = fix
    assert s == pytest.approx(1.1)
    # centre and height land exactly
    assert s * 200 + du == pytest.approx(200)
    assert s * 700 + dv == pytest.approx(730)
    cam = ft.corrected(ft.SourceCamera(1000, 1000, 500, 700, 1024, 1536), fix)
    assert cam.fx == pytest.approx(1100)
    assert cam.cx == pytest.approx(500 * s + du)


def test_iou_psnr_and_json_safety():
    a = np.zeros((4, 4))
    b = np.zeros((4, 4))
    a[:2] = 1
    b[1:3] = 1
    assert ft.iou(a, b) == pytest.approx(4 / 12)
    img = np.full((4, 4, 3), 0.5)
    assert ft.masked_psnr(img, img + 0.1, a) == pytest.approx(20.0)
    assert ft.json_safe({"x": float("nan"), "y": [1.0, float("inf")], "z": "ok"}) == {"x": None, "y": [1.0, None], "z": "ok"}
