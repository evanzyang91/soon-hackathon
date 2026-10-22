import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActorAsset, type Character } from '../../shared/schema.ts';
import {
  ActorBuildError,
  FALLBACK_GLB,
  actorDirFor,
  buildActor,
  planActor,
  referencePrompt,
  type ActorDeps,
  type PhotoInput,
  type WorkerResult,
} from '../../server/pipeline/actors.ts';
import { decodePng, encodePng } from '../../server/pipeline/reprompt/png.ts';

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
  it("a director's photo can always become the reference, even without an OpenAI key", () => {
    expect(planActor({ ...base, hasOpenAI: false, photo: true })).toEqual({ action: 'run', needsReference: true, fromPhoto: true });
    expect(planActor({ ...base, hasReference: true, photo: true })).toEqual({ action: 'run', needsReference: false, fromPhoto: true });
    expect(planActor({ ...base, photo: true, sequenceValid: true })).toEqual({ action: 'cached' });
    expect(planActor({ ...base, photo: true, mock: true }).action).toBe('fallback');
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
    expect(asset.fallback).toBeUndefined(); // MOCK mannequins are final
  });

  it('without Modal keys is free and offline: no reference image is generated', async () => {
    const asset = await buildActor(opts(), deps(async () => ({ ok: true, code: 0 }), { ...keys, modalTokenId: '', modalTokenSecret: '' }));
    expect(asset.kind).toBe('glb-humanoid');
    expect(asset.fallback).toBe(true);
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

  it('every body kind stands at the character’s planned height (1.7 when the plan has none)', async () => {
    const tall = { ...maya, heightMeters: 1.84 };
    await writeSequence(join(projectDir, 'actors', 'maya', 'sequence'), 1.62);
    const seq = await buildActor({ ...opts(), character: tall }, deps(async () => ({ ok: false, code: 1 })));
    expect(seq).toMatchObject({ kind: 'splat-sequence', heightMeters: 1.84 });
    const mannequin = await buildActor({ ...opts(true), character: tall }, deps(async () => ({ ok: true, code: 0 })));
    expect(mannequin).toMatchObject({ kind: 'glb-humanoid', heightMeters: 1.84 });
    expect(await buildActor(opts(true), deps(async () => ({ ok: true, code: 0 })))).toMatchObject({ heightMeters: 1.7 });
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
    expect(asset.fallback).toBe(true); // live fallback: project.ts must not cache it as final
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

  describe("detail 'high'", () => {
    const high = () => ({ ...opts(), detail: 'high' as const });

    it('builds into actors/<id>/high/ from the shared reference with --detail high', async () => {
      await mkdir(join(projectDir, 'actors', 'maya'), { recursive: true });
      await writeFile(join(projectDir, 'actors', 'maya', 'reference.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
      const asset = ActorAsset.parse(
        await buildActor(
          high(),
          deps(async (args) => {
            const out = args[args.indexOf('--out') + 1]!;
            await writeSequence(join(out, 'sequence'), 1.75);
            return { ok: true, code: 0, result: { ok: true, estimatedComputeUSD: 0.11 } };
          }),
        ),
      );
      expect(images).toBe(0); // the standard build's reference is reused
      expect(calls[0]).toEqual([
        '--image', join(projectDir, 'actors/maya/reference.png'),
        '--out', join(projectDir, 'actors/maya/high'),
        '--frames', '48', '--talk-frames', '24', '--fps', '12', '--detail', 'high',
      ]);
      expect(asset).toMatchObject({ kind: 'splat-sequence', detail: 'high', sequenceDir: 'actors/maya/high/sequence' });
    });

    it('reuses a finished high build without a worker call, and leaves the standard one alone', async () => {
      await writeSequence(join(projectDir, 'actors', 'maya', 'sequence'), 1.6);
      await writeSequence(join(actorDirFor(projectDir, 'maya', 'high'), 'sequence'), 1.75);
      const asset = await buildActor(high(), deps(async () => ({ ok: false, code: 1 })));
      expect(asset).toMatchObject({ detail: 'high', sequenceDir: 'actors/maya/high/sequence' });
      expect(calls).toEqual([]);
      const standard = await buildActor(opts(), deps(async () => ({ ok: false, code: 1 })));
      expect(standard).toMatchObject({ sequenceDir: 'actors/maya/sequence' });
      expect('detail' in standard).toBe(false);
    });

    it('never returns a mannequin: failures throw so the caller keeps the standard build', async () => {
      await expect(
        buildActor(high(), deps(async () => ({ ok: false, code: 1, result: { ok: false, error: 'CUDA out of memory' } }))),
      ).rejects.toThrow(/CUDA out of memory/);
      await expect(buildActor({ ...high(), mock: true }, deps(async () => ({ ok: true, code: 0 })))).rejects.toBeInstanceOf(ActorBuildError);
      await expect(
        buildActor(high(), deps(async () => ({ ok: true, code: 0 }), { ...keys, modalTokenId: '', modalTokenSecret: '' })),
      ).rejects.toThrow(/Modal keys absent/);
    });
  });

  it('reference prompt asks for the LHM-friendly framing', () => {
    const p = referencePrompt(maya);
    for (const s of ['Full-body', 'front-facing', 'slightly away from the body', 'neutral expression', 'light-grey', 'soft even lighting', 'photoreal'])
      expect(p).toContain(s);
  });

  describe("a director's photo (Character.referenceImage)", () => {
    const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
    /** A solid-colour landscape "photo" (the worker wants a portrait: it gets letterboxed). */
    const photo = (rgb: [number, number, number], width = 60, height = 40) =>
      encodePng({ width, height, channels: 3, data: new Uint8Array(width * height * 3).map((_, i) => rgb[i % 3]!) });
    const leo = (file: string): Character => ({ ...maya, referenceImage: file });
    let normalised: PhotoInput[];
    const photoDeps = (k = keys) => ({
      ...deps(async (args) => {
        await writeSequence(join(args[args.indexOf('--out') + 1]!, 'sequence'), 1.7);
        return { ok: true, code: 0, result: { ok: true } };
      }, k),
      normalisePhoto: async (p: PhotoInput, out: string) => {
        normalised.push(p);
        await writeFile(out, photo([200, 200, 200], 4, 6));
        return { model: 'gpt-image-1.5' };
      },
    });
    const upload = async (name: string, png: Buffer) => {
      await mkdir(join(projectDir, 'uploads'), { recursive: true });
      await writeFile(join(projectDir, 'uploads', name), png);
      return png;
    };
    const actorFile = (f: string) => join(projectDir, 'actors', 'maya', f);
    beforeEach(() => {
      normalised = [];
    });

    it('is normalised with images/edits, built with LHM, cached by its sha256; a new photo is a new build', async () => {
      const a = await upload('a.png', photo([180, 40, 40]));
      const asset = await buildActor({ ...opts(), character: leo('uploads/a.png') }, photoDeps());
      expect(asset).toMatchObject({ kind: 'splat-sequence', sequenceDir: 'actors/maya/sequence' });
      expect(images).toBe(0); // no reference generated from the description
      expect(normalised.map((p) => [p.mime, sha(p.bytes)])).toEqual([['image/png', sha(a)]]);
      expect(calls[0]!.slice(0, 2)).toEqual(['--image', actorFile('reference.png')]);
      expect(sha(await readFile(actorFile('reference-source.png')))).toBe(sha(a));
      expect(JSON.parse(await readFile(actorFile('reference.json'), 'utf8'))).toMatchObject({
        from: 'photo',
        source: 'uploads/a.png',
        sourceSha256: sha(a),
        method: 'openai-edit',
        model: 'gpt-image-1.5',
      });
      expect(JSON.parse(await readFile(actorFile('build-source.json'), 'utf8'))).toMatchObject({ referenceSha256: sha(a) });
      expect(logs.some((l) => l.endsWith('built from your photo'))).toBe(true);

      // the same photo again: the build is reused, nothing is paid for
      calls.length = 0;
      await buildActor({ ...opts(), character: leo('uploads/a.png') }, photoDeps());
      expect([calls.length, normalised.length]).toEqual([0, 1]);

      // another photo is another person: the sequence and its reference are not reused
      const b = await upload('b.png', photo([40, 40, 180]));
      await buildActor({ ...opts(), character: leo('uploads/b.png') }, photoDeps());
      expect(calls).toHaveLength(1);
      expect(sha(normalised.at(-1)!.bytes)).toBe(sha(b));
      expect(JSON.parse(await readFile(actorFile('reference.json'), 'utf8')).sourceSha256).toBe(sha(b));
      expect(await readdir(join(projectDir, 'actors', 'maya'))).toContain(`reference.${sha(a).slice(0, 12)}.png`);
    });

    it('MOCK and key-less builds use the photo itself, letterboxed to the portrait PNG the worker takes', async () => {
      await upload('a.png', photo([180, 40, 40]));
      const mocked = await buildActor({ ...opts(true), character: leo('uploads/a.png') }, photoDeps());
      expect(mocked.kind).toBe('glb-humanoid');
      expect([calls.length, normalised.length, images]).toEqual([0, 0, 0]);
      const ref = decodePng(await readFile(actorFile('reference.png')));
      expect([ref.width, ref.height]).toEqual([60, 90]);
      expect(JSON.parse(await readFile(actorFile('reference.json'), 'utf8')).method).toBe('as-is');

      // live without OPENAI_API_KEY: LHM runs on the photo as it is
      const live = await buildActor({ ...opts(), character: leo('uploads/a.png') }, photoDeps({ ...keys, openai: '' }));
      expect(live.kind).toBe('splat-sequence');
      expect([calls.length, normalised.length]).toEqual([1, 0]);
    });
  });
});
