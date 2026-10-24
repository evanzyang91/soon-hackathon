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

  it('leaves unknown /api paths to the caller', async () => {
    expect((await fetch(`${base}/api/health-not-ours`)).status).toBe(404);
    expect((await fetch(`${base}/api/projects/x/y/z`)).status).toBe(404);
    expect(await (await fetch(`${base}/api/rooms/new`)).text()).toBe('not found');
  });
});
