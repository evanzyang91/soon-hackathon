import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../shared/api.ts';
import { defaultLook, emptySceneEdits, SceneEdits } from '../../shared/look.ts';
import { EditsConflict, EditsStore, editsRoute, handleEditsRequest } from './edits.ts';

let dataDir: string;
let store: EditsStore;
let server: Server;
let base: string;
const ID = 'demo-abc123';

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-edits-'));
  await mkdir(join(dataDir, ID, 'scene-0'), { recursive: true });
  await mkdir(join(dataDir, ID, 'scene-1'), { recursive: true });
  store = new EditsStore(() => dataDir);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1);
    if (await handleEditsRequest(req, res, parts, store)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise((r) => server.close(r)));

const put = (n: number, body: unknown) =>
  fetch(base + api.edits(ID, n), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('edits store', () => {
  it('reads defaults while absent, then saves with revision + 1', async () => {
    expect(await store.read(ID, 0)).toEqual(emptySceneEdits());
    const next = { ...emptySceneEdits(), look: { ...defaultLook(), name: 'Noir', lut: 'noir' as const } };
    const saved = await store.write(ID, 0, next);
    expect(saved.revision).toBe(1);
    expect(saved.look.name).toBe('Noir');
    const disk = SceneEdits.parse(JSON.parse(await readFile(join(dataDir, ID, 'scene-0', 'edits.json'), 'utf8')));
    expect(disk).toEqual(saved);
    expect(await store.read(ID, 0)).toEqual(saved);
  });

  it('rejects a stale revision with the stored document', async () => {
    const cur = await store.read(ID, 0);
    await expect(store.write(ID, 0, { ...cur, revision: cur.revision - 1 })).rejects.toBeInstanceOf(EditsConflict);
    try {
      await store.write(ID, 0, { ...cur, revision: 0 });
    } catch (e) {
      expect((e as EditsConflict).current).toEqual(cur);
    }
  });

  it('serialises concurrent writers: exactly one of two same-revision writes wins', async () => {
    const cur = await store.read(ID, 0);
    const a = store.write(ID, 0, { ...cur, look: { ...cur.look, exposure: 1 } });
    const b = store.write(ID, 0, { ...cur, look: { ...cur.look, exposure: -1 } });
    const r = await Promise.allSettled([a, b]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(r.filter((x) => x.status === 'rejected')).toHaveLength(1);
    expect((await store.read(ID, 0)).revision).toBe(cur.revision + 1);
  });

  it('update() applies server-side edits under the lock (WP G path)', async () => {
    const cur = await store.read(ID, 0);
    const out = await Promise.all([
      store.update(ID, 0, (e) => ({ ...e, look: { ...e.look, vignette: 0.5 } })),
      store.update(ID, 0, (e) => ({ ...e, look: { ...e.look, grain: 0.25 } })),
    ]);
    expect(out.map((o) => o.revision)).toEqual([cur.revision + 1, cur.revision + 2]);
    const last = await store.read(ID, 0);
    expect(last.look.vignette).toBe(0.5);
    expect(last.look.grain).toBe(0.25);
  });

  it('falls back to defaults on a corrupt file and refuses unknown scenes', async () => {
    await writeFile(join(dataDir, ID, 'scene-1', 'edits.json'), '{nope');
    expect((await store.read(ID, 1)).revision).toBe(0);
    await expect(store.read(ID, 7)).rejects.toThrow(/no such scene/);
    await expect(store.read('../etc', 0)).rejects.toThrow(/no such scene/);
  });

  it('parses only its own route', () => {
    expect(editsRoute(['api', 'projects', ID, 'scenes', '2', 'edits'])).toEqual({ projectId: ID, sceneIndex: 2 });
    expect(editsRoute(['api', 'projects', ID, 'scenes', 'x', 'edits'])).toBeNull();
    expect(editsRoute(['api', 'projects', ID, 'retry'])).toBeNull();
  });
});

describe('edits routes', () => {
  it('GET → defaults or the stored document; PUT → saved, 409 on a stale revision', async () => {
    await mkdir(join(dataDir, ID, 'scene-2'), { recursive: true });
    const g = await fetch(base + api.edits(ID, 2));
    expect(g.status).toBe(200);
    const doc = SceneEdits.parse(await g.json());
    expect(doc.revision).toBe(0);

    const ok = await put(2, { ...doc, look: { ...doc.look, exposure: 0.5 } });
    expect(ok.status).toBe(200);
    const saved = SceneEdits.parse(await ok.json());
    expect(saved.revision).toBe(1);

    const stale = await put(2, { ...doc, look: { ...doc.look, exposure: -0.5 } });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { current: unknown };
    expect(SceneEdits.parse(body.current).look.exposure).toBe(0.5);
  });

  it('validates bodies and scenes', async () => {
    expect((await put(2, { version: 1, revision: 'x' })).status).toBe(400);
    expect((await put(9, emptySceneEdits())).status).toBe(404);
    expect((await fetch(base + api.edits(ID, 2), { method: 'POST' })).status).toBe(405);
    const bad = await fetch(base + api.edits(ID, 2), { method: 'PUT', body: '{' });
    expect(bad.status).toBe(400);
  });
});

describe('pipeline handler', () => {
  it('routes /api/projects/:id/scenes/:n/edits to the edits store of its project store', async () => {
    const { ProjectStore } = await import('./project.ts');
    const { createPipelineHandler } = await import('./routes.ts');
    const projects = new ProjectStore({ dataDir, mock: true, keys: { anthropic: false, marble: false }, echo: false });
    const handle = createPipelineHandler(() => projects);
    const srv = createServer(async (req, res) => {
      if (await handle(req, res, new URL(req.url ?? '/', 'http://x'))) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}${api.edits(ID, 0)}`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(SceneEdits.parse(await res.json()).revision).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
