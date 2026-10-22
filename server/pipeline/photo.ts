// Director-supplied reference photos (shared/chat.ts Attachment: <project>/uploads/<id>.<ext>,
// PNG / JPEG / WebP as uploaded). The actor pipeline normalises a person's photo into its
// reference.png (actors.ts); the world stage sends a place's photo to Marble as the image prompt,
// which takes PNG only (marble.ts prepareUploadBody).
//
// Node has no JPEG / WebP decoder and the repo takes no image dependency, so a non-PNG photo is
// transcoded with what the machine already has: macOS `sips`, else Pillow in the worker's Python.
// The laptop re-encodes uploads to PNG, so this is the rare path; when neither tool exists the
// caller falls back (text prompt for a world) and says so in the log.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists } from './fsutil.ts';
import { decodePng, encodePng, isPng, type Image } from './reprompt/png.ts';

export type PhotoKind = 'png' | 'jpeg' | 'webp';
export const PHOTO_MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
export const PHOTO_EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

export interface Photo {
  /** Absolute path of the upload. */
  path: string;
  /** Project-root-relative, as stored in the plan ("uploads/3f9a….png"). */
  file: string;
  bytes: Buffer;
  sha256: string;
  kind: PhotoKind;
}

/** Image type from the magic bytes (the extension of an upload is only a hint). */
export function sniffImage(b: Uint8Array): PhotoKind | null {
  if (isPng(b)) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (
    Buffer.from(b.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(b.subarray(8, 12)).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

/**
 * Reads a plan's project-relative photo. Throws when it escapes the project, is missing or is not
 * a PNG / JPEG / WebP image.
 */
export async function readPhoto(projectDir: string, file: string): Promise<Photo> {
  const root = resolve(projectDir);
  const path = resolve(root, file);
  if (!path.startsWith(root + sep))
    throw new Error(`reference photo ${file} is outside the project`);
  const bytes = await readFile(path).catch(() => {
    throw new Error(`reference photo ${file} is missing`);
  });
  const kind = sniffImage(bytes);
  if (!kind) throw new Error(`reference photo ${file} is not a PNG, JPEG or WebP image`);
  return {
    path,
    file: relative(root, path).split(sep).join('/'),
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind,
  };
}

const run = (cmd: string, args: string[]) =>
  new Promise<void>((ok, fail) =>
    execFile(cmd, args, { timeout: 60_000 }, (err) => (err ? fail(err) : ok())),
  );

const PIL_SCRIPT =
  'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "PNG")';

function pythonCandidates(): string[] {
  const venv = join(
    fileURLToPath(new URL('../../', import.meta.url)),
    'worker',
    '.venv',
    'bin',
    'python',
  );
  return [...new Set([process.env.ACTOR_PYTHON, venv, 'python3'].filter((p): p is string => !!p))];
}

/**
 * Writes `photo` as a PNG at `dest` (a PNG is copied as it is). Returns how, or null when this
 * machine cannot decode the format.
 */
export async function photoToPng(
  photo: Photo,
  dest: string,
  log: (m: string) => void,
): Promise<string | null> {
  await mkdir(dirname(dest), { recursive: true });
  if (photo.kind === 'png') {
    await writeFile(dest, photo.bytes);
    return 'copied';
  }
  const tmp = `${dest}.${process.pid}.tmp.png`;
  const tools: [string, string, string[]][] = [
    ...(process.platform === 'darwin'
      ? [
          ['sips', '/usr/bin/sips', ['-s', 'format', 'png', photo.path, '--out', tmp]] as [
            string,
            string,
            string[],
          ],
        ]
      : []),
    ...pythonCandidates().map(
      (py) => ['Pillow', py, ['-c', PIL_SCRIPT, photo.path, tmp]] as [string, string, string[]],
    ),
  ];
  for (const [name, cmd, args] of tools) {
    if (cmd.includes(sep) && !(await exists(cmd))) continue;
    try {
      await run(cmd, args);
      if (isPng(await readFile(tmp))) {
        await rename(tmp, dest);
        return `${photo.kind.toUpperCase()} → PNG via ${name}`;
      }
    } catch {
      /* next tool */
    } finally {
      await rm(tmp, { force: true });
    }
  }
  log(
    `cannot convert the ${photo.kind.toUpperCase()} photo ${photo.file} to PNG here (no sips, no Pillow)`,
  );
  return null;
}

/**
 * LHM's worker takes a portrait PNG only (worker/run_actor.py validate_image): a landscape or
 * square photo is letterboxed onto a 2:3 light-grey canvas (the worker crops to the person's mask
 * anyway), transparency is flattened onto the same grey. A PNG this codec cannot decode (16-bit,
 * palette, interlaced) is returned unchanged.
 */
export function portraitPng(png: Buffer): Buffer {
  let img: Image;
  try {
    img = decodePng(png);
  } catch {
    return png;
  }
  const portrait = img.height >= img.width * 1.25;
  if (portrait && img.channels === 3) return png;
  const GREY = 0xd8;
  const width = img.width;
  const height = portrait ? img.height : Math.ceil(img.width * 1.5);
  const top = Math.floor((height - img.height) / 2);
  const out = new Uint8Array(width * height * 3).fill(GREY);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * img.channels;
      const d = ((y + top) * width + x) * 3;
      const a = img.channels === 4 ? img.data[s + 3]! / 255 : 1;
      for (let c = 0; c < 3; c++) out[d + c] = Math.round(img.data[s + c]! * a + GREY * (1 - a));
    }
  }
  return encodePng({ width, height, channels: 3, data: out });
}
