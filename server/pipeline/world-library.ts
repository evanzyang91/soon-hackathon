// World library: Marble worlds generated once (e.g. with `cli.ts generate-world … data/marble/<key>`)
// and reused by every later live project whose scene matches, so re-running the real pipeline on
// the same screenplay never spends Marble credits twice.
//
//   <WORLD_LIBRARY_DIR = data/marble>/<key>/world-asset.json   (+ the files it names)
//
// key = the scene slug without its INT./EXT. prefix: ext-city-street-night → city-street-night,
// int-kitchen-morning → kitchen-morning, int-ext-car-day → car-day. A match is copied (APFS clone
// where possible) into the scene's world dir, receipt included, so the scene stays self-contained
// and a later world retry verifies it from disk without any network.
import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WorldAsset } from '../../shared/schema.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { ASSET_FILE, RECEIPT_FILE } from './marble.ts';

/** Library key for a scene slug: the location/time words without the INT./EXT. prefix. */
export function libraryKey(slug: string): string {
  return slug.replace(/^(?:int-ext|ext-int|i-e|int|ext)-(?=.)/, '');
}

export interface LibraryWorld {
  key: string;
  dir: string;
  asset: WorldAsset;
}

/** Every file a world asset names (relative to its directory), the ground field included. */
export function assetFiles(a: WorldAsset): string[] {
  const files = [a.spz.k500, a.spz.k100, a.spz.full, a.colliderGlb, a.thumbnail, a.ground?.file];
  return [...new Set(files.filter((f): f is string => !!f))];
}

const plainFile = (f: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(f);

/**
 * The library world for `slug`, or null when there is none (or it is incomplete: a world-asset.json
 * that does not validate, or names a file that is missing). A missing ground field only drops
 * `ground`: the world is still good, and the pipeline measures the field again after the copy.
 */
export async function findLibraryWorld(
  libraryDir: string,
  slug: string,
  log: (m: string) => void = () => {},
): Promise<LibraryWorld | null> {
  const key = libraryKey(slug);
  const dir = join(libraryDir, key);
  const raw = await readJson(join(dir, ASSET_FILE)).catch(() => undefined);
  if (raw === undefined) return null;
  const parsed = WorldAsset.safeParse(raw);
  if (!parsed.success) {
    log(`library world ${key}: invalid ${ASSET_FILE}; ignoring`);
    return null;
  }
  let asset = parsed.data;
  if (asset.ground && !(plainFile(asset.ground.file) && (await exists(join(dir, asset.ground.file))))) {
    log(`library world ${key}: ${asset.ground.file} missing; the ground field will be measured again`);
    const { ground: _missing, ...rest } = asset;
    asset = rest;
  }
  for (const f of assetFiles(asset)) {
    if (!plainFile(f) || !(await exists(join(dir, f)))) {
      log(`library world ${key}: ${f} missing; ignoring`);
      return null;
    }
  }
  return { key, dir, asset };
}

/**
 * Copies a library world into `outDir` (asset files, receipt, provider metadata) and writes its
 * world-asset.json there. Returns the asset; its paths stay filenames relative to `outDir`.
 */
export async function copyLibraryWorld(world: LibraryWorld, outDir: string): Promise<WorldAsset> {
  await mkdir(outDir, { recursive: true });
  // scale-calibration.json: the measurements behind asset.scaleCalibration (calibrate.ts)
  const extras = [RECEIPT_FILE, 'marble-world.json', 'scale-calibration.json'];
  for (const f of [...assetFiles(world.asset), ...extras]) {
    const src = join(world.dir, f);
    if (!(await exists(src))) continue; // only the extras are optional (checked in find)
    await copyFile(src, join(outDir, f), constants.COPYFILE_FICLONE);
  }
  const asset: WorldAsset = { ...world.asset };
  if (!asset.caption) {
    const meta = await readJson<{ caption?: unknown }>(join(world.dir, 'marble-world.json')).catch(
      () => undefined,
    );
    if (typeof meta?.caption === 'string' && meta.caption.trim())
      asset.caption = meta.caption.trim().slice(0, 2000);
  }
  const checked = WorldAsset.parse(asset);
  await writeJsonAtomic(join(outDir, ASSET_FILE), checked);
  return checked;
}
