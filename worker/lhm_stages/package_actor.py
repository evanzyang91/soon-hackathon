"""Package raw LHM gaussian frames as a Previz Stage actor sequence (pure numpy, no plyfile).

Input: LHM ``GaussianModel.save_ply`` frames — binary little-endian, one ``vertex`` element, all
float32 (x y z nx ny nz f_dc_0..2 [f_rest_*] opacity scale_0..2 rot_0..3; rot is w,x,y,z), in
the Multi-HMR source camera frame (OpenCV: x right, y down, z forward).

Output directory (``sequence/``):

* ``frame_NNN.ply`` — same property layout, re-expressed in the *avatar-local* OpenGL frame:
  +Y up, the avatar faces -Z (the ActorHandle forward), feet (0.5th percentile of opaque splat
  heights in frame 0) at y = 0, x/z centred on frame 0's opaque median. Units unchanged (LHM
  native = SMPL-X metres); the browser rescales to ``heightMeters`` using ``nativeHeight``.
* ``motion.u16`` / ``motion.f32`` — ``previz.actor-motion/1`` compact track (per-frame centres
  and rotations only; everything else is identical across frames).
* ``sequence.json`` — playback fields plus ``avatarFrame``, ``bounds``,
  ``nativeHeight`` and ``loops``; see worker/README.md for every field.

    python worker/lhm_stages/package_actor.py RAW_DIR OUT_DIR --fps 12 --idle 48 --talk 24
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np

try:
    from lhm_stages.idle_motion import matrix_to_quat
except ImportError:  # run as a script from worker/lhm_stages/
    from idle_motion import matrix_to_quat

SCHEMA = "previz.actor-sequence/1"
MOTION_SCHEMA = "previz.actor-motion/1"
CHANNELS = ("x", "y", "z", "rot_0", "rot_1", "rot_2", "rot_3")
REQUIRED = (*CHANNELS, "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2")
# OpenCV camera (x right, y down, z forward; the subject faces the camera, i.e. -z) to avatar
# local (y up, subject faces -z): a proper rotation of pi about z.
CV_TO_AVATAR = np.diag([-1.0, -1.0, 1.0])
HEADER_END = b"end_header\n"


def read_ply(path) -> tuple[list[str], np.ndarray]:
    raw = Path(path).read_bytes()
    end = raw.find(HEADER_END)
    if not raw.startswith(b"ply\n") or end < 0:
        raise ValueError(f"{path}: not a PLY")
    lines = raw[:end].decode("ascii").split("\n")
    if "format binary_little_endian 1.0" not in lines:
        raise ValueError(f"{path}: not binary little-endian")
    elements = [line for line in lines if line.startswith("element ")]
    if len(elements) != 1 or not elements[0].startswith("element vertex "):
        raise ValueError(f"{path}: expected exactly one vertex element")
    n = int(elements[0].split()[2])
    props = []
    for line in lines:
        if line.startswith("property "):
            _, kind, name = line.split()
            if kind not in ("float", "float32"):
                raise ValueError(f"{path}: property {name} is {kind}, not float")
            props.append(name)
    missing = [p for p in REQUIRED if p not in props]
    if missing:
        raise ValueError(f"{path}: not a gaussian PLY, lacks {missing}")
    body = raw[end + len(HEADER_END) :]
    if len(body) != n * len(props) * 4:
        raise ValueError(f"{path}: {len(body)} body bytes, header promises {n * len(props) * 4}")
    data = np.frombuffer(body, dtype="<f4").reshape(n, len(props)).copy()
    return props, data


def write_ply(path, props: list[str], data: np.ndarray) -> None:
    data = np.ascontiguousarray(data, dtype="<f4")
    header = (
        "ply\nformat binary_little_endian 1.0\n"
        f"element vertex {data.shape[0]}\n"
        + "".join(f"property float {p}\n" for p in props)
        + "end_header\n"
    )
    Path(path).write_bytes(header.encode("ascii") + data.tobytes())


def quat_mul(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(w,x,y,z) Hamilton product; a is (4,), b is (N,4)."""
    aw, ax, ay, az = a
    bw, bx, by, bz = b.T
    return np.stack(
        [
            aw * bw - ax * bx - ay * by - az * bz,
            aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
        ],
        1,
    )


