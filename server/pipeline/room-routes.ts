// Scanned room → set (server/pipeline/room-world.ts):
//
//   PUT  /api/projects/:id/scenes/:n/room-capture/video   raw video body (≤ 100 MB; the iPhone app)
//   PUT  /api/projects/:id/scenes/:n/room-capture         RoomCapture JSON, after the video
//   GET  /api/projects/:id/scenes/:n/room-capture         { capture | null, videoBytes }
//   POST /api/projects/:id/scenes/:n/room-world           202: build the Marble world of the scan
//
// Uploading is free, so the phone may do it; building spends Marble credits, so it is a POST and
// the localOnlySpend guard (routes.ts) keeps it to the laptop.
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { ScreenplayPlan } from '../../shared/schema.ts';
import { readJson, writeJsonAtomic } from './fsutil.ts';
import { MAX_VIDEO_BYTES } from './marble.ts';
import { isProjectId, type ProjectStore } from './project.ts';
import {
  buildRoomWorld,
  CAPTURE_DIR,
  CAPTURE_FILE,
  captureVideoBytes,
  readCapture,
  RoomCapture,
  VIDEO_FILE,
} from './room-world.ts';

type Route = { id: string; n: number; action: 'capture' | 'video' | 'world' };

export function roomRoute(parts: string[]): Route | null {
  // ['api', 'projects', id, 'scenes', n, 'room-capture' | 'room-world', 'video'?]
  if (parts[3] !== 'scenes' || !/^\d+$/.test(parts[4] ?? '')) return null;
  const id = decodeURIComponent(parts[2] ?? '');
  const n = Number(parts[4]);
  if (parts.length === 6 && parts[5] === 'room-capture') return { id, n, action: 'capture' };
  if (parts.length === 7 && parts[5] === 'room-capture' && parts[6] === 'video')
    return { id, n, action: 'video' };
  if (parts.length === 6 && parts[5] === 'room-world') return { id, n, action: 'world' };
  return null;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 256 * 1024) throw new HttpError(413, 'capture JSON over 256 KB');
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

/** Streams the request body to `file` (via a temp file), refusing more than `max` bytes. */
async function saveBody(req: IncomingMessage, file: string, max: number): Promise<number> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > max)
    throw new HttpError(413, `video over ${max / 1024 / 1024} MB (Marble's limit)`);
  let size = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length;
      done(
        size > max
          ? new HttpError(413, `video over ${max / 1024 / 1024} MB (Marble's limit)`)
          : null,
        chunk,
      );
    },
  });
  const tmp = `${file}.${process.pid}.upload`;
  try {
    await pipeline(req, cap, createWriteStream(tmp));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e instanceof HttpError ? e : new HttpError(400, `upload failed: ${(e as Error).message}`);
  }
  if (!size) {
    await rm(tmp, { force: true });
    throw new HttpError(400, 'empty video');
  }
  await rename(tmp, file);
  return size;
}

const building = new Set<string>();

export async function handleRoomRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  store: ProjectStore,
  opts: { mock?: boolean } = {},
): Promise<boolean> {
  const route = roomRoute(parts);
  if (!route) return false;
  const method = req.method ?? 'GET';
  try {
    if (!isProjectId(route.id)) throw new HttpError(404, 'no such project');
    const st = await store.getProject(route.id);
    if (!st) throw new HttpError(404, 'no such project');
    const plan = ScreenplayPlan.safeParse(
      await readJson(join(store.projectDir(route.id), 'plan.json')).catch(() => undefined),
    );
    const scene = plan.success ? plan.data.scenes[route.n] : undefined;
    if (!scene) throw new HttpError(404, `no scene ${route.n} in ${route.id}`);
    const sceneDir = join(store.projectDir(route.id), `scene-${route.n}`);
    const dir = join(sceneDir, CAPTURE_DIR);

    if (route.action === 'video') {
      if (method !== 'PUT') throw new HttpError(405, 'PUT the video');
      await mkdir(dir, { recursive: true });
      const bytes = await saveBody(req, join(dir, VIDEO_FILE), MAX_VIDEO_BYTES);
      console.log(
        `[${route.id}] [scene ${route.n}] room scan video uploaded (${(bytes / 1e6).toFixed(1)} MB)`,
      );
      send(res, 200, { videoBytes: bytes });
      return true;
    }
    if (route.action === 'capture') {
      if (method === 'GET' || method === 'HEAD') {
        send(res, 200, {
          capture: await readCapture(sceneDir).catch(() => null),
          videoBytes: await captureVideoBytes(sceneDir),
        });
        return true;
      }
      if (method !== 'PUT') throw new HttpError(405, 'GET or PUT');
      const parsed = RoomCapture.safeParse(await readJsonBody(req));
      if (!parsed.success)
        throw new HttpError(
          400,
          parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        );
      if (!(await captureVideoBytes(sceneDir))) throw new HttpError(409, 'upload the video first');
      await mkdir(dir, { recursive: true });
      await writeJsonAtomic(join(dir, CAPTURE_FILE), parsed.data);
      console.log(
        `[${route.id}] [scene ${route.n}] room scan saved (${parsed.data.room.area.toFixed(1)} m²)`,
      );
      send(res, 200, { capture: parsed.data, videoBytes: await captureVideoBytes(sceneDir) });
      return true;
    }
    // world
    if (method !== 'POST') throw new HttpError(405, 'POST');
    if (!(await readCapture(sceneDir).catch(() => null)))
      throw new HttpError(409, 'no room scan uploaded for this scene yet');
    const key = `${route.id}:${route.n}`;
    if (!building.has(key)) {
      building.add(key);
      const mock = opts.mock ?? st.mock;
      void store
        .replaceWorld(
          route.id,
          route.n,
          'building the world from your scanned room (Marble video, ~5 min)',
          (log) =>
            buildRoomWorld({
              sceneDir,
              outDir: join(sceneDir, `world.room-${Date.now()}`),
              name: `${st.title} · ${scene.heading} (scanned room)`,
              mock,
              log,
            }),
        )
        .finally(() => building.delete(key));
    }
    send(res, 202, await store.getProject(route.id));
    return true;
  } catch (e) {
    if (e instanceof HttpError) {
      send(res, e.status, { error: e.message });
      return true;
    }
    throw e;
  }
}
