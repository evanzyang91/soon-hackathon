// LHM splat-sequence actor (the baked fallback): ONE SplatMesh built from frame_000.ply, and per
// frame only the splat centres + rotations change (colour, opacity and scale are identical
// across LHM frames), so a frame switch rewrites those words of the PackedSplats in place.
// Frames come from the compact previz.actor-motion/1 track when
// present (one fetch, decoded per frame on demand), else from the individual PLYs.
import * as THREE from 'three';
import { PackedSplats, SplatMesh, setPackedSplat, utils as sparkUtils } from '@sparkjsdev/spark';
import type { ActorAsset } from '@shared/schema';
import {
  decodeMotionFrame,
  measurePly,
  parseGaussianPly,
  sha256Hex,
  validateSequence,
  type ActorSequence,
  type GaussianPly,
  type LoopRange,
} from '@shared/actor-sequence';
import { projectCandidates } from './common';

type SplatAsset = Extract<ActorAsset, { kind: 'splat-sequence' }>;

const SH_C0 = 0.28209479177387814;
const { setPackedSplatCenter, setPackedSplatQuat } = sparkUtils;
const TALK_SPEEDUP = 1.15;

export interface SplatBody {
  root: THREE.Group;
  mesh: SplatMesh;
  headY: number;
  sequence: ActorSequence;
  /** resolves once every frame is decodable (playback starts on frame 0 before that) */
  allLoaded: Promise<void>;
  animate(dt: number, speaking: boolean): void;
  /** current frame index into sequence.frames (for tests/debug) */
  readonly frame: number;
  dispose(): void;
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res;
}

async function verify(buf: ArrayBuffer, expected: string | undefined, label: string) {
  // crypto.subtle exists only in secure contexts (the app is served over HTTPS)
  if (!expected || typeof crypto === 'undefined' || !crypto.subtle) return;
  if ((await sha256Hex(buf)) !== expected) throw new Error(`${label}: SHA-256 mismatch`);
}

