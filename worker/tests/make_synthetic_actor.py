#!/usr/bin/env python3
"""Write a synthetic LHM-like actor and package it exactly like the GPU worker does.

    python3 worker/tests/make_synthetic_actor.py OUT [--frames 12] [--talk 6] [--splats 6000]

OUT/raw/frame_NNN.ply + frozen.ply are in the LHM/Multi-HMR camera frame (OpenCV: y down, the
figure 3 m in front of the camera, facing it); OUT/sequence/ and OUT/frozen.ply are the packaged
result. Used by the vitest Python->TS round trip and the browser actor check; needs only numpy.
"""

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lhm_stages import package_actor as pa  # noqa: E402

PROPS = [
    "x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2",
    "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
]  # fmt: skip
SH_C0 = 0.28209479177387814


def figure(n, rng):
    """Points of a 1.7 m standing figure in an upright, facing-+z-camera-side local frame (y up)."""
    parts = [  # (share, centre, radii, rgb)
        (0.12, (0, 1.58, 0), (0.1, 0.12, 0.1), (0.85, 0.68, 0.55)),  # head
        (0.30, (0, 1.15, 0), (0.18, 0.28, 0.11), (0.2, 0.45, 0.35)),  # torso (green coat)
        (0.08, (0.27, 1.12, 0), (0.05, 0.28, 0.05), (0.2, 0.45, 0.35)),  # arm
        (0.08, (-0.27, 1.12, 0), (0.05, 0.28, 0.05), (0.2, 0.45, 0.35)),
        (0.19, (0.1, 0.45, 0), (0.07, 0.45, 0.07), (0.15, 0.2, 0.35)),  # legs (jeans)
        (0.19, (-0.1, 0.45, 0), (0.07, 0.45, 0.07), (0.15, 0.2, 0.35)),
        (0.04, (0, 1.5, 0.1), (0.04, 0.02, 0.01), (0.5, 0.2, 0.2)),  # mouth on the face side
    ]
    pts, cols, labels = [], [], []
    for k, (share, c, r, rgb) in enumerate(parts):
        m = max(1, int(n * share))
        d = rng.normal(size=(m, 3))
        d /= np.linalg.norm(d, axis=1, keepdims=True)
        d *= rng.uniform(0.6, 1.0, size=(m, 1)) ** (1 / 3)
        pts.append(np.array(c) + d * np.array(r))
        cols.append(np.tile(rgb, (m, 1)) + rng.normal(scale=0.03, size=(m, 3)))
        labels.append(np.full(m, k))
    return np.concatenate(pts), np.clip(np.concatenate(cols), 0, 1), np.concatenate(labels)


def frame(base, labels, u, talk):
    p = base.copy()
    yaw = 0.08 * np.sin(2 * np.pi * u)
    head = (labels == 0) | (labels == 6)
    c, s = np.cos(yaw), np.sin(yaw)
    hx, hz = p[head, 0], p[head, 2]
    p[head, 0], p[head, 2] = c * hx + s * hz, -s * hx + c * hz
    p[labels == 2, 0] += 0.02 * np.sin(2 * np.pi * u)
    p[labels == 3, 0] -= 0.02 * np.sin(2 * np.pi * u)
    if talk:
        p[labels == 6, 1] -= 0.015 * np.sin(np.pi * 6 * u) ** 2
    return p


def to_opencv(p):
    """local (y up, facing +z) -> camera: y down, figure 3 m away facing the camera (-z).

    Rx(pi) — a proper rotation, like SMPL-X root_pose [pi, 0, 0] in LHM's camera frame.
    """
    q = p * np.array([1.0, -1.0, -1.0])
    q[:, 1] += 0.7  # feet at camera y = +0.7
    q[:, 2] += 3.0
    return q


def write(path, xyz, rgb):
    n = len(xyz)
    d = np.zeros((n, len(PROPS)), np.float32)
    d[:, 0:3] = xyz
    d[:, 6:9] = (rgb - 0.5) / SH_C0
    d[:, 9] = 3.0
    d[:, 10:13] = np.log(0.012)
    d[:, 13] = 1.0
    pa.write_ply(path, PROPS, d)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--frames", type=int, default=12)
    ap.add_argument("--talk", type=int, default=6)
    ap.add_argument("--splats", type=int, default=6000)
    ap.add_argument("--fps", type=float, default=12)
    a = ap.parse_args()
    out = Path(a.out)
    raw = out / "raw"
    raw.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    base, rgb, labels = figure(a.splats, rng)
    paths = []
    plan = [(i / a.frames, False) for i in range(a.frames)] + [(i / a.talk, True) for i in range(a.talk)]
    for n, (u, talk) in enumerate(plan):
        path = raw / f"frame_{n:03d}.ply"
        write(path, to_opencv(frame(base, labels, u, talk)), rgb)
        paths.append(path)
    write(raw / "frozen.ply", to_opencv(base), rgb)
    loops = {"idle": (0, a.frames)}
    if a.talk:
        loops["talk"] = (a.frames, a.talk)
    seq = pa.package(
        paths, out / "sequence", fps=a.fps, loops=loops,
        frozen=raw / "frozen.ply", frozen_out=out / "frozen.ply", quantize=True,
    )  # fmt: skip
    print(f"{seq['count']} frames, nativeHeight {seq['nativeHeight']:.3f}, motion {seq['motion']['file']}")


if __name__ == "__main__":
    main()
