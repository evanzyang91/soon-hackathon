"""Mesh -> glTF binary for a generated prop (numpy only: runs in the Modal container and locally).

TripoSR reconstructs in its renderer's frame: x toward the input camera, y to the camera's right,
z up. glTF is y up with the front toward +z, so ``(x', y', z') = (y, z, x)``. That is a cyclic
permutation (a proper rotation), so the triangle winding survives it. The writer emits one
primitive with POSITION, NORMAL (area-weighted), COLOR_0 (linear float RGB) and uint32 indices,
and a rough, non-metallic material (glTF's default metallicFactor is 1, which would render a
reconstructed object as dark metal).
"""

from __future__ import annotations

import json
import struct

import numpy as np

GLB_MAGIC = 0x46546C67  # 'glTF'
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def triposr_to_gltf(vertices: np.ndarray) -> np.ndarray:
    """TripoSR (x toward the camera, y right, z up) -> glTF (y up, front +z)."""
    v = np.asarray(vertices, dtype=np.float64)
    return np.stack([v[:, 1], v[:, 2], v[:, 0]], axis=1)


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    """sRGB-encoded [0, 1] colours -> linear (glTF COLOR_0 is linear)."""
    c = np.clip(np.asarray(c, dtype=np.float64), 0.0, 1.0)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def signed_volume(vertices: np.ndarray, faces: np.ndarray) -> float:
    """Divergence theorem volume: positive when the triangles wind counter-clockwise seen from outside."""
    a, b, c = (vertices[faces[:, i]] for i in range(3))
    return float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6.0)


def outward(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Faces wound so the normals point out of the solid (marching cubes is consistent but its sign
    depends on the field's convention)."""
    f = np.asarray(faces, dtype=np.int64)
    return f[:, ::-1].copy() if signed_volume(vertices, f) < 0 else f


def vertex_normals(vertices: np.ndarray, faces: np.ndarray) -> np.ndarray:
    v = np.asarray(vertices, dtype=np.float64)
    f = np.asarray(faces, dtype=np.int64)
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])  # length = 2 x area: area-weighted
    n = np.zeros_like(v)
    for i in range(3):
        np.add.at(n, f[:, i], fn)
    length = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(length > 1e-12, n / np.maximum(length, 1e-12), np.array([0.0, 1.0, 0.0]))
    return n


def _pad(b: bytes, fill: bytes) -> bytes:
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(
    vertices: np.ndarray,
    faces: np.ndarray,
    colors: np.ndarray | None = None,
    *,
    name: str = "prop",
    roughness: float = 0.9,
    generator: str = "previz-stage worker/prop_glb.py",
) -> bytes:
    """One mesh as a glTF 2.0 binary. ``colors``: per vertex, linear RGB(A) floats in [0, 1]."""
    v = np.ascontiguousarray(vertices, dtype=np.float32)
    f = np.ascontiguousarray(faces, dtype=np.uint32)
    if v.ndim != 2 or v.shape[1] != 3 or f.ndim != 2 or f.shape[1] != 3 or not len(v) or not len(f):
        raise ValueError(f"need (N, 3) vertices and (M, 3) faces, got {v.shape} and {f.shape}")
    if int(f.max()) >= len(v):
        raise ValueError("a face points past the vertex list")
    if not np.isfinite(v).all():
        raise ValueError("non-finite vertex positions")
    n = np.ascontiguousarray(vertex_normals(v, f), dtype=np.float32)

    views, accessors, blob = [], [], b""

    def add(data: np.ndarray, target: int, accessor: dict) -> int:
        nonlocal blob
        raw = data.tobytes()
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw), "target": target})
        blob = _pad(blob + raw, b"\x00")
        accessors.append({"bufferView": len(views) - 1, **accessor})
        return len(accessors) - 1

    attributes = {
        "POSITION": add(
            v, 34962, {"componentType": 5126, "count": len(v), "type": "VEC3", "min": v.min(0).tolist(), "max": v.max(0).tolist()}
        ),
        "NORMAL": add(n, 34962, {"componentType": 5126, "count": len(n), "type": "VEC3"}),
    }
    if colors is not None:
        c = np.ascontiguousarray(np.clip(np.asarray(colors, dtype=np.float32)[:, :3], 0.0, 1.0))
        if len(c) != len(v):
            raise ValueError(f"{len(c)} colours for {len(v)} vertices")
        attributes["COLOR_0"] = add(c, 34962, {"componentType": 5126, "count": len(c), "type": "VEC3"})
    indices = add(f.reshape(-1), 34963, {"componentType": 5125, "count": int(f.size), "type": "SCALAR"})

    doc = {
        "asset": {"version": "2.0", "generator": generator},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": name}],
        "meshes": [{"name": name, "primitives": [{"attributes": attributes, "indices": indices, "material": 0, "mode": 4}]}],
        "materials": [
            {
                "name": f"{name}-surface",
                "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1], "metallicFactor": 0.0, "roughnessFactor": float(roughness)},
            }
        ],
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    js = _pad(json.dumps(doc, separators=(",", ":")).encode("utf8"), b" ")
    total = 12 + 8 + len(js) + 8 + len(blob)
    return b"".join(
        [
            struct.pack("<III", GLB_MAGIC, 2, total),
            struct.pack("<II", len(js), JSON_CHUNK),
            js,
            struct.pack("<II", len(blob), BIN_CHUNK),
            blob,
        ]
    )


def read_glb_json(data: bytes) -> dict:
    """The JSON chunk of a glTF binary (checks the container)."""
    magic, version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC or version != 2 or length != len(data):
        raise ValueError("not a glTF 2.0 binary")
    jl, jt = struct.unpack_from("<II", data, 12)
    if jt != JSON_CHUNK:
        raise ValueError("no JSON chunk")
    return json.loads(data[20 : 20 + jl])


if __name__ == "__main__":  # self-check: a coloured cube, written and read back
    import sys

    cube = np.array([[x, y, z] for x in (0, 1) for y in (0, 1) for z in (0, 1)], dtype=np.float64)
    quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    tris = np.array([t for a, b, c, d in quads for t in ((a, b, c), (a, c, d))])
    tris = outward(cube, tris)
    assert signed_volume(cube, tris) > 0.99
    glb = write_glb(triposr_to_gltf(cube), tris, srgb_to_linear(cube))
    doc = read_glb_json(glb)
    assert doc["meshes"][0]["primitives"][0]["attributes"].keys() == {"POSITION", "NORMAL", "COLOR_0"}
    if len(sys.argv) > 1:
        open(sys.argv[1], "wb").write(glb)
    print(f"ok: {len(glb)} bytes")
