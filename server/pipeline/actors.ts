// WP D: character -> ActorAsset.
//
//   buildActor({ character, projectDir, sceneDir, mock, log, detail? }) -> ActorAsset   (contract with WP C)
//
// detail 'standard' (default) is everything below. detail 'high' (the laptop's "High detail"
// rebuild, about 5 minutes per actor) runs the worker with `--detail high` (LHM-1B + a fine-tune
// against the reference) into actors/<id>/high/, reusing actors/<id>/reference.png, and returns
// the asset with `detail: 'high'`. It never falls back to the mannequin: any failure throws, so
// the caller keeps the standard build.
//
// Real path (MOCK off, Modal + OpenAI keys present):
//   1. reference image: OpenAI `gpt-image-1` (then gpt-image-1.5 / gpt-image-2 when the account
//      no longer serves it), full-body front-facing studio shot of
//      character.description, 1024x1536 -> <projectDir>/actors/<id>/reference.png (kept/reused)
//   2. `python3 worker/run_actor.py --image reference.png --out actors/<id>` (LHM on a Modal
//      L4; receipt-first, so a crashed/timed-out call is recovered, never paid twice)
//   3. -> { kind: 'splat-sequence', sequenceDir: 'actors/<id>/sequence', fps, nativeHeight
//      (measured from frame_000.ply), heightMeters: 1.7 }. The worker also writes the runtime rig
//      (sequence.json `rig` -> rig.json, rig-splats.bin, motion-library.json, motion-clips.bin)
//      in the same directory; the viewer prefers it and falls back to the baked frames.
// An existing valid actors/<id>/sequence is reused without any network call.
// MOCK, missing keys, or ANY failure -> the free offline fallback
//   { kind: 'glb-humanoid', glb: 'procedural:mannequin', clips, tint }
// Outside MOCK the fallback is marked `fallback: true`, so project.ts rebuilds it (once keys and
// Modal billing allow) instead of caching the mannequin as the final actor.
// which the browser builds procedurally (web/src/viewer/actors/mannequin.ts). The `procedural:`
// scheme is deliberate: an empty string would be rewritten into a directory path by
// project.ts `toProjectUrl`, a URL scheme is passed through untouched.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ActorAsset, ActorDetail, Character } from '../../shared/schema.ts';
import { env } from '../env.ts';
import { exists } from './fsutil.ts';
import { measurePly, parseGaussianPly, validateSequence } from '../../shared/actor-sequence.ts';
import { tintFor } from '../../shared/tint.ts';

export interface BuildActorOptions {
  character: Character;
  projectDir: string;
  sceneDir: string;
  mock: boolean;
  log: (m: string) => void;
  /** Build quality (default 'standard'); 'high' builds into actors/<id>/high/ and throws on failure. */
  detail?: ActorDetail;
}

/** Where a character's build of `detail` lives: actors/<id>/ (standard) or actors/<id>/<detail>/. */
export function actorDirFor(projectDir: string, characterId: string, detail: ActorDetail = 'standard'): string {
  const base = join(projectDir, 'actors', characterId);
  return detail === 'standard' ? base : join(base, detail);
}

/** Worker arguments for a fresh build (detail 'high' = LHM-1B + fine-tune). */
export function workerArgs(referencePath: string, actorDir: string, detail: ActorDetail = 'standard'): string[] {
  const args = ['--image', referencePath, '--out', actorDir, '--frames', '48', '--talk-frames', '24', '--fps', '12'];
  return detail === 'high' ? [...args, '--detail', 'high'] : args;
}

export const FALLBACK_GLB = 'procedural:mannequin';
export const FALLBACK_CLIPS = { idle: 'Idle', talk: 'Talk', walk: 'Walk' } as const;
export const HEIGHT_METERS = 1.7;
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_ACTOR = join(REPO, 'worker', 'run_actor.py');

export function fallbackActor(character: Character): ActorAsset {
  return {
    kind: 'glb-humanoid',
    characterId: character.id,
    glb: FALLBACK_GLB,
    clips: { ...FALLBACK_CLIPS },
    tint: tintFor(character.id),
  };
}

export function referencePrompt(character: Character): string {
  return [
    'Full-body photograph of one person standing upright, front-facing, looking straight at the camera,',
    'arms relaxed and held slightly away from the body, legs straight, whole body visible from the top of',
    'the head to the shoes with margin around it, neutral expression, plain light-grey seamless studio',
    'background, soft even lighting, no props, no text, photoreal.',
    `The person: ${character.description.trim()}`,
  ].join(' ');
}

// ---------------------------------------------------------------------------------------------
// Decision logic (pure, unit tested)
// ---------------------------------------------------------------------------------------------

export interface ReceiptState {
  status?: string;
  resultStatus?: string;
}

export interface ActorState {
  mock: boolean;
  hasModal: boolean;
  hasOpenAI: boolean;
  hasReference: boolean;
  sequenceValid: boolean;
  receipt?: ReceiptState;
}

