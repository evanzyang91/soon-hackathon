import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ActorAsset } from '../../shared/schema.ts';
import { copyLibraryActor, findLibraryActor } from './actor-library.ts';

const H = 'a'.repeat(64);
/** A slim library sequence: frame_000.ply + motion track, the way the LHM worker packages it. */
async function writeLibraryActor(lib: string, id: string, over: Record<string, unknown> = {}) {
  const dir = join(lib, id, 'sequence');
  await mkdir(dir, { recursive: true });
  const frames = Array.from({ length: 6 }, (_, i) => `frame_${String(i).padStart(3, '0')}.ply`);
  const seq = {
    frames,
    count: 6,
    fps: 12,
    nativeHeight: 1.812259935736556,
    loops: { idle: { start: 0, count: 4 }, talk: { start: 4, count: 2 } },
    motion: {
      schema: 'wander.person-motion/1',
      file: 'motion.u16',
      dtype: 'uint16',
      frames: 6,
      splats: 10,
      channels: ['x', 'y', 'z', 'rot_0', 'rot_1', 'rot_2', 'rot_3'],
      frameFiles: frames,
      base: { file: 'frame_000.ply', bytes: 3, sha256: H },
      bytes: 6 * 10 * 7 * 2,
      sha256: H,
      min: [0, 0, 0, 0, 0, 0, 0],
      scale: [1, 1, 1, 1, 1, 1, 1],
    },
    ...over,
  };
  await writeFile(join(dir, 'sequence.json'), JSON.stringify(seq));
  await writeFile(join(dir, 'frame_000.ply'), 'ply');
  await writeFile(join(dir, 'motion.u16'), Buffer.alloc(840));
  await mkdir(join(dir, 'scratch'), { recursive: true }); // subdirectories are not copied
  return dir;
}

let lib: string;
let project: string;
beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'previz-actors-lib-'));
  project = await mkdtemp(join(tmpdir(), 'previz-actors-proj-'));
});

describe('actors library', () => {
  it('finds a slim sequence by character id and copies it into the project', async () => {
    const src = await writeLibraryActor(lib, 'maya');
    const found = await findLibraryActor(lib, 'maya');
    expect(found).toMatchObject({ characterId: 'maya', sequenceDir: src });
    const asset = ActorAsset.parse(await copyLibraryActor(found!, project));
    expect(asset).toEqual({
      kind: 'splat-sequence',
      characterId: 'maya',
      sequenceDir: 'actors/maya/sequence',
      fps: 12,
      nativeHeight: 1.8123,
      heightMeters: 1.7,
    });
    for (const f of ['sequence.json', 'frame_000.ply', 'motion.u16'])
      expect(existsSync(join(project, 'actors/maya/sequence', f)), f).toBe(true);
    expect(existsSync(join(project, 'actors/maya/sequence/scratch'))).toBe(false);
    expect(await readFile(join(project, 'actors/maya/sequence/frame_000.ply'), 'utf8')).toBe('ply');
  });

  it('ignores missing, invalid or incomplete avatars', async () => {
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    expect(await findLibraryActor(lib, 'theo', log)).toBeNull();
    expect(await findLibraryActor(lib, '../maya', log)).toBeNull();
    await writeLibraryActor(lib, 'bad', { count: 3 });
    expect(await findLibraryActor(lib, 'bad', log)).toBeNull();
    const noTrack = await writeLibraryActor(lib, 'notrack', { motion: null });
    expect(existsSync(join(noTrack, 'frame_001.ply'))).toBe(false);
    expect(await findLibraryActor(lib, 'notrack', log)).toBeNull(); // needs every PLY then
    await writeLibraryActor(lib, 'tall', { nativeHeight: undefined });
    expect(await findLibraryActor(lib, 'tall', log)).toBeNull();
    expect(logs).toHaveLength(3);
  });
});
