import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../shared/api.ts';
import { ProjectStatus } from '../../shared/schema.ts';
import { ProjectStore } from './project.ts';
import { createPipelineHandler, MAX_BODY_BYTES } from './routes.ts';

const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

let server: Server;
let base: string;
let store: ProjectStore;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'previz-routes-'));
  store = new ProjectStore({
    dataDir,
    mock: true,
    keys: { anthropic: false, marble: false },
    echo: false,
  });
  const handle = createPipelineHandler(() => store);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (await handle(req, res, url)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await store.idle();
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('pipeline routes', () => {
  it('POST /api/projects → 202 ProjectStatus; GET one and list; manifests appear', async () => {
    const res = await post(api.projects, { title: 'Route test', screenplay: FIXTURE });
    expect(res.status).toBe(202);
    const created = ProjectStatus.parse(await res.json());
    expect(res.headers.get('location')).toBe(api.project(created.id));
    expect(created.title).toBe('Route test');

    await store.idle();
    const one = await fetch(base + api.project(created.id));
    expect(one.status).toBe(200);
    const st = ProjectStatus.parse(await one.json());
    expect(st.scenes.map((s) => s.manifestUrl)).toEqual(
      [0, 1, 2].map((n) => api.manifest(created.id, n)),
    );

    const list = await fetch(base + api.projects);
    expect(list.status).toBe(200);
    const all = (await list.json()) as ProjectStatus[];
    expect(all.map((p) => p.id)).toContain(created.id);

    const retried = await post(api.retry(created.id), { sceneIndex: 1, stage: 'tts' });
    expect(retried.status).toBe(200);
    expect(ProjectStatus.parse(await retried.json()).scenes[1]!.stages.tts.status).toBe('pending');
    await store.idle();
  });

  it('validates bodies and ids', async () => {
    expect((await post(api.projects, { title: 'x' })).status).toBe(400);
    expect((await post(api.projects, '{nope')).status).toBe(400);
    expect((await post(api.projects, { screenplay: '   ' })).status).toBe(400);
    const big = await post(api.projects, { screenplay: 'x'.repeat(MAX_BODY_BYTES + 10) });
    expect(big.status).toBe(413);
    expect((await fetch(base + api.project('does-not-exist'))).status).toBe(404);
    expect((await fetch(base + api.project('..%2F..%2Fetc'))).status).toBe(404);
    expect(
      (await post(api.retry('does-not-exist'), { sceneIndex: 0, stage: 'world' })).status,
    ).toBe(404);
    const created = ProjectStatus.parse(
      await (await post(api.projects, { screenplay: FIXTURE })).json(),
    );
    await store.idle();
    expect((await post(api.retry(created.id), { sceneIndex: 0, stage: 'paint' })).status).toBe(400);
    expect((await post(api.retry(created.id), { sceneIndex: 0, stage: 'parse' })).status).toBe(409);
    expect((await fetch(base + api.projects, { method: 'DELETE' })).status).toBe(405);
  });

  it('POST /api/projects/:id/actors/:characterId/rebuild validates, and refuses MOCK projects', async () => {
    const created = ProjectStatus.parse(
      await (await post(api.projects, { screenplay: FIXTURE })).json(),
    );
    await store.idle();
    const st = ProjectStatus.parse(await (await fetch(base + api.project(created.id))).json());
    expect(st.actors?.map((a) => [a.characterId, a.detail, a.kind]).sort()).toEqual([
      ['maya', 'standard', 'glb-humanoid'],
      ['theo', 'standard', 'glb-humanoid'],
    ]);
    const res = await post(api.rebuildActor(created.id, 'maya'), { detail: 'high' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/MOCK/);
    expect((await post(api.rebuildActor(created.id, 'maya'), { detail: 'ultra' })).status).toBe(400);
    expect((await post(api.rebuildActor(created.id, 'nobody'), { detail: 'high' })).status).toBe(404);
    expect((await post(api.rebuildActor('does-not-exist', 'maya'), { detail: 'high' })).status).toBe(404);
    expect((await fetch(base + api.rebuildActor(created.id, 'maya'))).status).toBe(405);
    expect((await post(`/api/projects/${created.id}/actors/maya/paint`, { detail: 'high' })).status).toBe(404);
  });

  it('leaves unknown /api paths to the caller', async () => {
    expect((await fetch(`${base}/api/health-not-ours`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/x/y/z`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/rooms/new`)).text()).toBe('not found');
  });
});

describe('localOnlySpend', () => {
  it('refuses POSTs that come through a proxy or tunnel; local POSTs and GETs pass', async () => {
    const guarded = createPipelineHandler(() => store, { localOnlySpend: true });
    const srv = createServer(async (req, res) => {
      if (await guarded(req, res, new URL(req.url ?? '/', 'http://x'))) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const viaTunnel = await fetch(b + api.projects, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7' },
        body: JSON.stringify({ screenplay: FIXTURE }),
      });
      expect(viaTunnel.status).toBe(403);
      const forwarded = await fetch(b + api.projects, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '192.168.1.40' },
        body: '{}',
      });
      expect(forwarded.status).toBe(403);
      // Local: reaches validation (400), not the guard.
      const local = await fetch(b + api.projects, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(local.status).toBe(400);
      const read = await fetch(b + api.projects, { headers: { 'x-forwarded-for': '192.168.1.40' } });
      expect(read.status).toBe(200);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });
});