export type ActorPlan =
  | { action: 'fallback'; reason: string }
  | { action: 'cached' }
  | { action: 'recover' }
  | { action: 'run'; needsReference: boolean };

export function planActor(s: ActorState): ActorPlan {
  if (s.mock) return { action: 'fallback', reason: 'MOCK' };
  if (s.sequenceValid) return { action: 'cached' };
  if (!s.hasModal) return { action: 'fallback', reason: 'Modal keys absent' };
  if (s.receipt) {
    const done = s.receipt.status === 'recovered';
    if (done && s.receipt.resultStatus && s.receipt.resultStatus !== 'complete')
      return {
        action: 'fallback',
        reason: `previous LHM run ended ${s.receipt.resultStatus}; delete recovery-receipt.json to retry`,
      };
    if (s.receipt.status === 'prepared') return { action: 'run', needsReference: !s.hasReference };
    return { action: 'recover' };
  }
  if (!s.hasReference && !s.hasOpenAI) return { action: 'fallback', reason: 'no reference image and no OpenAI key' };
  return { action: 'run', needsReference: !s.hasReference };
}

// ---------------------------------------------------------------------------------------------
// Effects (injectable for tests)
// ---------------------------------------------------------------------------------------------

export interface WorkerResult {
  ok: boolean;
  code: number;
  result?: Record<string, unknown> & { error?: string; running?: boolean };
}

export interface ActorDeps {
  keys: { openai: string; modalTokenId: string; modalTokenSecret: string };
  generateReference(prompt: string, out: string, log: (m: string) => void): Promise<void>;
  runWorker(args: string[], log: (m: string) => void): Promise<WorkerResult>;
  pollSeconds: number;
  timeoutMs: number;
}

/** Briefed model first; this account answers "does not exist" for it, so newer ones follow. */
export const IMAGE_MODELS = process.env.ACTOR_IMAGE_MODEL
  ? [process.env.ACTOR_IMAGE_MODEL]
  : ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-2'];

async function openaiReference(prompt: string, out: string, log: (m: string) => void): Promise<void> {
  let lastError = '';
  for (const model of IMAGE_MODELS) {
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.keys.openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: '1024x1536', quality: process.env.ACTOR_IMAGE_QUALITY ?? 'medium', n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      lastError = `OpenAI image (${model}) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      // only an unknown/unavailable model moves on to the next one
      if ((res.status === 400 || res.status === 404) && /model|does not exist|invalid_value/i.test(lastError)) {
        log(`${model} unavailable; trying the next image model`);
        continue;
      }
      throw new Error(lastError);
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image (${model}) response has no b64_json`);
    const png = Buffer.from(b64, 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('OpenAI image is not a PNG');
    const tmp = `${out}.${process.pid}.tmp`;
    await writeFile(tmp, png);
    await rename(tmp, out);
    log(`reference image via ${model}: ${png.length} bytes in ${Date.now() - t0}ms`);
    return;
  }
  throw new Error(lastError || 'no image model configured');
}

function pythonBin(): string {
  if (process.env.ACTOR_PYTHON) return process.env.ACTOR_PYTHON;
  return join(REPO, 'worker', '.venv', 'bin', 'python');
}

async function runActorCli(args: string[], log: (m: string) => void, timeoutMs: number): Promise<WorkerResult> {
  const venv = pythonBin();
  const python = (await exists(venv)) ? venv : 'python3';
  return new Promise((resolve) => {
    const child = spawn(python, [RUN_ACTOR, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        MODAL_TOKEN_ID: env.keys.modalTokenId,
        MODAL_TOKEN_SECRET: env.keys.modalTokenSecret,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let result: WorkerResult['result'];
    let tail = '';
    const onData = (chunk: Buffer) => {
      tail += chunk.toString();
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RESULT ')) {
          try {
            result = JSON.parse(line.slice(7));
          } catch {
            /* keep the last parseable one */
          }
        } else if (/animated gaussian frame|fine-tune|Loading 3DAIGC|receipt|Durable|Error|error|Traceback|using deployed|ephemeral|status/.test(line)) {
          log(`lhm: ${line.slice(0, 240)}`);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      log(`lhm: local wait timed out after ${Math.round(timeoutMs / 1000)}s; the Modal call keeps running and is recovered next build`);
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, result: { error: `${python}: ${err.message}` } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tail.startsWith('RESULT ')) onData(Buffer.from('\n'));
      resolve({ ok: code === 0 && !!result?.ok, code: code ?? -1, result });
    });
  });
}

const defaultDeps = (): ActorDeps => ({
  keys: env.keys,
  generateReference: openaiReference,
  runWorker: (args, log) => runActorCli(args, log, Number(process.env.ACTOR_TIMEOUT_MS ?? 45 * 60_000)),
  pollSeconds: 30,
  timeoutMs: Number(process.env.ACTOR_TIMEOUT_MS ?? 45 * 60_000),
});

// ---------------------------------------------------------------------------------------------
// Sequence inspection
// ---------------------------------------------------------------------------------------------

