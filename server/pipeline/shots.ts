// Per-scene shot list: <dataDir>/<projectId>/scene-<n>/shots.json (shared/shots.ts ShotList) and its
// frame grabs at scene-<n>/shots/<shotId>.jpg (served by server/index.ts under /projects/<id>/…).
// Same semantics as edits.json (edits.ts): GET answers the defaults while the file is absent; PUT is
// optimistic concurrency (the body's `revision` must equal the stored one, else 409 with the stored
// list) and the saved list gets revision + 1; writes to one scene are serialised in-process and
// atomic on disk.
//
//   GET  /api/projects/:id/scenes/:n/shots               → ShotList
//   PUT  /api/projects/:id/scenes/:n/shots               body ShotList → ShotList (409 { error, current })
//   PUT  /api/projects/:id/scenes/:n/shots/:shotId/frame raw image/jpeg ≤ SHOT_FRAME_MAX_BYTES → ShotList
//   GET  /api/projects/:id/shotlist.csv                  every scene's shots as CSV (an attachment)
//
// A frame upload replaces the JPEG, sets the shot's `frame` (project-root relative) and `frameAt`, and
// bumps the revision under the same lock as a PUT, so a laptop holding the old revision gets 409 and
// merges. Shot ids become file names, so a list is refused (400) unless every id is path-safe and
// unique, and a `frame` may only point into the same scene's shots/ folder. Frames of shots that
// leave the list stay on disk (undo can bring the shot back with its frame).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyShotList, SHOT_FRAME_MAX_BYTES, shotNumber, ShotList } from '../../shared/shots.ts';
import { nearestLensMm } from '../../shared/lens.ts';
import { sniffImageKind } from './chat/image-header.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from './fsutil.ts';
import { slugify } from './geometry.ts';
import { isProjectId } from './project.ts';

export const SHOTS_FILE = 'shots.json';
export const SHOTS_DIR = 'shots';
const MAX_SHOTS_BYTES = 512 * 1024;
/** Path-safe shot id (the laptop's are 8 base-36 chars): no slash, never "." or "..". */
const SHOT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SCENE_DIR = /^scene-(\d{1,4})$/;

export const isShotId = (id: string) => SHOT_ID.test(id);
/** Project-root relative frame path of a shot: "scene-0/shots/<shotId>.jpg". */
export const shotFramePath = (sceneIndex: number, shotId: string) =>
  `scene-${sceneIndex}/${SHOTS_DIR}/${shotId}.jpg`;