def transform(props: list[str], data: np.ndarray, R: np.ndarray, t: np.ndarray) -> np.ndarray:
    out = data.copy()
    ix, ir = props.index("x"), props.index("rot_0")
    xyz = data[:, ix : ix + 3].astype(np.float64) @ R.T + t
    out[:, ix : ix + 3] = xyz.astype(np.float32)
    q = quat_mul(matrix_to_quat(R), data[:, ir : ir + 4].astype(np.float64))
    out[:, ir : ir + 4] = q.astype(np.float32)
    if "nx" in props:  # LHM writes zero normals; keep them rotated for completeness
        inn = props.index("nx")
        out[:, inn : inn + 3] = (data[:, inn : inn + 3].astype(np.float64) @ R.T).astype(np.float32)
    return out


def opaque(props: list[str], data: np.ndarray, threshold=0.5) -> np.ndarray:
    logit = data[:, props.index("opacity")].astype(np.float64)
    keep = 1 / (1 + np.exp(-logit)) > threshold
    return keep if keep.sum() >= 16 else np.ones(len(data), bool)


def measure(props: list[str], data: np.ndarray) -> dict:
    """Robust feet/top/centre from opaque splats (faint outliers must not set the height)."""
    ix = props.index("x")
    xyz = data[:, ix : ix + 3].astype(np.float64)
    o = xyz[opaque(props, data)]
    lo = np.percentile(o, 0.5, axis=0)
    hi = np.percentile(o, 99.5, axis=0)
    return {
        "feetY": float(lo[1]),
        "topY": float(hi[1]),
        "center": [float(np.median(o[:, 0])), float(np.median(o[:, 2]))],
        "opaqueHeight": float(hi[1] - lo[1]),
        "opaqueMin": lo.tolist(),
        "opaqueMax": hi.tolist(),
        "min": xyz.min(0).tolist(),
        "max": xyz.max(0).tolist(),
        "opaqueSplats": int(len(o)),
    }


def quantise(motion: np.ndarray):
    """uint16 per channel over the sequence range."""
    flat = motion.reshape(-1, motion.shape[-1]).astype(np.float64)
    lo = flat.min(0)
    hi = flat.max(0)
    scale = (hi - lo) / 65535.0
    safe = np.where(scale == 0, 1.0, scale)
    codes = np.round((flat - lo) / safe).clip(0, 65535).astype(np.uint16)
    back = (codes.astype(np.float64) * scale + lo).astype(np.float32).astype(np.float64)
    err = np.abs(back - flat).max(0)
    return codes.reshape(motion.shape), lo, scale, err


