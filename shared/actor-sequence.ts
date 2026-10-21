// Actor splat-sequence format: validation, PLY parsing and height measurement. Pure (no DOM, no
// three) so the server (server/pipeline/actors.ts) and the browser share one implementation.
//
// sequence.json is written by worker/lhm_stages/package_actor.py: the frame list, count, fps,
// timestamps, frame_sha256, an optional compact motion track (previz.actor-motion/1) and
// avatarFrame / bounds / nativeHeight / loops. See worker/README.md.

export const SEQUENCE_SCHEMA = 'previz.actor-sequence/1';
export const MOTION_SCHEMA = 'previz.actor-motion/1';
export const MOTION_CHANNELS = ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3'] as const;

export interface LoopRange {
  start: number;
  count: number;
}

export interface MotionRecord {
  schema: typeof MOTION_SCHEMA;
  file: string;
  dtype: 'uint16' | 'float32';
  frames: number;
  splats: number;
  channels: string[];
  frameFiles: string[];
  base: { file: string; bytes: number; sha256: string };
  bytes: number;
  sha256: string;
  min: number[];
  scale: number[];
}

export interface ActorSequence {
  frames: string[];
  count: number;
  fps: number;
  frame_sha256?: string[];
  /** Missing on raw LHM sequences: they are then OpenCV-frame and need the X flip. */
  avatarFrame?: { up: number[]; forward: number[]; feetY: number; centered: boolean };
  nativeHeight?: number;
  loops?: { idle?: LoopRange; talk?: LoopRange; [name: string]: LoopRange | undefined };
  motion?: MotionRecord | null;
  gaussiansPerFrame?: number;
}

const localFile = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(v);
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

/** Throws with a precise reason when `json` is not a playable actor sequence. */
export function validateSequence(json: unknown): ActorSequence {
  const s = json as ActorSequence;
  if (!s || typeof s !== 'object') throw new Error('sequence.json is not an object');
  if (!Array.isArray(s.frames) || !s.frames.length) throw new Error('sequence has no frames');
  if (!s.frames.every(localFile)) throw new Error('sequence frame names must be local files');
  if (new Set(s.frames).size !== s.frames.length) throw new Error('duplicate sequence frames');
  if (s.count !== s.frames.length) throw new Error(`count ${s.count} != ${s.frames.length} frames`);
  if (!(typeof s.fps === 'number' && s.fps > 0 && s.fps <= 120)) throw new Error('invalid fps');
  if (s.frame_sha256 !== undefined) {
    if (!Array.isArray(s.frame_sha256) || s.frame_sha256.length !== s.count)
      throw new Error('frame_sha256 does not match frames');
    if (!s.frame_sha256.every(hash)) throw new Error('frame_sha256 entries must be SHA-256 hex');
  }
  if (s.nativeHeight !== undefined && !(s.nativeHeight > 0)) throw new Error('invalid nativeHeight');
  if (s.loops) {
    for (const [name, r] of Object.entries(s.loops)) {
      if (!r) continue;
      if (!Number.isSafeInteger(r.start) || r.start < 0 || !posInt(r.count) || r.start + r.count > s.count)
        throw new Error(`loop ${name} outside the frame list`);
    }
  }
  if (s.motion) motionUsable(s.motion, s);
  return s;
}

/** Throws unless `m` is an integrity-bound previz.actor-motion/1 record for `seq`. */
export function motionUsable(m: MotionRecord, seq: Pick<ActorSequence, 'frames'>): void {
  const bytesPer = m.dtype === 'uint16' ? 2 : m.dtype === 'float32' ? 4 : 0;
  if (m.schema !== MOTION_SCHEMA) throw new Error('motion schema mismatch');
  if (!localFile(m.file) || !bytesPer) throw new Error('motion file/dtype invalid');
  if (!posInt(m.frames) || !posInt(m.splats)) throw new Error('motion dimensions invalid');
  if (m.channels?.join() !== MOTION_CHANNELS.join()) throw new Error('motion channels invalid');
  if (m.frames !== seq.frames.length || m.frameFiles?.join() !== seq.frames.join())
    throw new Error('motion frame order does not match sequence');
  if (m.base?.file !== seq.frames[0] || !hash(m.base?.sha256)) throw new Error('motion base invalid');
  if (!hash(m.sha256) || m.bytes !== m.frames * m.splats * 7 * bytesPer)
    throw new Error('motion byte length invalid');
  if (m.dtype === 'uint16' && !(m.min?.length === 7 && m.scale?.length === 7))
    throw new Error('quantized motion lacks min/scale');
}

// ---------------------------------------------------------------------------------------------
// Gaussian PLY (binary little-endian, one vertex element, all float32)
// ---------------------------------------------------------------------------------------------