export class ShotsError extends Error {
  constructor(
    readonly status: 400 | 404 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}
export class ShotsConflict extends Error {
  readonly status = 409;
  constructor(readonly current: ShotList) {
    super(`revision conflict: the stored revision is ${current.revision}`);
  }
}

/** 400 unless every id is path-safe and unique and every frame stays in this scene's shots/. */
function checkShotList(list: ShotList, sceneIndex: number): void {
  const seen = new Set<string>();
  const frameRe = new RegExp(
    `^scene-${sceneIndex}/${SHOTS_DIR}/${SHOT_ID.source.slice(1, -1)}\\.jpg$`,
  );
  list.shots.forEach((s, i) => {
    if (!isShotId(s.id)) throw new ShotsError(400, `shots.${i}.id: must match ${SHOT_ID.source}`);
    if (seen.has(s.id)) throw new ShotsError(400, `shots.${i}.id: duplicate id "${s.id}"`);
    seen.add(s.id);
    if (s.frame !== undefined && !frameRe.test(s.frame))
      throw new ShotsError(
        400,
        `shots.${i}.frame: must be scene-${sceneIndex}/${SHOTS_DIR}/<shotId>.jpg`,
      );
  });
}

export class ShotsStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly dataDir: () => string,
    /** The project's title for the CSV file name; falls back to project.json on disk. */
    private readonly projectTitle?: (projectId: string) => Promise<string | undefined>,
  ) {}

  projectDir(projectId: string): string {
    if (!isProjectId(projectId)) throw new ShotsError(404, 'no such project');
    return join(this.dataDir(), projectId);
  }

  sceneDir(projectId: string, sceneIndex: number): string {
    if (!isProjectId(projectId) || !Number.isInteger(sceneIndex) || sceneIndex < 0)
      throw new ShotsError(404, 'no such scene');
    return join(this.dataDir(), projectId, `scene-${sceneIndex}`);
  }

  path(projectId: string, sceneIndex: number): string {
    return join(this.sceneDir(projectId, sceneIndex), SHOTS_FILE);
  }

  /** The stored list, or the defaults (revision 0) when there is none yet. */
  async read(projectId: string, sceneIndex: number): Promise<ShotList> {
    const dir = this.sceneDir(projectId, sceneIndex);
    if (!(await exists(dir))) throw new ShotsError(404, 'no such scene');
    const raw = await readJson(join(dir, SHOTS_FILE)).catch((e) => {
      console.warn(
        `[shots] ${projectId}/scene-${sceneIndex}: unreadable ${SHOTS_FILE}, using defaults`,
        e,
      );
      return undefined;
    });
    if (raw === undefined) return emptyShotList();
    const parsed = ShotList.safeParse(raw);
    if (!parsed.success) {
      console.warn(
        `[shots] ${projectId}/scene-${sceneIndex}: invalid ${SHOTS_FILE}, using defaults`,
      );
      return emptyShotList();
    }
    return parsed.data;
  }

  /** Saves `next` if `next.revision` is the stored revision; resolves with the saved list. */
  write(projectId: string, sceneIndex: number, next: ShotList): Promise<ShotList> {
    return this.update(projectId, sceneIndex, (current) => {
      if (next.revision !== current.revision) throw new ShotsConflict(current);
      return next;
    });
  }

  /** Read-modify-write under the per-scene lock; the result is stored with revision + 1. */
  update(
    projectId: string,
    sceneIndex: number,
    fn: (current: ShotList) => ShotList | Promise<ShotList>,
  ): Promise<ShotList> {
    const key = this.path(projectId, sceneIndex);
    return this.locked(key, async () => {
      const current = await this.read(projectId, sceneIndex);
      const next = ShotList.parse(await fn(structuredClone(current)));
      checkShotList(next, sceneIndex);
      const saved: ShotList = { ...next, version: 1, revision: current.revision + 1 };
      await writeJsonAtomic(key, saved);
      return saved;
    });
  }

  /**
   * Stores `jpeg` as the shot's frame (atomically, replacing any earlier grab) and records it on the
   * shot; 404 when the shot is not in the list. Resolves with the saved list (revision + 1).
   */
  async putFrame(
    projectId: string,
    sceneIndex: number,
    shotId: string,
    jpeg: Uint8Array,
  ): Promise<ShotList> {
    if (!isShotId(shotId)) throw new ShotsError(404, 'no such shot');
    if (sniffImageKind(jpeg) !== 'jpeg')
      throw new ShotsError(415, 'not a JPEG (expected FF D8 FF)');
    const dir = join(this.sceneDir(projectId, sceneIndex), SHOTS_DIR);
    return this.update(projectId, sceneIndex, async (current) => {
      const shot = current.shots.find((s) => s.id === shotId);
      if (!shot) throw new ShotsError(404, 'no such shot');
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(join(dir, `${shotId}.jpg`), jpeg);
      shot.frame = shotFramePath(sceneIndex, shotId);
      shot.frameAt = new Date().toISOString();
      return current;
    });
  }

  /** Whether a shot is in the stored list (a cheap check before reading an upload). */
  async hasShot(projectId: string, sceneIndex: number, shotId: string): Promise<boolean> {
    if (!isShotId(shotId)) return false;
    return (await this.read(projectId, sceneIndex)).shots.some((s) => s.id === shotId);
  }

  /** Every scene that has a shots.json, in scene order. 404 for an unknown project. */
  async allScenes(projectId: string): Promise<{ sceneIndex: number; list: ShotList }[]> {
    const dir = this.projectDir(projectId);
    if (!(await exists(join(dir, 'project.json')))) throw new ShotsError(404, 'no such project');
    const indices = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => SCENE_DIR.exec(d.name)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
    const out: { sceneIndex: number; list: ShotList }[] = [];
    for (const n of indices) {
      if (!(await exists(join(dir, `scene-${n}`, SHOTS_FILE)))) continue;
      out.push({ sceneIndex: n, list: await this.read(projectId, n) });
    }
    return out;
  }

  async title(projectId: string): Promise<string | undefined> {
    const given = await this.projectTitle?.(projectId).catch(() => undefined);
    if (given) return given;
    const st = await readJson<{ title?: unknown }>(
      join(this.projectDir(projectId), 'project.json'),
    ).catch(() => undefined);
    return typeof st?.title === 'string' ? st.title : undefined;
  }

  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const p = prev.then(run, run);
    const tail = p.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return p;
  }
}