/** splat-sequence asset for a packaged sequence dir, or null when it is missing/invalid. */
export async function sequenceAsset(
  character: Character,
  projectDir: string,
  sequenceDir: string,
): Promise<Extract<ActorAsset, { kind: 'splat-sequence' }> | null> {
  try {
    const seq = validateSequence(JSON.parse(await readFile(join(sequenceDir, 'sequence.json'), 'utf8')));
    const buf = await readFile(join(sequenceDir, seq.frames[0]!));
    const ply = parseGaussianPly(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, seq.frames[0]);
    const measured = measurePly(ply, seq.avatarFrame ? 1 : -1).height;
    const nativeHeight = measured > 0 ? measured : seq.nativeHeight;
    if (!nativeHeight || !(nativeHeight > 0)) return null;
    return {
      kind: 'splat-sequence',
      characterId: character.id,
      sequenceDir: relative(projectDir, sequenceDir).split(sep).join('/'),
      fps: seq.fps,
      nativeHeight: Math.round(nativeHeight * 1e4) / 1e4,
      heightMeters: HEIGHT_METERS,
    };
  } catch {
    return null;
  }
}

async function readReceipt(path: string): Promise<ReceiptState | undefined> {
  try {
    const r = JSON.parse(await readFile(path, 'utf8')) as ReceiptState;
    return { status: r.status, resultStatus: r.resultStatus };
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A high-detail build that could not be made; the standard build stays in use. */
export class ActorBuildError extends Error {
  override name = 'ActorBuildError';
}

export async function buildActor(opts: BuildActorOptions, overrides: Partial<ActorDeps> = {}): Promise<ActorAsset> {
  const { character, projectDir, log } = opts;
  const detail = opts.detail ?? 'standard';
  const deps = { ...defaultDeps(), ...overrides };
  const actorDir = actorDirFor(projectDir, character.id, detail);
  const sequenceDir = join(actorDir, 'sequence');
  // one reference per character, shared by every detail level
  const referencePath = join(actorDirFor(projectDir, character.id), 'reference.png');
  const receiptPath = join(actorDir, 'recovery-receipt.json');
  const fallback = (reason: string): ActorAsset => {
    if (detail !== 'standard') throw new ActorBuildError(reason);
    log(`fallback mannequin (${reason})`);
    const asset = fallbackActor(character);
    return opts.mock ? asset : { ...asset, fallback: true };
  };
  const withDetail = (a: Extract<ActorAsset, { kind: 'splat-sequence' }>): ActorAsset =>
    detail === 'standard' ? a : { ...a, detail };
  try {
    const cached = opts.mock ? null : await sequenceAsset(character, projectDir, sequenceDir);
    const plan = planActor({
      mock: opts.mock,
      hasModal: !!(deps.keys.modalTokenId && deps.keys.modalTokenSecret),
      hasOpenAI: !!deps.keys.openai,
      hasReference: await exists(referencePath),
      sequenceValid: !!cached,
      receipt: await readReceipt(receiptPath),
    });
    if (plan.action === 'fallback') return fallback(plan.reason);
    if (plan.action === 'cached') {
      log(`reusing LHM sequence ${cached!.sequenceDir}`);
      return withDetail(cached!);
    }
    await mkdir(actorDir, { recursive: true });
    let outcome: WorkerResult;
    if (plan.action === 'run') {
      // a receipt that never reached Modal ('prepared') is stale: keep it, but out of the way
      if (await exists(receiptPath)) await rename(receiptPath, `${receiptPath}.${Date.now()}.stale`);
      if (plan.needsReference) {
        log(`generating reference image (${IMAGE_MODELS.join(' -> ')}, 1024x1536)`);
        await deps.generateReference(referencePrompt(character), referencePath, log);
      }
      log(
        detail === 'high'
          ? 'running LHM-1B + fine-tune on Modal (L4), about 5 minutes'
          : 'running LHM on Modal (L4); first call includes a cold image pull',
      );
      outcome = await deps.runWorker(workerArgs(referencePath, actorDir, detail), log);
    } else {
      log('recovering a previous LHM call from its receipt (no new inference)');
      outcome = await deps.runWorker(['--recover', receiptPath], log);
    }
    const deadline = Date.now() + deps.timeoutMs;
    while (!outcome.ok && outcome.code === 3 && Date.now() < deadline) {
      await sleep(deps.pollSeconds * 1000);
      outcome = await deps.runWorker(['--recover', receiptPath], log);
    }
    if (!outcome.ok) return fallback(String(outcome.result?.error ?? `worker exited ${outcome.code}`).slice(0, 300));
    const asset = await sequenceAsset(character, projectDir, sequenceDir);
    if (!asset) return fallback('worker reported success but the sequence is invalid');
    const cost = outcome.result?.estimatedComputeUSD;
    log(`LHM avatar ready: ${asset.sequenceDir} @ ${asset.fps} fps${typeof cost === 'number' ? ` (~$${cost.toFixed(3)} GPU)` : ''}`);
    return withDetail(asset);
  } catch (err) {
    if (err instanceof ActorBuildError) throw err;
    return fallback(err instanceof Error ? err.message : String(err));
  }
}
