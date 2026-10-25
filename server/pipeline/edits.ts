// Per-scene look + edits persistence: <dataDir>/<projectId>/scene-<n>/edits.json (shared/look.ts
// SceneEdits). GET answers the defaults while the file is absent; PUT is optimistic concurrency —
// the body's `revision` must equal the stored one (else 409 with the stored document), and the
// saved document gets revision + 1. Writes to one file are serialised in-process and atomic on
// disk, so the laptop's look panel and the re-prompt planner (WP G) can both write safely.
//
// Server-side writers (WP G) use `EditsStore.update(id, n, fn)`, which re-reads, applies `fn`
// and bumps the revision under the same lock. The manifest stage's first look (look-seed.ts) uses
// `createIfAbsent`, which writes revision 1 only while there is no file yet.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { emptySceneEdits, SceneEdits } from '../../shared/look.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { isProjectId } from './project.ts';

export const EDITS_FILE = 'edits.json';
const MAX_EDITS_BYTES = 512 * 1024;

export class EditsConflict extends Error {
  readonly status = 409;
  constructor(readonly current: SceneEdits) {
    super(`revision conflict: the stored revision is ${current.revision}`);
  }
}
export class EditsNotFound extends Error {
  readonly status = 404;
}

export class EditsStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dataDir: () => string) {}

  sceneDir(projectId: string, sceneIndex: number): string {
    if (!isProjectId(projectId) || !Number.isInteger(sceneIndex) || sceneIndex < 0)
      throw new EditsNotFound('no such scene');
    return join(this.dataDir(), projectId, `scene-${sceneIndex}`);
  }

  path(projectId: string, sceneIndex: number): string {
    return join(this.sceneDir(projectId, sceneIndex), EDITS_FILE);
  }

  /** The stored document, or the defaults (revision 0) when there is none yet. */
  async read(projectId: string, sceneIndex: number): Promise<SceneEdits> {
    const dir = this.sceneDir(projectId, sceneIndex);
    if (!(await exists(dir))) throw new EditsNotFound('no such scene');
    const raw = await readJson(join(dir, EDITS_FILE)).catch((e) => {
      console.warn(`[edits] ${projectId}/scene-${sceneIndex}: unreadable ${EDITS_FILE}, using defaults`, e);
      return undefined;
    });
    if (raw === undefined) return emptySceneEdits();
    const parsed = SceneEdits.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[edits] ${projectId}/scene-${sceneIndex}: invalid ${EDITS_FILE}, using defaults`);
      return emptySceneEdits();
    }
    return parsed.data;
  }

  /** Saves `next` if `next.revision` is the stored revision; resolves with the saved document. */
  write(projectId: string, sceneIndex: number, next: SceneEdits): Promise<SceneEdits> {
    return this.update(projectId, sceneIndex, (current) => {
      if (next.revision !== current.revision) throw new EditsConflict(current);
      return next;
    });
  }

  /** Read-modify-write under the per-scene lock; the result is stored with revision + 1. */
  update(
    projectId: string,
    sceneIndex: number,
    fn: (current: SceneEdits) => SceneEdits | Promise<SceneEdits>,
  ): Promise<SceneEdits> {
    const key = this.path(projectId, sceneIndex);
    return this.locked(key, async () => {
      const current = await this.read(projectId, sceneIndex);
      const next = SceneEdits.parse(await fn(structuredClone(current)));
      const saved: SceneEdits = { ...next, version: 1, revision: current.revision + 1 };
      await writeJsonAtomic(key, saved);
      return saved;
    });
  }

  /**
   * Writes `make()` as revision 1 only while the scene has no edits.json at all (the server's first
   * look, look-seed.ts). Runs under the same lock as update(), so a first PUT from the laptop that
   * lands meanwhile wins and this resolves null; an unreadable file counts as present (never
   * overwritten).
   */
  createIfAbsent(
    projectId: string,
    sceneIndex: number,
    make: () => SceneEdits,
  ): Promise<SceneEdits | null> {
    const key = this.path(projectId, sceneIndex);
    return this.locked(key, async () => {
      if (!(await exists(this.sceneDir(projectId, sceneIndex)))) throw new EditsNotFound('no such scene');
      if (await exists(key)) return null;
      const saved: SceneEdits = { ...SceneEdits.parse(make()), version: 1, revision: 1 };
      await writeJsonAtomic(key, saved);
      return saved;
    });
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

// ---- HTTP: GET / PUT /api/projects/:id/scenes/:n/edits ---------------------------------------

/** ['api', 'projects', id, 'scenes', n, 'edits'] → { id, n }, else null. */
export function editsRoute(parts: string[]): { projectId: string; sceneIndex: number } | null {
  if (parts.length !== 6 || parts[0] !== 'api' || parts[1] !== 'projects') return null;
  if (parts[3] !== 'scenes' || parts[5] !== 'edits' || !/^\d{1,4}$/.test(parts[4] ?? '')) return null;
  return { projectId: decodeURIComponent(parts[2]!), sceneIndex: Number(parts[4]) };
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

async function readBody(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > MAX_EDITS_BYTES) {
    req.resume();
    return { ok: false, status: 413, error: `body over ${MAX_EDITS_BYTES} bytes` };
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_EDITS_BYTES) {
      req.resume();
      return { ok: false, status: 413, error: `body over ${MAX_EDITS_BYTES} bytes` };
    }
    chunks.push(chunk as Buffer);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return { ok: false, status: 400, error: 'body is not valid JSON' };
  }
}

/** Handles the edits routes; false for any other path (the caller keeps routing). */
export async function handleEditsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  store: EditsStore,
): Promise<boolean> {
  const route = editsRoute(parts);
  if (!route) return false;
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' || method === 'HEAD') {
      send(res, 200, await store.read(route.projectId, route.sceneIndex));
      return true;
    }
    if (method !== 'PUT') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, PUT' });
      return true;
    }
    const body = await readBody(req);
    if (!body.ok) {
      send(res, body.status, { error: body.error });
      return true;
    }
    const parsed = SceneEdits.safeParse(body.value);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
      send(res, 400, { error: msg });
      return true;
    }
    send(res, 200, await store.write(route.projectId, route.sceneIndex, parsed.data));
    return true;
  } catch (e) {
    if (e instanceof EditsConflict) {
      send(res, 409, { error: e.message, current: e.current });
      return true;
    }
    if (e instanceof EditsNotFound) {
      send(res, 404, { error: e.message });
      return true;
    }
    throw e;
  }
}

const stores = new WeakMap<object, EditsStore>();
/** One EditsStore per project store (same data dir; tests bring their own stores). */
export function editsStoreFor(projects: { readonly dataDir: string }): EditsStore {
  let s = stores.get(projects);
  if (!s) stores.set(projects, (s = new EditsStore(() => projects.dataDir)));
  return s;
}