// ---- CSV ---------------------------------------------------------------------------------------

export const SHOTLIST_CSV_COLUMNS = [
  'scene',
  'number',
  'name',
  'lens_mm',
  'height_m',
  'note',
  'lines',
  'frame_url',
] as const;

/** RFC 4180 field; text that a spreadsheet would run as a formula (= + - @ tab CR) gets a leading '. */
function csvField(value: string | number, text = false): string {
  let s = String(value);
  if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The shot list CSV (UTF-8 with a BOM so Excel reads it as UTF-8, CRLF rows): one row per shot of
 * every scene, scene numbered from 1 as in the shot number. `frameUrl` maps a project-root relative
 * frame path to the URL written in the frame_url column.
 */
export function shotListCsv(
  scenes: { sceneIndex: number; list: ShotList }[],
  frameUrl: (frame: string) => string,
): string {
  const rows: string[] = [SHOTLIST_CSV_COLUMNS.join(',')];
  for (const { sceneIndex, list } of scenes) {
    list.shots.forEach((s, order) => {
      rows.push(
        [
          csvField(sceneIndex + 1),
          csvField(shotNumber(sceneIndex, order)),
          csvField(s.name, true),
          csvField(nearestLensMm(s.fovDeg)),
          csvField(s.heightM === undefined ? '' : s.heightM.toFixed(2)),
          csvField(s.note ?? '', true),
          csvField(s.lines.join(';'), true),
          csvField(s.frame ? frameUrl(s.frame) : ''),
        ].join(','),
      );
    });
  }
  return `﻿${rows.join('\r\n')}\r\n`;
}

// ---- HTTP --------------------------------------------------------------------------------------

export type ShotsRoute =
  | { kind: 'list'; projectId: string; sceneIndex: number }
  | { kind: 'frame'; projectId: string; sceneIndex: number; shotId: string }
  | { kind: 'csv'; projectId: string };

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return '';
  }
};

/**
 * ['api','projects',id,'scenes',n,'shots'] · [...,'shots',shotId,'frame'] · ['api','projects',id,
 * 'shotlist.csv'] → the route, else null. Ids are decoded here and validated by the handler (404).
 */
