// Director-supplied images (POST /api/projects/:id/uploads, shared/api.ts): stored per project as
// uploads/<id>.<ext> plus uploads/<id>.json (the Attachment). The id is the first 16 hex digits of
// the bytes' sha256, so the same picture uploaded twice is one attachment and a reference to it
// (Character.referenceImage, ScenePlan.worldReference) never dangles because of a re-upload.
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Attachment } from '../../../shared/chat.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from '../fsutil.ts';
import { readImageInfo } from './image-header.ts';

export const UPLOADS_DIR = 'uploads';
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
const ID_RE = /^[0-9a-f]{16}$/;

export class UploadError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

export const isUploadId = (id: string) => ID_RE.test(id);

/** "../../IMG 0042.JPG\u0000" → "IMG 0042.JPG": a display name, never a path. */
export function cleanUploadName(name: string | null | undefined): string | undefined {
  const base = basename(String(name ?? '').replace(/\\/g, '/'));
  const clean = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 200);
  return clean || undefined;
}

/**
 * Validates and stores an image; resolves with its Attachment (the stored one when the same bytes
 * were uploaded before, whatever name they came with then).
 */
export async function saveUpload(
  projectDir: string,
  bytes: Buffer,
  o: { contentType?: string; name?: string } = {},
): Promise<{ attachment: Attachment; created: boolean }> {
  const declared = (o.contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(UPLOAD_TYPES as readonly string[]).includes(declared))
    throw new UploadError(415, `content-type must be one of ${UPLOAD_TYPES.join(', ')}`);
  if (!bytes.length) throw new UploadError(400, 'empty body: send the image bytes');
  if (bytes.length > MAX_UPLOAD_BYTES)
    throw new UploadError(413, `image over ${MAX_UPLOAD_BYTES} bytes`);
  // the bytes decide the type: a JPEG labelled image/png is stored as the JPEG it is
  const info = readImageInfo(bytes);
  if (!info) throw new UploadError(415, 'not a readable PNG, JPEG or WebP image');
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = join(projectDir, UPLOADS_DIR);
  const existing = await readAttachment(projectDir, id);
  if (existing && (await exists(join(projectDir, existing.file))))
    return { attachment: existing, created: false };
  await mkdir(dir, { recursive: true });
  const file = `${UPLOADS_DIR}/${id}.${info.ext}`;
  await writeFileAtomic(join(projectDir, file), bytes);
  const name = cleanUploadName(o.name);
  const attachment = Attachment.parse({
    id,
    kind: 'image',
    file,
    ...(name ? { name } : {}),
    width: info.width,
    height: info.height,
    bytes: bytes.length,
  });
  // the image first, then its record: a record never points at a missing file
  await writeJsonAtomic(join(dir, `${id}.json`), attachment);
  return { attachment, created: true };
}

/** The stored Attachment for `id`, or undefined. */
export async function readAttachment(
  projectDir: string,
  id: string,
): Promise<Attachment | undefined> {
  if (!isUploadId(id)) return undefined;
  const raw = await readJson(join(projectDir, UPLOADS_DIR, `${id}.json`)).catch(() => undefined);
  const parsed = Attachment.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Copies an upload another project holds into `projectDir` (same id: the bytes are the same).
 * POST /api/projects may name attachments before the new project exists; the laptop uploads them
 * to the project it has open, and they are content-addressed, so any copy is the same picture.
 */
export async function adoptUpload(
  dataDir: string,
  projectDir: string,
  id: string,
): Promise<Attachment | undefined> {
  const own = await readAttachment(projectDir, id);
  if (own) return own;
  if (!isUploadId(id)) return undefined;
  let projects: string[] = [];
  try {
    projects = (await readdir(dataDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const p of projects) {
    const other = join(dataDir, p);
    if (other === projectDir) continue;
    const a = await readAttachment(other, id);
    if (!a || !(await exists(join(other, a.file)))) continue;
    await mkdir(join(projectDir, UPLOADS_DIR), { recursive: true });
    await copyFile(join(other, a.file), join(projectDir, a.file));
    await writeJsonAtomic(join(projectDir, UPLOADS_DIR, `${id}.json`), a);
    return a;
  }
  return undefined;
}
