import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActorAsset, type Character } from '../../shared/schema.ts';
import {
  FALLBACK_GLB,
  buildActor,
  planActor,
  referencePrompt,
  type ActorDeps,
  type WorkerResult,
} from '../../server/pipeline/actors.ts';

const maya: Character = {
  id: 'maya',
  name: 'MAYA',
  description: 'A woman in her thirties, short dark hair, green raincoat, jeans, white sneakers.',
  voice: { id: 'coral', gender: 'female' },
};
const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];

/** A packaged-looking avatar: feet at 0, `height` tall, plus faint outliers that must be ignored. */
function ply(height: number, n = 400): Buffer {
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${PROPS.map((p) => `property float ${p}\n`).join('')}end_header\n`;
  const data = new Float32Array(n * PROPS.length);
  for (let i = 0; i < n; i++) {
    const o = i * PROPS.length;
    const faint = i >= n - 4;
    data[o + 1] = faint ? height * 3 : (height * i) / (n - 5);
    data[o + 6] = faint ? -8 : 4; // opacity logit
    data[o + 10] = 1;
  }
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(data.buffer)]);
}

async function writeSequence(dir: string, height = 1.62, count = 3) {
  await mkdir(dir, { recursive: true });
  const frames = Array.from({ length: count }, (_, i) => `frame_${String(i).padStart(3, '0')}.ply`);
  const hashes: string[] = [];
  for (const f of frames) {
    const b = ply(height);
    await writeFile(join(dir, f), b);
    hashes.push(createHash('sha256').update(b).digest('hex'));
  }
  await writeFile(
    join(dir, 'sequence.json'),
    JSON.stringify({
      schema: 'previz.actor-sequence/1',
      frames,
      count,
      fps: 12,
      frame_sha256: hashes,
      avatarFrame: { up: [0, 1, 0], forward: [0, 0, -1], feetY: 0, centered: true },
      nativeHeight: height,
      loops: { idle: { start: 0, count: count - 1 }, talk: { start: count - 1, count: 1 } },
    }),
  );
}

const keys = { openai: 'sk-test', modalTokenId: 'ak-test', modalTokenSecret: 'as-test' };

describe('planActor', () => {
  const base = { mock: false, hasModal: true, hasOpenAI: true, hasReference: false, sequenceValid: false };
  it('is always the free fallback under MOCK, even with a cached sequence', () => {
    expect(planActor({ ...base, mock: true, sequenceValid: true })).toEqual({ action: 'fallback', reason: 'MOCK' });
  });
  it('reuses a valid sequence before checking keys', () => {
    expect(planActor({ ...base, hasModal: false, sequenceValid: true })).toEqual({ action: 'cached' });
  });
  it('falls back without Modal keys, or without both a reference and an OpenAI key', () => {
    expect(planActor({ ...base, hasModal: false }).action).toBe('fallback');
    expect(planActor({ ...base, hasOpenAI: false }).action).toBe('fallback');
    expect(planActor({ ...base, hasOpenAI: false, hasReference: true })).toEqual({ action: 'run', needsReference: false });
  });
  it('generates a reference only when it is missing', () => {
    expect(planActor(base)).toEqual({ action: 'run', needsReference: true });
    expect(planActor({ ...base, hasReference: true })).toEqual({ action: 'run', needsReference: false });
  });
  it('recovers an in-flight receipt, never resubmits a finished failure', () => {
    expect(planActor({ ...base, receipt: { status: 'waiting' } })).toEqual({ action: 'recover' });
    expect(planActor({ ...base, receipt: { status: 'wait_interrupted' } })).toEqual({ action: 'recover' });
    expect(planActor({ ...base, receipt: { status: 'recovered', resultStatus: 'complete' } })).toEqual({ action: 'recover' });
    const failed = planActor({ ...base, receipt: { status: 'recovered', resultStatus: 'failed' } });
    expect(failed.action).toBe('fallback');
    expect(planActor({ ...base, receipt: { status: 'prepared' } })).toEqual({ action: 'run', needsReference: true });
  });
});

describe('buildActor', () => {
  let projectDir = '';
  let calls: string[][];
  let images: number;
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'actors-'));
    calls = [];
    images = 0;
    logs.length = 0;
  });
  afterEach(() => rm(projectDir, { recursive: true, force: true }));

  const deps = (runWorker: (args: string[]) => Promise<WorkerResult>, k = keys): Partial<ActorDeps> => ({
    keys: k,
    generateReference: async (prompt, out) => {
      images++;
      expect(prompt).toContain(maya.description);
      await writeFile(out, Buffer.from('89504e470d0a1a0a', 'hex'));
    },
    runWorker: (args) => {
      calls.push(args);
      return runWorker(args);
    },
    pollSeconds: 0,
    timeoutMs: 5_000,
  });
  const opts = (mock = false) => ({ character: maya, projectDir, sceneDir: join(projectDir, 'actors', 'maya'), mock, log });

  it('MOCK returns the tinted procedural mannequin and touches nothing', async () => {
    const asset = ActorAsset.parse(await buildActor(opts(true), deps(async () => ({ ok: true, code: 0 }))));
    expect(asset).toMatchObject({ kind: 'glb-humanoid', characterId: 'maya', glb: FALLBACK_GLB, clips: { idle: 'Idle', talk: 'Talk', walk: 'Walk' } });
    expect(asset.kind === 'glb-humanoid' && asset.tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(calls).toEqual([]);
    expect(images).toBe(0);
    expect(await readdir(projectDir)).toEqual([]);
  });

  it('without Modal keys is free and offline: no reference image is generated', async () => {
    const asset = await buildActor(opts(), deps(async () => ({ ok: true, code: 0 }), { ...keys, modalTokenId: '', modalTokenSecret: '' }));
    expect(asset.kind).toBe('glb-humanoid');
    expect(images).toBe(0);
    expect(calls).toEqual([]);
  });

  it('reuses an existing sequence and measures nativeHeight from frame_000 (ignoring faint outliers)', async () => {
    await writeSequence(join(projectDir, 'actors', 'maya', 'sequence'), 1.62);
    const asset = ActorAsset.parse(await buildActor(opts(), deps(async () => ({ ok: false, code: 1 }))));
    expect(asset).toMatchObject({ kind: 'splat-sequence', sequenceDir: 'actors/maya/sequence', fps: 12, heightMeters: 1.7 });
    expect(asset.kind === 'splat-sequence' && asset.nativeHeight).toBeCloseTo(1.62, 1);
    expect(calls).toEqual([]);
  });

  it('real path: reference -> run_actor -> splat-sequence', async () => {
    const asset = await buildActor(
      opts(),
      deps(async (args) => {
        const out = args[args.indexOf('--out') + 1]!;
        await writeSequence(join(out, 'sequence'), 1.7);
        return { ok: true, code: 0, result: { ok: true, estimatedComputeUSD: 0.12 } };
      }),
    );
    expect(images).toBe(1);
    expect(calls[0]).toEqual(['--image', join(projectDir, 'actors/maya/reference.png'), '--out', join(projectDir, 'actors/maya'), '--frames', '48', '--talk-frames', '24', '--fps', '12']);
    expect(asset.kind).toBe('splat-sequence');
  });

  it('polls --recover while the Modal call is still running', async () => {
    let n = 0;
    const asset = await buildActor(
      opts(),
      deps(async (args) => {
        if (++n < 3) return { ok: false, code: 3, result: { ok: false, running: true } };
        await writeSequence(join(projectDir, 'actors', 'maya', 'sequence'));
        expect(args[0]).toBe('--recover');
        return { ok: true, code: 0, result: { ok: true } };
      }),
    );
    expect(asset.kind).toBe('splat-sequence');
    expect(calls.map((c) => c[0])).toEqual(['--image', '--recover', '--recover']);
  });

  it('any worker failure falls back to the mannequin', async () => {
    const asset = await buildActor(opts(), deps(async () => ({ ok: false, code: 1, result: { ok: false, error: 'InvalidError: Please add a payment method to use L4 GPU functions.' } })));
    expect(asset.kind).toBe('glb-humanoid');
    expect(logs.some((l) => l.includes('payment method'))).toBe(true);
  });

  it('a reference-image failure falls back too', async () => {
    const asset = await buildActor(opts(), {
      ...deps(async () => ({ ok: true, code: 0 })),
      generateReference: async () => {
        throw new Error('OpenAI image HTTP 400');
      },
    });
    expect(asset.kind).toBe('glb-humanoid');
    expect(calls).toEqual([]);
  });

  it('a finished failed receipt is not resubmitted', async () => {
    const dir = join(projectDir, 'actors', 'maya');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'recovery-receipt.json'), JSON.stringify({ status: 'recovered', resultStatus: 'failed' }));
    const asset = await buildActor(opts(), deps(async () => ({ ok: true, code: 0 })));
    expect(asset.kind).toBe('glb-humanoid');
    expect(calls).toEqual([]);
  });

  it('reference prompt asks for the LHM-friendly framing', () => {
    const p = referencePrompt(maya);
    for (const s of ['Full-body', 'front-facing', 'slightly away from the body', 'neutral expression', 'light-grey', 'soft even lighting', 'photoreal'])
      expect(p).toContain(s);
  });
});