/** Loads sequence.json from the first candidate that answers with valid JSON. */
export async function loadSequence(asset: SplatAsset, baseUrl: string): Promise<{ seq: ActorSequence; dir: string }> {
  const rel = `${asset.sequenceDir.replace(/\/+$/, '')}/sequence.json`;
  let last: unknown;
  for (const url of projectCandidates(rel, baseUrl)) {
    try {
      const seq = validateSequence(await (await fetchOk(url)).json());
      return { seq, dir: new URL('./', url).href };
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error(`sequence.json not found for ${asset.characterId}`);
}

function extractKey(ply: GaussianPly): Float32Array {
  const { props, n, data } = ply;
  const np = props.length;
  const ix = props.indexOf('x');
  const ir = props.indexOf('rot_0');
  const out = new Float32Array(n * 7);
  for (let i = 0; i < n; i++) {
    const s = i * np;
    out[i * 7] = data[s + ix]!;
    out[i * 7 + 1] = data[s + ix + 1]!;
    out[i * 7 + 2] = data[s + ix + 2]!;
    out[i * 7 + 3] = data[s + ir]!;
    out[i * 7 + 4] = data[s + ir + 1]!;
    out[i * 7 + 5] = data[s + ir + 2]!;
    out[i * 7 + 6] = data[s + ir + 3]!;
  }
  return out;
}

export async function loadSplatBody(
  asset: SplatAsset,
  baseUrl: string,
  loaded?: { seq: ActorSequence; dir: string },
): Promise<SplatBody> {
  const { seq, dir } = loaded ?? (await loadSequence(asset, baseUrl));
  const frameUrl = (name: string) => new URL(name, dir).href;
  const buf0 = await (await fetchOk(frameUrl(seq.frames[0]!))).arrayBuffer();
  await verify(buf0, seq.frame_sha256?.[0], seq.frames[0]!);
  const ply0 = parseGaussianPly(buf0, seq.frames[0]);
  const { props, n, data } = ply0;
  const np = props.length;
  const [ix, ir, io, isc, ic] = ['x', 'rot_0', 'opacity', 'scale_0', 'f_dc_0'].map((p) => props.indexOf(p)) as [
    number,
    number,
    number,
    number,
    number,
  ];

  const packed = new Uint32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = i * np;
    const qw = data[s + ir]!;
    const qx = data[s + ir + 1]!;
    const qy = data[s + ir + 2]!;
    const qz = data[s + ir + 3]!;
    const qn = Math.hypot(qw, qx, qy, qz) || 1;
    const col = (k: number) => Math.min(1, Math.max(0, 0.5 + SH_C0 * data[s + ic + k]!));
    setPackedSplat(
      packed,
      i,
      data[s + ix]!,
      data[s + ix + 1]!,
      data[s + ix + 2]!,
      Math.exp(data[s + isc]!),
      Math.exp(data[s + isc + 1]!),
      Math.exp(data[s + isc + 2]!),
      qx / qn,
      qy / qn,
      qz / qn,
      qw / qn,
      1 / (1 + Math.exp(-data[s + io]!)),
      col(0),
      col(1),
      col(2),
    );
  }
  const packedSplats = new PackedSplats({ packedArray: packed, numSplats: n });
  const mesh = new SplatMesh({ packedSplats });
  await mesh.initialized;

  // Orientation: packaged sequences (avatarFrame) are already Y-up, facing -Z, feet at 0.
  // A raw LHM camera-frame sequence (OpenCV, y down, facing the camera) gets pi about Z,
  // then is grounded/centred from frame 0.
  const orient = new THREE.Group();
  orient.add(mesh);
  const raw = !seq.avatarFrame;
  const m = measurePly(ply0, raw ? -1 : 1);
  if (raw) {
    orient.rotation.z = Math.PI;
    orient.position.set(m.centerX, -m.feetY, -m.centerZ);
  }
  const nativeHeight = asset.nativeHeight > 0 ? asset.nativeHeight : seq.nativeHeight ?? m.height;
  const scale = (asset.heightMeters ?? 1.7) / nativeHeight;
  const root = new THREE.Group();
  root.name = 'splat-body';
  root.scale.setScalar(scale);
  root.add(orient); // orient offsets are native units; root's scale converts to metres

  // ---- per-frame keys ------------------------------------------------------------------------
  const keys: (Float32Array | null)[] = seq.frames.map(() => null);
  keys[0] = extractKey(ply0);
  let track: ArrayBuffer | null = null;
  const motion = seq.motion;
  let scratch: Float32Array | undefined; // one reusable decode buffer: no per-frame garbage
  const keyFor = (frame: number): Float32Array | null => {
    if (keys[frame]) return keys[frame];
    if (track && motion) return (scratch = decodeMotionFrame(track, motion, frame, scratch));
    return null;
  };
  const allLoaded = (async () => {
    if (motion && motion.splats === n && motion.base.sha256) {
      try {
        const buf = await (await fetchOk(frameUrl(motion.file))).arrayBuffer();
        if (buf.byteLength !== motion.bytes) throw new Error('motion payload size mismatch');
        await verify(buf, motion.sha256, motion.file);
        track = buf;
        return;
      } catch (err) {
        console.warn(`actor ${asset.characterId}: motion track rejected, loading PLYs`, err);
      }
    }
    const pending = seq.frames.map((_, i) => i).filter((i) => !keys[i]);
    const worker = async () => {
      for (let i = pending.shift(); i !== undefined; i = pending.shift()) {
        const buf = await (await fetchOk(frameUrl(seq.frames[i]!))).arrayBuffer();
        await verify(buf, seq.frame_sha256?.[i], seq.frames[i]!);
        const ply = parseGaussianPly(buf, seq.frames[i]);
        if (ply.n !== n || ply.props.join() !== props.join())
          throw new Error(`${seq.frames[i]}: layout or splat count differs from frame 0`);
        keys[i] = extractKey(ply);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  })();
  allLoaded.catch((err) => console.warn(`actor ${asset.characterId}: frames failed to load`, err));

  const idle: LoopRange = seq.loops?.idle ?? { start: 0, count: seq.count };
  const talk: LoopRange | null = seq.loops?.talk ?? null;
  let current = 0;
  let clock = 0;
  let wasSpeaking = false;

  const apply = (frame: number) => {
    const k = keyFor(frame);
    if (!k) return false;
    for (let i = 0; i < n; i++) {
      const o = i * 7;
      setPackedSplatCenter(packed, i, k[o]!, k[o + 1]!, k[o + 2]!);
      const w = k[o + 3]!;
      const x = k[o + 4]!;
      const y = k[o + 5]!;
      const z = k[o + 6]!;
      const qn = Math.hypot(w, x, y, z) || 1;
      setPackedSplatQuat(packed, i, x / qn, y / qn, z / qn, w / qn);
    }
    packedSplats.needsUpdate = true;
    mesh.updateVersion();
    current = frame;
    return true;
  };

  return {
    root,
    mesh,
    headY: (asset.heightMeters ?? 1.7) * 0.93,
    sequence: seq,
    allLoaded,
    get frame() {
      return current;
    },
    animate(dt, speaking) {
      if (speaking !== wasSpeaking) {
        clock = 0; // both loops start at the source pose: switching at a loop's frame 0 is seamless
        wasSpeaking = speaking;
      }
      const loop = speaking && talk ? talk : idle;
      clock += dt * (speaking && !talk ? TALK_SPEEDUP : 1);
      const frame = loop.start + (Math.floor(clock * seq.fps) % loop.count);
      if (frame !== current) apply(frame);
    },
    dispose() {
      mesh.dispose();
      packedSplats.dispose();
    },
  };
}
