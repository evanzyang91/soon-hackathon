import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScenePlan } from '../../shared/schema.ts';
import {
  bundledClipFor,
  gestureKey,
  mergeLibraries,
  MOTION_SCHEMA,
  resolveSceneMotion,
  type MotionDeps,
  type MotionLibraryJson,
} from './motion.ts';

/** A one-clip library like worker/motion_library.py --gestures writes (bytes are arbitrary). */
function oneClip(name: string, frames: number, fill: number) {
  const bin = Buffer.alloc(frames * (22 * 8 + 12), fill);
  const json: MotionLibraryJson = {
    schema: MOTION_SCHEMA,
    fps: 30,
    joints: 22,
    file: `${name}.bin`,
    bytes: bin.length,
    sha256: createHash('sha256').update(bin).digest('hex'),
    clips: [{ name, pose: 'standing', frames, offset: 0, oneShot: true }],
  };
  return { json, bin };
}

const scene = (): ScenePlan =>
  ({
    index: 0,
    slug: 'ext-street',
    heading: 'EXT. STREET - NIGHT',
    action: '',
    worldPrompt: 'w',
    timeOfDay: 'night',
    interior: false,
    characterIds: ['maya', 'theo'],
    dialogue: [],
    dynamics: [],
    shots: [],
    blocking: [
      {
        characterId: 'maya',
        position: [0, 0, -3],
        yaw: 0,
        pose: 'standing',
        beats: [
          {
            t: 1,
            action: 'throws up her hands',
            gesture: 'A person throws both hands up, then lets them drop.',
          },
          { t: 4, action: 'walks off', moveTo: [2, 0, -3], gesture: 'ignored for a walk' },
        ],
      },
      {
        characterId: 'theo',
        position: [1, 0, -3],
        yaw: 0,
        pose: 'sitting',
        beats: [
          {
            t: 2,
            action: 'rubs his eyes',
            gesture: 'A person rubs both eyes with the heels of the hands.',
          },
        ],
      },
    ],
  }) as ScenePlan;

describe('gesture clips', () => {
  it('keys are stable per prompt and pose, and look like clip names', () => {
    const k = gestureKey('A person shrugs.', 'standing');
    expect(k).toMatch(/^gesture-[0-9a-f]{16}$/);
    expect(gestureKey(' A person shrugs. ', 'standing')).toBe(k);
    expect(gestureKey('A person shrugs.', 'sitting')).not.toBe(k);
  });

  it('falls back to the nearest shared clip by keyword', () => {
    expect(bundledClipFor('A person shrugs with both palms up', false)).toBe('talk-2');
    expect(bundledClipFor('points down the street', false)).toBe('talk-1');
    expect(bundledClipFor('nods slowly', true)).toBe('sit-idle');
    expect(bundledClipFor('slams the table', false)).toBeNull();
  });

  it('merges one-clip libraries: offsets realigned to 4 bytes, sha256 of the result', () => {
    const a = oneClip('a', 3, 1);
    const b = oneClip('b', 5, 2);
    const m = mergeLibraries([a, b]);
    expect(m.json.clips.map((c) => [c.name, c.offset])).toEqual([
      ['a', 0],
      ['b', a.bin.length],
    ]);
    expect(m.json.bytes).toBe(m.bin.length);
    expect(m.json.sha256).toBe(createHash('sha256').update(m.bin).digest('hex'));
    expect(m.bin.subarray(a.bin.length, a.bin.length + 4)).toEqual(Buffer.from([2, 2, 2, 2]));
    expect(() => mergeLibraries([{ ...a, bin: Buffer.alloc(1) }])).toThrow(/invalid/);
  });

  it('without generation every gesture beat gets a shared clip or none, and no library', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-'));
    const r = await resolveSceneMotion(scene(), {
      sceneDir: dir,
      sceneRel: 'scene-0',
      cacheDir: join(dir, 'cache'),
      generate: false,
      log: () => {},
    });
    expect(r.motion).toBeUndefined();
    const [maya, theo] = r.scene.blocking;
    expect(maya!.beats![0]!.clip).toBe('talk-2'); // "throws up her hands"
    expect(maya!.beats![1]!.clip).toBeUndefined(); // walks carry no gesture clip
    expect(theo!.beats![0]!.clip).toBeUndefined(); // nothing close for "rubs his eyes"
  });

  it('generates only missing prompts, once, and points the manifest at the merged library', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-'));
    const cacheDir = join(dir, 'cache');
    const specs: unknown[] = [];
    const deps: MotionDeps = {
      async runWorker(specPath, out) {
        const spec = JSON.parse(await readFile(specPath, 'utf8')) as {
          gestures: { key: string }[];
        };
        specs.push(spec);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(out, { recursive: true });
        for (const [i, g] of spec.gestures.entries()) {
          const c = oneClip(g.key, 4 + i, i + 1);
          await writeFile(join(out, `${g.key}.bin`), c.bin);
          await writeFile(join(out, `${g.key}.json`), JSON.stringify(c.json));
        }
        return { generated: spec.gestures.length };
      },
    };
    const opts = {
      sceneDir: dir,
      sceneRel: 'scene-0',
      cacheDir,
      generate: true,
      log: () => {},
      deps,
    };
    const r = await resolveSceneMotion(scene(), opts);
    expect(specs).toHaveLength(1);
    expect((specs[0] as { gestures: { pose: string }[] }).gestures.map((g) => g.pose)).toEqual([
      'standing',
      'sitting',
    ]);
    expect(r.motion).toEqual({ library: 'scene-0/motion/motion-library.json' });
    const lib = JSON.parse(await readFile(join(dir, 'motion', 'motion-library.json'), 'utf8'));
    const keys = lib.clips.map((c: { name: string }) => c.name);
    expect(r.scene.blocking[0]!.beats![0]!.clip).toBe(keys[0]);
    expect(r.scene.blocking[1]!.beats![0]!.clip).toBe(keys[1]);
    // the second scene with the same prompts hits the cache: no worker call
    await resolveSceneMotion(scene(), opts);
    expect(specs).toHaveLength(1);
  });

  it('a failed generation falls back to the shared clips without failing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'motion-'));
    const logs: string[] = [];
    const r = await resolveSceneMotion(scene(), {
      sceneDir: dir,
      sceneRel: 'scene-0',
      cacheDir: join(dir, 'cache'),
      generate: true,
      log: (m) => logs.push(m),
      deps: { runWorker: async () => Promise.reject(new Error('L4 needs billing')) },
    });
    expect(r.motion).toBeUndefined();
    expect(r.scene.blocking[0]!.beats![0]!.clip).toBe('talk-2');
    expect(logs.some((l) => /generation failed.*billing/.test(l))).toBe(true);
  });
});
