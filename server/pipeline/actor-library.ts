// Actors library: LHM avatars generated once (Modal, ~$0.08 and a few GPU minutes each) and reused
// by every later live project with the same character id, mirroring the world library.
//
//   <ACTORS_LIBRARY_DIR = data/actors-library>/<characterId>/sequence/sequence.json  (+ frames)
//
// A slim sequence (frame_000.ply + the wander.person-motion/1 track) is enough: the browser
// decodes every other frame from the track. A match is copied (APFS clone where possible) into
// <project>/actors/<characterId>/sequence/ and becomes a splat-sequence ActorAsset.
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ActorAsset } from '../../shared/schema.ts';
import { validateSequence, type ActorSequence } from '../../shared/actor-sequence.ts';
import { HEIGHT_METERS } from './actors.ts';
import { exists, readJson } from './fsutil.ts';

export interface LibraryActor {
  characterId: string;
  sequenceDir: string;
  sequence: ActorSequence;
}

const plainFile = (f: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(f);

/** The library avatar for `characterId`, or null when there is none or it is not playable. */
export async function findLibraryActor(
  libraryDir: string,
  characterId: string,
  log: (m: string) => void = () => {},
): Promise<LibraryActor | null> {
  if (!plainFile(characterId)) return null;
  const sequenceDir = join(libraryDir, characterId, 'sequence');
  const raw = await readJson(join(sequenceDir, 'sequence.json')).catch(() => undefined);
  if (raw === undefined) return null;
  let sequence: ActorSequence;
  try {
    sequence = validateSequence(raw);
  } catch (e) {
    log(`library actor ${characterId}: ${(e as Error).message}; ignoring`);
    return null;
  }
  // frame 0 always; the rest either from the motion track or as individual PLYs
  const needed = sequence.motion ? [sequence.frames[0]!, sequence.motion.file] : sequence.frames;
  for (const f of needed) {
    if (!(await exists(join(sequenceDir, f)))) {
      log(`library actor ${characterId}: ${f} missing; ignoring`);
      return null;
    }
  }
  if (!(sequence.nativeHeight && sequence.nativeHeight > 0)) {
    log(`library actor ${characterId}: sequence.json has no nativeHeight; ignoring`);
    return null;
  }
  return { characterId, sequenceDir, sequence };
}

/**
 * Copies the library sequence into `<projectDir>/actors/<characterId>/sequence/` and returns the
 * splat-sequence asset for it (sequenceDir project-root relative, nativeHeight from sequence.json).
 */
export async function copyLibraryActor(found: LibraryActor, projectDir: string): Promise<ActorAsset> {
  const dest = join(projectDir, 'actors', found.characterId, 'sequence');
  await mkdir(dest, { recursive: true });
  for (const e of await readdir(found.sequenceDir, { withFileTypes: true })) {
    if (!e.isFile() || !plainFile(e.name) || e.name.endsWith('.part')) continue;
    await copyFile(join(found.sequenceDir, e.name), join(dest, e.name), constants.COPYFILE_FICLONE);
  }
  // a "High detail" rebuild refreshed this copy (the worker writes `detail` into sequence.json)
  const high = (found.sequence as { detail?: unknown }).detail === 'high';
  return {
    kind: 'splat-sequence',
    characterId: found.characterId,
    sequenceDir: relative(projectDir, dest).split(sep).join('/'),
    fps: found.sequence.fps,
    nativeHeight: Math.round(found.sequence.nativeHeight! * 1e4) / 1e4,
    heightMeters: HEIGHT_METERS,
    ...(high ? { detail: 'high' as const } : {}),
  };
}