def sha256(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def motion_track(out_dir: Path, props, frames: list[np.ndarray], names: list[str], quantize: bool):
    """previz.actor-motion/1 record, or (None, reason) when appearance varies per frame."""
    channels = [props.index(c) for c in CHANNELS]
    static = [i for i in range(len(props)) if i not in channels]
    first = frames[0]
    for name, f in zip(names, frames):
        if f.shape != first.shape:
            return None, f"{name}: splat count differs from frame 0"
        if f[:, static].tobytes() != first[:, static].tobytes():
            return None, f"{name}: static attributes differ from frame 0"
    motion = np.stack([f[:, channels] for f in frames]).astype(np.float32)
    if quantize:
        codes, lo, scale, err = quantise(motion)
        payload, dtype, file = codes.astype("<u2").tobytes(), "uint16", "motion.u16"
    else:
        payload, dtype, file = motion.astype("<f4").tobytes(), "float32", "motion.f32"
        lo, scale, err = np.zeros(7), np.ones(7), np.zeros(7)
    (out_dir / file).write_bytes(payload)
    record = {
        "schema": MOTION_SCHEMA,
        "file": file,
        "frameFiles": list(names),
        "base": {
            "file": names[0],
            "bytes": (out_dir / names[0]).stat().st_size,
            "sha256": sha256(out_dir / names[0]),
        },
        "dtype": dtype,
        "frames": len(frames),
        "splats": int(first.shape[0]),
        "channels": list(CHANNELS),
        "layout": "frame-major, then splat, then channel; little-endian; value = code * scale + min",
        "min": lo.tolist(),
        "scale": scale.tolist(),
        "maxAbsError": err.tolist(),
        "bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
        "plyBytes": sum((out_dir / n).stat().st_size for n in names),
        "note": "The first listed PLY is the appearance keyframe; every static attribute was "
        "verified bit-identical across every frame before this track was written",
    }
    return record, None


def package(
    raw_frames: list[Path],
    out_dir: Path,
    *,
    fps: float,
    loops: dict[str, tuple[int, int]],
    frozen: Path | None = None,
    frozen_out: Path | None = None,
    quantize: bool = True,
    native_frame: str = "opencv-camera",
    extra: dict | None = None,
) -> dict:
    """Re-express every raw frame in the avatar frame, write PLYs + motion + sequence.json."""
    if not raw_frames:
        raise ValueError("no frames to package")
    covered = sorted(i for start, count in loops.values() for i in range(start, start + count))
    if covered != list(range(len(raw_frames))):
        raise ValueError("loops must partition the frame list exactly")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    R = CV_TO_AVATAR if native_frame == "opencv-camera" else np.eye(3)
    props0, data0 = read_ply(raw_frames[0])
    rotated0 = transform(props0, data0, R, np.zeros(3))
    m0 = measure(props0, rotated0)
    t = np.array([-m0["center"][0], -m0["feetY"], -m0["center"][1]])
    names, frames, finite = [], [], True
    for i, path in enumerate(raw_frames):
        props, data = (props0, data0) if i == 0 else read_ply(path)
        if props != props0:
            raise ValueError(f"{path}: property layout differs from frame 0")
        if data.shape != data0.shape:
            raise ValueError(f"{path}: splat count differs from frame 0")
        out = transform(props, data, R, t)
        finite &= bool(np.isfinite(out).all())
        name = f"frame_{i:03d}.ply"
        write_ply(out_dir / name, props, out)
        names.append(name)
        frames.append(out)
    if not finite:
        raise ValueError("non-finite gaussian attributes after packaging")
    if frozen is not None and frozen_out is not None:
        fp, fd = read_ply(frozen)
        write_ply(frozen_out, fp, transform(fp, fd, R, t))
    bounds = measure(props0, frames[0])
    record, skipped = motion_track(out_dir, props0, frames, names, quantize)
    sequence = {
        "schema": SCHEMA,
        "frame_format": "gaussian-ply",
        "frames": names,
        "count": len(names),
        "fps": fps,
        "timestamps": [i / fps for i in range(len(names))],
        "duration": len(names) / fps,
        "frame_sha256": [sha256(out_dir / n) for n in names],
        "gaussiansPerFrame": int(data0.shape[0]),
        "allNativeGaussianAttributesFinite": finite,
        "people_only": True,
        "canonicalShapeFixed": True,
        "coordinates": "OpenGL avatar-local: +Y up, avatar faces -Z, feet at y=0, x/z centred on "
        "frame 0's opaque median; native LHM units (SMPL-X metres)",
        "avatarFrame": {
            "up": [0, 1, 0],
            "forward": [0, 0, -1],
            "feetY": 0,
            "centered": True,
            "nativeCoordinates": native_frame,
            "fromNative": {"rotation": R.tolist(), "translation": t.tolist()},
        },
        "bounds": bounds,
        "nativeHeight": bounds["opaqueHeight"],
        "loops": {k: {"start": s, "count": c} for k, (s, c) in loops.items()},
        "motion": record,
    }
    if skipped:
        sequence["motionSkipped"] = skipped
    if extra:
        sequence.update(extra)
    (out_dir / "sequence.json").write_text(json.dumps(sequence, indent=2))
    return sequence


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("raw", help="directory of raw LHM frame_NNN.ply (+ optional frozen.ply)")
    ap.add_argument("out", help="sequence output directory")
    ap.add_argument("--fps", type=float, default=12)
    ap.add_argument("--idle", type=int, required=True)
    ap.add_argument("--talk", type=int, default=0)
    ap.add_argument("--lossless", action="store_true", help="float32 motion track")
    ap.add_argument("--native-frame", default="opencv-camera", choices=["opencv-camera", "avatar"])
    a = ap.parse_args()
    raw = Path(a.raw)
    frames = sorted(raw.glob("frame_*.ply"))
    loops = {"idle": (0, a.idle)}
    if a.talk:
        loops["talk"] = (a.idle, a.talk)
    frozen = raw / "frozen.ply"
    seq = package(
        frames,
        Path(a.out),
        fps=a.fps,
        loops=loops,
        frozen=frozen if frozen.exists() else None,
        frozen_out=Path(a.out).parent / "frozen.ply" if frozen.exists() else None,
        quantize=not a.lossless,
        native_frame=a.native_frame,
    )
    print(json.dumps({k: seq[k] for k in ("count", "fps", "nativeHeight", "loops")}, indent=1))


if __name__ == "__main__":
    main()
