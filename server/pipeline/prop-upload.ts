// A prop's own 3D model (docs/PLAN-v4.md "Props by import or by prompt"): the uploads route
// (POST /api/projects/:id/uploads, shared/api.ts) also takes a glTF binary when the request says
// content-type model/gltf-binary (or ?name= ends in .glb). Stored as uploads/<sha16>.glb with
// uploads/<sha16>.json recording { id, kind: 'model', file, name?, bytes }; the same bytes uploaded
// twice are one file. The laptop then places it as a `prop-add` edit of kind 'model'.
//
// Checked here, so a bad file is refused with the reason instead of drawing as the fallback marker
// later: 'glTF' magic, version 2, the declared length, a JSON chunk first that parses, and no
// required extension the viewer's GLTFLoader cannot decode without extra decoders (Draco, meshopt,
// Basis textures). Images on the same route stay with server/pipeline/chat/ (saveUpload).
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { ProjectStatus } from '../../shared/schema.ts';
import { cleanUploadName, UploadError, UPLOADS_DIR } from './chat/uploads.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from './fsutil.ts';
import { isProjectId } from './project.ts';

export const MODEL_UPLOAD_TYPE = 'model/gltf-binary';
export const MAX_MODEL_UPLOAD_BYTES = 25 * 1024 * 1024;

/** What POST …/uploads answers for a model: `file` goes into PropModel.file. */
export interface ModelUpload {
  id: string;
  kind: 'model';
  /** "uploads/<id>.glb", served at /projects/<projectId>/<file>. */
  file: string;
  name?: string;
  bytes: number;
}

/** Extensions whose data the viewer's GLTFLoader cannot decode without extra decoders. */
const UNSUPPORTED_EXTENSIONS: Record<string, string> = {
  KHR_draco_mesh_compression: 'Draco-compressed meshes',
  EXT_meshopt_compression: 'meshopt-compressed meshes',
  KHR_meshopt_compression: 'meshopt-compressed meshes',
  KHR_texture_basisu: 'Basis Universal (KTX2) textures',
};

/** Throws UploadError unless `bytes` is a glTF 2.0 binary the viewer can draw. */
export function checkGlb(bytes: Buffer): void {
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'glTF')
    throw new UploadError(415, "not a glTF binary (.glb): the file does not start with 'glTF'");
  const version = bytes.readUInt32LE(4);
  if (version !== 2)
    throw new UploadError(415, `glTF version ${version}; only glTF 2.0 (.glb) is supported`);
  const length = bytes.readUInt32LE(8);
  if (length !== bytes.length)
    throw new UploadError(
      400,
      `the .glb says it is ${length} bytes but ${bytes.length} arrived (truncated?)`,
    );
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || 20 + jsonLength > bytes.length)
    throw new UploadError(415, 'the .glb has no JSON chunk');
  let json: { extensionsRequired?: unknown };
  try {
    json = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength));
  } catch {
    throw new UploadError(415, "the .glb's JSON chunk does not parse");
  }
  const required = Array.isArray(json.extensionsRequired) ? json.extensionsRequired.map(String) : [];
  const blocked = [...new Set(required.filter((e) => UNSUPPORTED_EXTENSIONS[e]).map((e) => UNSUPPORTED_EXTENSIONS[e]))];
  if (blocked.length)
    throw new UploadError(
      415,
      `the model uses ${blocked.join(' and ')}, which the viewer cannot decode; export it without compression`,
    );
}

/** Validates and stores a glTF binary as uploads/<sha16>.glb (+ its record). */
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
  const existing = await readJson<ModelUpload>(join(dir, `${id}.json`)).catch(() => undefined);
  if (existing?.kind === 'model' && existing.file === file && (await exists(join(projectDir, file))))
    return { upload: existing, created: false };
  await mkdir(dir, { recursive: true });
  await writeFileAtomic(join(projectDir, file), bytes);
  const name = cleanUploadName(o.name);
  const upload: ModelUpload = { id, kind: 'model', file, ...(name ? { name } : {}), bytes: bytes.length };
  // the model first, then its record: a record never points at a missing file
  await writeJsonAtomic(join(dir, `${id}.json`), upload);
  return { upload, created: true };
}

// ---- HTTP -----------------------------------------------------------------------------------------

/** POST ['api','projects',id,'uploads'] carrying a model (by content-type or a .glb name). */
export function isModelUpload(parts: string[], req: IncomingMessage, url: URL): boolean {
  if (parts.length !== 4 || parts[3] !== 'uploads' || req.method !== 'POST') return false;
  const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type === MODEL_UPLOAD_TYPE) return true;
  const name = url.searchParams.get('name') ?? '';
  return /\.glb$/i.test(name) && (type === '' || type === 'application/octet-stream');
}

export interface ModelUploadHost {
  projectDir(id: string): string;
  getProject(id: string): Promise<ProjectStatus | undefined>;
  logEvent(id: string, message: string): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json);
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? NaN) > max) {
    req.resume();
    throw new UploadError(413, `model over ${max} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) {
      req.resume();
      throw new UploadError(413, `model over ${max} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function handleModelUpload(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  host: ModelUploadHost,
): Promise<boolean> {
  const id = decodeURIComponent(parts[2]!);
  try {
    if (!isProjectId(id) || !(await host.getProject(id))) {
      req.resume();
      throw new UploadError(404, 'no such project');
    }
    const bytes = await readRaw(req, MAX_MODEL_UPLOAD_BYTES);
    const { upload, created } = await saveModelUpload(host.projectDir(id), bytes, {
      name: url.searchParams.get('name') ?? undefined,
    });
    if (created)
      await host.logEvent(
        id,
        `upload: ${upload.file} (3D model, ${upload.bytes} bytes${upload.name ? `, "${upload.name}"` : ''})`,
      );
    send(res, 201, upload, { location: `/projects/${id}/${upload.file}` });
  } catch (e) {
    if (!(e instanceof UploadError)) throw e;
    send(res, e.status, { error: e.message });
  }
  return true;
}
