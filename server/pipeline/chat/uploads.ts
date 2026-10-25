// Director-supplied images (POST /api/projects/:id/uploads, shared/api.ts): stored per project as
// uploads/<id>.<ext> plus uploads/<id>.json (the Attachment). The id is the first 16 hex digits of
// the bytes' sha256, so the same picture uploaded twice is one attachment and a reference to it
// (Character.referenceImage, ScenePlan.worldReference) never dangles because of a re-upload.
//
// The same route takes a prop's 3D model (content-type model/gltf-binary, ≤ 25 MB): a glTF binary
// ('glTF' magic, version 2, a JSON chunk first) stored as uploads/<id>.glb with uploads/<id>.json
// recording { id, kind: 'model', file, name?, bytes }. Models that need a decoder the viewer does not
// bundle (Draco, meshopt, Basis textures) are refused here, with the reason, instead of drawing as
// the fallback marker later.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Attachment } from '../../../shared/chat.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from '../fsutil.ts';
import { readImageInfo } from './image-header.ts';

export const UPLOADS_DIR = 'uploads';
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
export const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** A prop's glTF binary (shared/api.ts: model/gltf-binary ≤ 25 MB). */
export const MODEL_UPLOAD_TYPE = 'model/gltf-binary';
export const MAX_MODEL_UPLOAD_BYTES = 25 * 1024 * 1024;
const ID_RE = /^[0-9a-f]{16}$/;

/** What POST …/uploads answers for a model: the file to put in PropModel.file. */
export interface ModelUpload {
  id: string;
  kind: 'model';
  /** "uploads/<id>.glb", served at /projects/<projectId>/<file>. */
  file: string;
  name?: string;
  bytes: number;
}

/** The body limit for a declared content-type (models are allowed more than photos). */
export const uploadLimit = (contentType: string | undefined) =>
  (contentType ?? '').split(';')[0]!.trim().toLowerCase() === MODEL_UPLOAD_TYPE
    ? MAX_MODEL_UPLOAD_BYTES
    : MAX_UPLOAD_BYTES;

/** Extensions whose data the viewer's GLTFLoader cannot decode without extra decoders. */
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco-compressed meshes',
  EXT_meshopt_compression: 'meshopt-compressed meshes',
  KHR_meshopt_compression: 'meshopt-compressed meshes',
  KHR_texture_basisu: 'Basis Universal (KTX2) textures',
};

/**
 * Checks a glTF binary's container: 'glTF' magic, version 2, a declared length that matches, a JSON
 * chunk first that parses, and no required extension the viewer cannot decode. Throws UploadError.
 */
export function checkGlb(bytes: Buffer): void {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'glTF')
    throw new UploadError(415, "not a glTF binary (.glb): the file does not start with 'glTF'");
  const version = bytes.readUInt32LE(4);
  if (version !== 2) throw new UploadError(415, `glTF version ${version}; only glTF 2.0 (.glb) is supported`);
  const length = bytes.readUInt32LE(8);
  if (length !== bytes.length)
    throw new UploadError(400, `the .glb says it is ${length} bytes but ${bytes.length} arrived (truncated?)`);
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > bytes.length)
    throw new UploadError(415, 'the .glb has no JSON chunk');
  let json: { asset?: { version?: string }; extensionsRequired?: unknown };
  try {
    json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  } catch {
    throw new UploadError(415, "the .glb's JSON chunk does not parse");
  }
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired.map(String) : [];
  const blocked = required.filter((e) => UNSUPPORTED_EXTENSIONS[e]);
  if (blocked.length)
    throw new UploadError(
      415,
      `the model uses ${blocked.map((e) => UNSUPPORTED_EXTENSIONS[e]).join(' and ')}, which the viewer cannot decode yet; export it without compression`,
    );
}

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

/**
 * Validates and stores a prop's glTF binary as uploads/<sha16>.glb (+ its record); the same bytes
 * uploaded twice are one file.
 */
export async function saveModelUpload(
  projectDir: string,
  bytes: Buffer,
  o: { name?: string } = {},
): Promise<{ upload: ModelUpload; created: boolean }> {
  if (!bytes.length) throw new UploadError(400, 'empty body: send the .glb bytes');
  if (bytes.length > MAX_MODEL_UPLOAD_BYTES)
    throw new UploadError(413, `model over ${MAX_MODEL_UPLOAD_BYTES} bytes`);
  checkGlb(bytes);
  const id = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const dir = join(projectDir, UPLOADS_DIR);
  const file = `${UPLOADS_DIR}/${id}.glb`;
  const name = cleanUploadName(o.name);
  const existing = (await readJson<ModelUpload>(join(dir, `${id}.json`)).catch(() => undefined)) ?? undefined;
  if (existing?.kind === 'model' && existing.file === file && (await exists(join(projectDir, file))))
    return { upload: existing, created: false };
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(projectDir, file), bytes);
  const upload: ModelUpload = { id, kind: 'model', file, ...(name ? { name } : {}), bytes: bytes.length };
  await writeJsonAtomic(join(dir, `${id}.json`), upload);
  return { upload, created: true };
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