export interface GaussianPly {
  props: string[];
  n: number;
  /** n * props.length float32, row-major. */
  data: Float32Array;
}

const HEADER_END = 'end_header\n';

export function parseGaussianPly(buf: ArrayBuffer, label = 'PLY'): GaussianPly {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(8192, buf.byteLength)));
  const hi = head.indexOf(HEADER_END);
  // a dev server answers a missing file with index.html and status 200
  if (!head.startsWith('ply\n') || hi < 0) throw new Error(`${label}: not a PLY`);
  const lines = head.slice(0, hi).split('\n');
  if (!lines.includes('format binary_little_endian 1.0'))
    throw new Error(`${label}: not binary little-endian`);
  const elements = lines.filter((l) => l.startsWith('element '));
  const vertex = elements[0];
  if (elements.length !== 1 || !vertex?.startsWith('element vertex '))
    throw new Error(`${label}: expected only a vertex element`);
  const n = Number(vertex.split(' ')[2]);
  const props: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('property ')) continue;
    const [, type, name] = line.split(' ');
    if (type !== 'float' && type !== 'float32')
      throw new Error(`${label}: property ${name} is ${type}, not float`);
    props.push(name ?? '');
  }
  for (const group of [['x', 'y', 'z'], ['rot_0', 'rot_1', 'rot_2', 'rot_3'], ['scale_0', 'scale_1', 'scale_2'], ['f_dc_0', 'f_dc_1', 'f_dc_2'], ['opacity']]) {
    const start = props.indexOf(group[0]!);
    if (start < 0 || group.some((name, i) => props[start + i] !== name))
      throw new Error(`${label}: missing or noncontiguous gaussian properties ${group.join(',')}`);
  }
  const headerLen = new TextEncoder().encode(head.slice(0, hi + HEADER_END.length)).length;
  const bytes = n * props.length * 4;
  if (!Number.isSafeInteger(n) || n <= 0 || buf.byteLength !== headerLen + bytes)
    throw new Error(`${label}: ${buf.byteLength} bytes, header promises ${headerLen + bytes}`);
  return { props, n, data: new Float32Array(buf.slice(headerLen, headerLen + bytes)) };
}

export interface PlyMeasure {
  /** Robust height: 0.5th..99.5th percentile of opaque splat y (faint outliers ignored). */
  height: number;
  feetY: number;
  topY: number;
  centerX: number;
  centerZ: number;
  /** Raw bbox over every splat. */
  min: [number, number, number];
  max: [number, number, number];
}

function percentile(sorted: Float64Array, p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))] ?? 0;
}

/** Measures a parsed PLY along `upAxis` (1 = y). Opaque = sigmoid(opacity) > 0.5. */
export function measurePly(ply: GaussianPly, upAxis: 1 | -1 = 1): PlyMeasure {
  const { props, n, data } = ply;
  const np = props.length;
  const ix = props.indexOf('x');
  const io = props.indexOf('opacity');
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let opaque: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = data[i * np + ix + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
    if (data[i * np + io]! > 0) opaque.push(i); // logit > 0 <=> sigmoid > 0.5
  }
  if (opaque.length < 16) opaque = Array.from({ length: n }, (_, i) => i);
  const ys = new Float64Array(opaque.map((i) => upAxis * data[i * np + ix + 1]!)).sort();
  const xs = new Float64Array(opaque.map((i) => data[i * np + ix]!)).sort();
  const zs = new Float64Array(opaque.map((i) => data[i * np + ix + 2]!)).sort();
  const feetY = percentile(ys, 0.005);
  const topY = percentile(ys, 0.995);
  return {
    height: topY - feetY,
    feetY,
    topY,
    centerX: percentile(xs, 0.5),
    centerZ: percentile(zs, 0.5),
    min,
    max,
  };
}

/** One frame of a motion track as 7 floats per splat (x,y,z,rot_0..3); reuses `out` if given. */
export function decodeMotionFrame(buf: ArrayBuffer, m: MotionRecord, frame: number, out?: Float32Array): Float32Array {
  if (frame < 0 || frame >= m.frames) throw new RangeError(`frame ${frame} not in track`);
  const per = m.splats * 7;
  if (!out || out.length !== per) out = new Float32Array(per);
  if (m.dtype === 'float32') {
    out.set(new Float32Array(buf, frame * per * 4, per));
  } else {
    const codes = new Uint16Array(buf, frame * per * 2, per);
    for (let i = 0; i < per; i++) {
      const c = i % 7;
      out[i] = codes[i]! * m.scale[c]! + m.min[c]!;
    }
  }
  return out;
}

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