export function shotsRoute(parts: string[]): ShotsRoute | null {
  if (parts[0] !== 'api' || parts[1] !== 'projects' || !parts[2]) return null;
  const projectId = decode(parts[2]);
  if (parts.length === 4 && parts[3] === 'shotlist.csv') return { kind: 'csv', projectId };
  if (parts[3] !== 'scenes' || parts[5] !== 'shots' || !/^\d{1,4}$/.test(parts[4] ?? ''))
    return null;
  const sceneIndex = Number(parts[4]);
  if (parts.length === 6) return { kind: 'list', projectId, sceneIndex };
  if (parts.length === 8 && parts[7] === 'frame' && parts[6])
    return { kind: 'frame', projectId, sceneIndex, shotId: decode(parts[6]) };
  return null;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
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
    throw new ShotsError(413, `body over ${max} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) {
      req.resume();
      throw new ShotsError(413, `body over ${max} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readShotList(req: IncomingMessage): Promise<ShotList> {
  const text = (await readRaw(req, MAX_SHOTS_BYTES)).toString('utf8');
  if (!text.trim()) throw new ShotsError(400, 'JSON body required');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ShotsError(400, 'body is not valid JSON');
  }
  const r = ShotList.safeParse(data);
  if (!r.success)
    throw new ShotsError(
      400,
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  return r.data;
}

/** Absolute URL of a project file on the host the request came to; root-relative if the host is odd. */
function projectFileUrl(req: IncomingMessage, projectId: string, file: string): string {
  const path = `/projects/${projectId}/${file}`;
  const host = req.headers.host ?? '';
  if (!/^[A-Za-z0-9.\-[\]:]{1,262}$/.test(host)) return path;
  const scheme = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
  return `${scheme}://${host}${path}`;
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, allow: string): true {
  req.resume();
  send(res, 405, { error: 'method not allowed' }, { allow });
  return true;
}

/** Handles the shots routes; false for any other path (the caller keeps routing). */
export async function handleShotsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  store: ShotsStore,
): Promise<boolean> {
  const route = shotsRoute(parts);
  if (!route) return false;
  const method = req.method ?? 'GET';
  try {
    if (!isProjectId(route.projectId)) throw new ShotsError(404, 'no such project');
    if (route.kind === 'csv') {
      if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(req, res, 'GET');
      const scenes = await store.allScenes(route.projectId);
      const csv = shotListCsv(scenes, (f) => projectFileUrl(req, route.projectId, f));
      const name = `${slugify((await store.title(route.projectId)) ?? route.projectId)}-shotlist.csv`;
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': Buffer.byteLength(csv),
        'content-disposition': `attachment; filename="${name}"`,
        'cache-control': 'no-store',
      });
      res.end(csv);
      return true;
    }
    if (route.kind === 'list') {
      if (method === 'GET' || method === 'HEAD') {
        send(res, 200, await store.read(route.projectId, route.sceneIndex));
        return true;
      }
      if (method !== 'PUT') return methodNotAllowed(req, res, 'GET, PUT');
      const body = await readShotList(req);
      send(res, 200, await store.write(route.projectId, route.sceneIndex, body));
      return true;
    }
    // frame
    if (method !== 'PUT') return methodNotAllowed(req, res, 'PUT');
    // cheap checks before reading the upload; putFrame re-checks the shot under the lock
    if (!(await store.hasShot(route.projectId, route.sceneIndex, route.shotId)))
      throw new ShotsError(404, 'no such shot');
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (type !== 'image/jpeg') throw new ShotsError(415, 'content-type must be image/jpeg');
    const bytes = await readRaw(req, SHOT_FRAME_MAX_BYTES);
    if (!bytes.length) throw new ShotsError(400, 'empty body: send the JPEG bytes');
    send(res, 200, await store.putFrame(route.projectId, route.sceneIndex, route.shotId, bytes));
    return true;
  } catch (e) {
    req.resume(); // an unread upload is drained, not left on the socket
    if (e instanceof ShotsConflict) {
      send(res, 409, { error: e.message, current: e.current });
      return true;
    }
    if (e instanceof ShotsError) {
      send(res, e.status, { error: e.message });
      return true;
    }
    throw e;
  }
}

const stores = new WeakMap<object, ShotsStore>();
/** One ShotsStore per project store (same data dir; the title comes from the store's status). */
export function shotsStoreFor(projects: {
  readonly dataDir: string;
  getProject?(id: string): Promise<{ title: string } | undefined>;
}): ShotsStore {
  let s = stores.get(projects);
  if (!s) {
    const get = projects.getProject?.bind(projects);
    const title = get && (async (id: string) => (await get(id))?.title);
    stores.set(projects, (s = new ShotsStore(() => projects.dataDir, title)));
  }
  return s;
}
