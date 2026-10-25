// Beat gestures → motion clips (manifest stage). A beat with a `gesture` prompt gets a `clip`:
//
//   MOTION_GEN=1 (live, Modal key): the prompt is generated once with HY-Motion on Modal
//     (worker/motion_library.py --gestures, one GPU call for every new prompt), cached by prompt in
//     <MOTION_CACHE_DIR>/<key>.json + .bin, and the scene's gestures are merged into
//     scene-<n>/motion/motion-library.json, which the manifest points at (`motion.library`).
//   otherwise (MOCK, no key, or a failed generation): the nearest clip of the shared library every
//     actor already ships with (talk-1, talk-2, idle-listen, sit-idle, sit-talk), by keyword.
//
// A gesture never fails the manifest: anything that goes wrong falls back to the shared clips.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Beat, ScenePlan } from '../../shared/schema.ts';
import { env } from '../env.ts';
import { exists, writeJsonAtomic } from './fsutil.ts';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const MOTION_LIBRARY_PY = join(REPO, 'worker', 'motion_library.py');
export const MOTION_SCHEMA = 'previz.motion-library/1';
/** Cache key version: bump when the gesture build changes so old clips are regenerated. */
const KEY_VERSION = 'g1';
/** Seconds generated per gesture (HY-Motion takes the duration; a beat is a short action). */
export const GESTURE_SECONDS = 3.5;

export interface MotionLibraryJson {
  schema: string;
  fps: number;
  joints: number;
  file: string;
  bytes: number;
  sha256: string;
  layout?: string;
  source?: string;
  clips: { name: string; pose: string; frames: number; offset: number; [k: string]: unknown }[];
}

/** Stable cache key for a gesture prompt (also the clip name in the library). */
export function gestureKey(prompt: string, pose: 'standing' | 'sitting'): string {
  const h = createHash('sha256').update(
    `${KEY_VERSION}|${pose}|${GESTURE_SECONDS}|${prompt.trim()}`,
  );
  return `gesture-${h.digest('hex').slice(0, 16)}`;
}

/**
 * The shared-library clip closest to a gesture, by keyword (what MOCK and fallbacks use); null when
 * nothing fits (the beat is then staged by position and facing only).
 */
export function bundledClipFor(text: string, sitting: boolean): string | null {
  const t = text.toLowerCase();
  const pick = (stand: string, sit: string) => (sitting ? sit : stand);
  // word stems: "shrugs", "nodding", "pointing" all match
  if (/\b(shrug|palm|ask|plead|question|spreads? (his|her|their) hands|throws? (up|both))/.test(t))
    return pick('talk-2', 'sit-talk');
  if (/\b(gestur|explain|point|wave|argu|jab|counts? on|insist|emphasi)/.test(t))
    return pick('talk-1', 'sit-talk');
  if (/\b(nod|listen|wait|watch|shift|fidget|breath|sigh|stare|look)/.test(t))
    return pick('idle-listen', 'sit-idle');
  return null;
}

/** Concatenates one-clip (or more) libraries into one; offsets realigned, sha256 recomputed. */
export function mergeLibraries(
  parts: { json: MotionLibraryJson; bin: Buffer }[],
  file = 'motion-clips.bin',
): { json: MotionLibraryJson; bin: Buffer } {
  const chunks: Buffer[] = [];
  const clips: MotionLibraryJson['clips'] = [];
  let size = 0;
  for (const p of parts) {
    if (p.json.schema !== MOTION_SCHEMA || p.bin.length !== p.json.bytes)
      throw new Error(`gesture library ${p.json.file} is invalid`);
    for (const c of p.json.clips) clips.push({ ...c, offset: c.offset + size });
    const pad = (4 - (p.bin.length % 4)) % 4;
    chunks.push(p.bin, Buffer.alloc(pad));
    size += p.bin.length + pad;
  }
  const bin = Buffer.concat(chunks);
  const first = parts[0]?.json;
  return {
    bin,
    json: {
      schema: MOTION_SCHEMA,
      fps: first?.fps ?? 30,
      joints: first?.joints ?? 22,
      file,
      bytes: bin.length,
      sha256: createHash('sha256').update(bin).digest('hex'),
      ...(first?.layout ? { layout: first.layout } : {}),
      source: 'HY-Motion 1.0 one-shot gestures (worker/motion_library.py --gestures)',
      clips,
    },
  };
}

/** Beats that ask for a gesture (walks carry none: the walk cycle is the motion). */
function gestureBeats(scene: ScenePlan): { beat: Beat; sitting: boolean }[] {
  const out: { beat: Beat; sitting: boolean }[] = [];
  for (const b of scene.blocking) {
    let sitting = b.pose === 'sitting';
    for (const beat of [...(b.beats ?? [])].sort((x, y) => x.t - y.t)) {
      if (beat.moveTo) sitting = false;
      if (beat.gesture?.trim() && !beat.moveTo) out.push({ beat, sitting });
      if (beat.pose) sitting = beat.pose === 'sitting';
    }
  }
  return out;
}

export interface MotionDeps {
  /** Runs the worker on a spec file; resolves with its RESULT (or throws). */
  runWorker(specPath: string, cacheDir: string, log: (m: string) => void): Promise<unknown>;
}

