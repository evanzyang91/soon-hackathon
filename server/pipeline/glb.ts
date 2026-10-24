// Minimal binary glTF (GLB) reader: enough to flatten a Marble collider mesh into a triangle soup
// on the server, with no three.js scene graph. Handles the GLB container (JSON + BIN chunks),
// node hierarchies (matrix or TRS), float32 POSITION accessors (with byteStride) and
// u8/u16/u32 or absent indices, triangle-list primitives only (mode 4, the glTF default).
// Output: 9 floats per triangle in the file's own frame (for Marble: the raw SPZ frame, OpenCV).

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}
interface GltfNode {
  children?: number[];
  mesh?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}
interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
}

type Mat4 = number[]; // column-major, like glTF

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function mul(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  return out;
}

function nodeMatrix(n: GltfNode): Mat4 {
  if (n.matrix?.length === 16) return n.matrix;
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  // rotation matrix from the unit quaternion, scaled per column
  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
}

export class GlbError extends Error {}

/** Parses a GLB into its JSON document and BIN chunk. */
export function parseGlb(bytes: Uint8Array): { json: Gltf; bin: DataView | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC)
    throw new GlbError('not a GLB file');
  if (view.getUint32(4, true) !== 2) throw new GlbError('only glTF 2.0 GLB is supported');
  const total = Math.min(view.getUint32(8, true), bytes.byteLength);
  let json: Gltf | null = null;
  let bin: DataView | null = null;
  for (let off = 12; off + 8 <= total; ) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const start = off + 8;
    if (start + len > total) throw new GlbError('truncated GLB chunk');
    if (type === CHUNK_JSON)
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + len))) as Gltf;
    else if (type === CHUNK_BIN && !bin)
      bin = new DataView(bytes.buffer, bytes.byteOffset + start, len);
    off = start + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new GlbError('GLB has no JSON chunk');
  return { json, bin };
}

function readPositions(g: Gltf, bin: DataView, index: number): Float32Array {
  const a = g.accessors?.[index];
  if (!a || a.type !== 'VEC3' || a.componentType !== 5126)
    throw new GlbError('POSITION must be a float32 VEC3 accessor');
  const out = new Float32Array(a.count * 3);
  if (a.bufferView === undefined) return out; // all zeros (sparse accessors are not supported)
  const bv = g.bufferViews![a.bufferView]!;
  const stride = bv.byteStride ?? 12;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  if (base + stride * (a.count - 1) + 12 > bin.byteLength) throw new GlbError('POSITION out of range');
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride;
    out[i * 3] = bin.getFloat32(o, true);
    out[i * 3 + 1] = bin.getFloat32(o + 4, true);
    out[i * 3 + 2] = bin.getFloat32(o + 8, true);
  }
  return out;
}

function readIndices(g: Gltf, bin: DataView, index: number): Uint32Array {
  const a = g.accessors?.[index];
  if (!a || a.type !== 'SCALAR' || a.bufferView === undefined) throw new GlbError('bad index accessor');
  const bv = g.bufferViews![a.bufferView]!;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 0;
  if (!size) throw new GlbError(`unsupported index component type ${a.componentType}`);
  const stride = bv.byteStride ?? size;
  if (base + stride * (a.count - 1) + size > bin.byteLength) throw new GlbError('indices out of range');
  const out = new Uint32Array(a.count);
  for (let i = 0; i < a.count; i++) {
    const o = base + i * stride;
    out[i] = size === 4 ? bin.getUint32(o, true) : size === 2 ? bin.getUint16(o, true) : bin.getUint8(o);
  }
  return out;
}

/** Every triangle of every mesh in the default scene, node transforms applied (9 floats each). */
export function glbTriangles(bytes: Uint8Array): Float32Array {
  const { json: g, bin } = parseGlb(bytes);
  if (!bin) throw new GlbError('GLB has no BIN chunk');
  const chunks: Float32Array[] = [];
  const visit = (nodeIndex: number, parent: Mat4, depth: number) => {
    const node = g.nodes?.[nodeIndex];
    if (!node || depth > 64) return;
    const m = mul(parent, nodeMatrix(node));
    for (const prim of node.mesh !== undefined ? (g.meshes?.[node.mesh]?.primitives ?? []) : []) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
      const pos = readPositions(g, bin, prim.attributes.POSITION);
      const idx =
        prim.indices !== undefined
          ? readIndices(g, bin, prim.indices)
          : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
      const n = Math.floor(idx.length / 3) * 3;
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = idx[i]!;
        if (v * 3 + 2 >= pos.length) throw new GlbError('index out of range');
        const x = pos[v * 3]!;
        const y = pos[v * 3 + 1]!;
        const z = pos[v * 3 + 2]!;
        out[i * 3] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        out[i * 3 + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        out[i * 3 + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      }
      chunks.push(out);
    }
    for (const c of node.children ?? []) visit(c, m, depth + 1);
  };
  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY, 0);
  const all = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.length;
  }
  return all;
}

/** Builds a GLB holding one triangle-list mesh (tests and fixtures). */
export function encodeGlb(
  positions: Float32Array,
  indices?: Uint32Array,
  node: Pick<GltfNode, 'matrix' | 'translation' | 'rotation' | 'scale'> = {},
): Uint8Array {
  const posBytes = positions.byteLength;
  const idxBytes = indices?.byteLength ?? 0;
  const binLen = posBytes + idxBytes;
  const json: Gltf & { asset: { version: string }; buffers: { byteLength: number }[] } = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [
      { primitives: [{ attributes: { POSITION: 0 }, ...(indices ? { indices: 1 } : {}), mode: 4 }] },
    ],
    buffers: [{ byteLength: binLen }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posBytes },
      ...(indices ? [{ buffer: 0, byteOffset: posBytes, byteLength: idxBytes }] : []),
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3' },
      ...(indices ? [{ bufferView: 1, componentType: 5125, count: indices.length, type: 'SCALAR' }] : []),
    ],
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  const binPad = (4 - (binLen % 4)) % 4;
  const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + binLen + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, jsonBytes.length + jsonPad, true);
  dv.setUint32(16, CHUNK_JSON, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
  const binStart = 20 + jsonBytes.length + jsonPad;
  dv.setUint32(binStart, binLen + binPad, true);
  dv.setUint32(binStart + 4, CHUNK_BIN, true);
  out.set(new Uint8Array(positions.buffer, positions.byteOffset, posBytes), binStart + 8);
  if (indices) out.set(new Uint8Array(indices.buffer, indices.byteOffset, idxBytes), binStart + 8 + posBytes);
  return out;
}
