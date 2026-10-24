import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorldAsset } from '../../shared/schema.ts';
import { ASSET_FILE, RECEIPT_FILE } from './marble.ts';
import { copyLibraryWorld, findLibraryWorld, libraryKey } from './world-library.ts';

const LIBRARY_ASSET: WorldAsset = {
  provider: 'marble',
  worldId: 'w-lib-1',
  spz: { k500: 'world_500k.spz', k100: 'world_100k.spz' },
  colliderGlb: 'collider.glb',
  thumbnail: 'thumbnail.webp',
  metricScaleFactor: 2.3,
  groundPlaneOffset: 1.3,
  opencvFrame: true,
};

/** A library world on disk the way `cli.ts generate-world` leaves it. */
async function writeLibraryWorld(libraryDir: string, key: string, asset = LIBRARY_ASSET) {
  const dir = join(libraryDir, key);
  await mkdir(dir, { recursive: true });
  for (const f of ['world_500k.spz', 'world_100k.spz', 'collider.glb', 'thumbnail.webp'])
    await writeFile(join(dir, f), `bytes of ${f}`);
  await writeFile(join(dir, RECEIPT_FILE), JSON.stringify({ status: 'complete', world_id: asset.worldId }));
  await writeFile(join(dir, 'marble-world.json'), JSON.stringify({ caption: 'A rain-slick street.' }));
  await writeFile(join(dir, ASSET_FILE), JSON.stringify(asset));
  return dir;
}

let lib: string;
beforeEach(async () => {
  lib = await mkdtemp(join(tmpdir(), 'previz-library-'));
});

describe('libraryKey', () => {
  it('drops the INT./EXT. prefix of a scene slug', () => {
    expect(libraryKey('ext-city-street-night')).toBe('city-street-night');
    expect(libraryKey('int-kitchen-morning')).toBe('kitchen-morning');
    expect(libraryKey('ext-rooftop-dusk')).toBe('rooftop-dusk');
    expect(libraryKey('int-ext-car-moving-day')).toBe('car-moving-day');
    expect(libraryKey('ext-int-barn-night')).toBe('barn-night');
    expect(libraryKey('i-e-car-day')).toBe('car-day');
  });

  it('leaves slugs without a prefix (or that are only a prefix) alone', () => {
    expect(libraryKey('rooftop-dusk')).toBe('rooftop-dusk');
    expect(libraryKey('interior-design-studio')).toBe('interior-design-studio');
    expect(libraryKey('external-stairs')).toBe('external-stairs');
    expect(libraryKey('int')).toBe('int');
  });
});

describe('findLibraryWorld', () => {
  it('finds a complete world by scene slug', async () => {
    const dir = await writeLibraryWorld(lib, 'city-street-night');
    const w = await findLibraryWorld(lib, 'ext-city-street-night');
    expect(w).toEqual({ key: 'city-street-night', dir, asset: LIBRARY_ASSET });
  });

  it('ignores missing, invalid or incomplete worlds', async () => {
    expect(await findLibraryWorld(lib, 'ext-nowhere-day')).toBeNull();
    const logs: string[] = [];
    await mkdir(join(lib, 'bad'), { recursive: true });
    await writeFile(join(lib, 'bad', ASSET_FILE), JSON.stringify({ provider: 'marble' }));
    expect(await findLibraryWorld(lib, 'int-bad', (m) => logs.push(m))).toBeNull();
    const dir = await writeLibraryWorld(lib, 'half');
    await writeFile(join(dir, ASSET_FILE), JSON.stringify({ ...LIBRARY_ASSET, spz: { k500: 'gone.spz' } }));
    expect(await findLibraryWorld(lib, 'ext-half', (m) => logs.push(m))).toBeNull();
    const evil = await writeLibraryWorld(lib, 'evil');
    await writeFile(join(evil, ASSET_FILE), JSON.stringify({ ...LIBRARY_ASSET, spz: { k500: '../half/world_500k.spz' } }));
    expect(await findLibraryWorld(lib, 'ext-evil', (m) => logs.push(m))).toBeNull();
    expect(logs).toHaveLength(3);
  });
});

describe('copyLibraryWorld', () => {
  it('copies the named files + receipt into the scene world dir and fills the caption', async () => {
    await writeLibraryWorld(lib, 'city-street-night');
    const out = join(lib, 'project', 'scene-0', 'world');
    const asset = await copyLibraryWorld((await findLibraryWorld(lib, 'ext-city-street-night'))!, out);
    expect(asset).toEqual({ ...LIBRARY_ASSET, caption: 'A rain-slick street.' });
    for (const f of ['world_500k.spz', 'world_100k.spz', 'collider.glb', 'thumbnail.webp', RECEIPT_FILE])
      expect(existsSync(join(out, f)), f).toBe(true);
    expect(await readFile(join(out, 'world_500k.spz'), 'utf8')).toBe('bytes of world_500k.spz');
    expect(JSON.parse(await readFile(join(out, ASSET_FILE), 'utf8'))).toEqual(asset);
  });

  it('carries the ground field; a missing ground.json only drops the reference', async () => {
    const ground = { file: 'ground.json', cell: 0.25, covered: 90, cells: 100 };
    const dir = await writeLibraryWorld(lib, 'rooftop-dusk', { ...LIBRARY_ASSET, ground });
    await writeFile(join(dir, 'ground.json'), '{"field":1}');
    const out = join(lib, 'project', 'scene-1', 'world');
    const asset = await copyLibraryWorld((await findLibraryWorld(lib, 'ext-rooftop-dusk'))!, out);
    expect(asset.ground).toEqual(ground);
    expect(await readFile(join(out, 'ground.json'), 'utf8')).toBe('{"field":1}');

    const bare = await writeLibraryWorld(lib, 'kitchen-morning', { ...LIBRARY_ASSET, ground });
    expect(existsSync(join(bare, 'ground.json'))).toBe(false);
    const found = await findLibraryWorld(lib, 'int-kitchen-morning');
    expect(found?.asset).toEqual(LIBRARY_ASSET);
  });
});