export interface ResolveMotionOptions {
  sceneDir: string;
  /** Path of sceneDir relative to the project root ("scene-0"), for the manifest pointer. */
  sceneRel: string;
  cacheDir: string;
  /** Generate missing gestures on Modal (MOTION_GEN=1, live, Modal key present). */
  generate: boolean;
  log: (m: string) => void;
  deps?: MotionDeps;
}

/**
 * Sets `clip` on every gesture beat of `scene` (a copy) and returns the manifest `motion` pointer
 * when generated clips are in use.
 */
export async function resolveSceneMotion(
  scene: ScenePlan,
  o: ResolveMotionOptions,
): Promise<{ scene: ScenePlan; motion?: { library: string } }> {
  const plan: ScenePlan = structuredClone(scene);
  const wanted = gestureBeats(plan);
  if (!wanted.length) return { scene: plan };
  const keyed = wanted.map((w) => ({
    ...w,
    key: gestureKey(w.beat.gesture!, w.sitting ? 'sitting' : 'standing'),
  }));
  if (o.generate) {
    const missing = new Map<
      string,
      { key: string; prompt: string; seconds: number; pose: string }
    >();
    for (const k of keyed)
      if (!(await exists(join(o.cacheDir, `${k.key}.json`))))
        missing.set(k.key, {
          key: k.key,
          prompt: k.beat.gesture!.trim(),
          seconds: GESTURE_SECONDS,
          pose: k.sitting ? 'sitting' : 'standing',
        });
    if (missing.size) {
      const dir = join(o.sceneDir, 'motion');
      await mkdir(dir, { recursive: true });
      const spec = join(dir, 'gesture-spec.json');
      await writeJsonAtomic(spec, { gestures: [...missing.values()] });
      o.log(
        `motion: generating ${missing.size} gesture(s) with HY-Motion on Modal (L40S, a few minutes the first time)`,
      );
      try {
        const r = await (o.deps ?? defaultDeps).runWorker(spec, o.cacheDir, o.log);
        const rep = r as {
          generated?: unknown[];
          gpuSeconds?: number;
          estimatedComputeUSD?: number;
        };
        o.log(
          `motion: generated ${rep.generated?.length ?? 0} gesture(s)` +
            (rep.gpuSeconds ? ` in ${rep.gpuSeconds.toFixed(0)} s of L40S` : '') +
            (rep.estimatedComputeUSD ? `, ~$${rep.estimatedComputeUSD.toFixed(3)}` : ''),
        );
      } catch (e) {
        o.log(
          `motion: generation failed (${(e as Error).message.slice(0, 200)}); using the shared clips`,
        );
      }
    }
  }
  const parts: { json: MotionLibraryJson; bin: Buffer }[] = [];
  const have = new Set<string>();
  for (const k of keyed) {
    const jsonPath = join(o.cacheDir, `${k.key}.json`);
    if (o.generate && !have.has(k.key) && (await exists(jsonPath))) {
      try {
        const json = JSON.parse(await readFile(jsonPath, 'utf8')) as MotionLibraryJson;
        const bin = await readFile(join(o.cacheDir, json.file));
        parts.push({ json, bin });
        have.add(k.key);
      } catch (e) {
        o.log(
          `motion: cached ${k.key} unreadable (${(e as Error).message}); using the shared clips`,
        );
      }
    }
    const clip = have.has(k.key)
      ? k.key
      : bundledClipFor(`${k.beat.gesture} ${k.beat.action}`, k.sitting);
    if (clip) k.beat.clip = clip;
    else delete k.beat.clip;
  }
  if (!parts.length) return { scene: plan };
  const merged = mergeLibraries(parts);
  const dir = join(o.sceneDir, 'motion');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, merged.json.file), merged.bin);
  await writeJsonAtomic(join(dir, 'motion-library.json'), merged.json);
  o.log(`motion: ${parts.length} generated gesture(s) in ${o.sceneRel}/motion/`);
  return { scene: plan, motion: { library: `${o.sceneRel}/motion/motion-library.json` } };
}

const defaultDeps: MotionDeps = {
  runWorker(specPath, cacheDir, log) {
    const venv = process.env.ACTOR_PYTHON ?? join(REPO, 'worker', '.venv', 'bin', 'python');
    return exists(venv).then(
      (has) =>
        new Promise((resolve, reject) => {
          const child = spawn(
            has ? venv : 'python3',
            [MOTION_LIBRARY_PY, '--gestures', specPath, '--out', cacheDir],
            {
              cwd: REPO,
              env: {
                ...process.env,
                MODAL_TOKEN_ID: env.keys.modalTokenId,
                MODAL_TOKEN_SECRET: env.keys.modalTokenSecret,
                PYTHONUNBUFFERED: '1',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          let result: unknown;
          let errTail = '';
          child.stdout.on('data', (c: Buffer) => {
            for (const line of c.toString().split('\n'))
              if (line.startsWith('RESULT ')) result = JSON.parse(line.slice(7));
          });
          child.stderr.on('data', (c: Buffer) => {
            errTail = (errTail + c.toString()).slice(-2000);
            for (const line of c.toString().split('\n'))
              if (/Error|Traceback|frames in/.test(line)) log(`motion: ${line.slice(0, 240)}`);
          });
          const timer = setTimeout(() => child.kill('SIGTERM'), 20 * 60_000);
          child.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0 && result) resolve(result);
            else
              reject(
                new Error(
                  `motion_library.py exited ${code}: ${errTail.split('\n').slice(-3).join(' ')}`,
                ),
              );
          });
        }),
    );
  },
};
