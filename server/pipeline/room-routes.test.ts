import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../shared/api.ts';
import { ProjectStatus, SceneManifest } from '../../shared/schema.ts';
import { ProjectStore } from './project.ts';
import { createPipelineHandler } from './routes.ts';

const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

let server: Server;
let base: string;
let store: ProjectStore;
let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-room-routes-'));
  store = new ProjectStore({
    dataDir,
    mock: true,
    keys: { anthropic: false, marble: false },
    echo: false,
  });
  const handle = createPipelineHandler(() => store, { localOnlySpend: true });
  server = createServer(async (req, res) => {
    if (await handle(req, res, new URL(req.url ?? '/', 'http://x'))) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await store.idle();
  await new Promise((r) => server.close(r));
});

const capture = {
  schema: 'previz.room-capture/1',
  room: {
    type: 'room',
    source: 'lidar',
    outline: [
      [-2, -3],
      [2, -3],
      [2, 1],
      [-2, 1],
    ],
    floorY: -1.35,
    area: 16,
  },
  start: { position: [0.5, 0.1, -0.5], yaw: 0.3 },
  video: { seconds: 18, bytes: 4096 },
  createdAt: '2026-10-24T18:00:00.000Z',
};

describe('scanned room routes', () => {
  it('phone uploads (from anywhere), laptop builds; the manifest gets the aligned room world', async () => {
    const created = ProjectStatus.parse(
      await (
        await fetch(base + api.projects, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ screenplay: FIXTURE }),
        })
      ).json(),
    );
    await store.idle();
    const url = (p: string) => `${base}/api/projects/${created.id}/scenes/0/${p}`;
    const phone = { 'x-forwarded-for': '192.168.1.40' }; // the phone, through the LAN / a tunnel

    // the capture needs its video first
    let r = await fetch(url('room-capture'), {
      method: 'PUT',
      headers: phone,
      body: JSON.stringify(capture),
    });
    expect(r.status).toBe(409);
    r = await fetch(url('room-capture/video'), {
      method: 'PUT',
      headers: phone,
      body: Buffer.alloc(4096, 1),
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ videoBytes: 4096 });
    r = await fetch(url('room-capture'), {
      method: 'PUT',
      headers: phone,
      body: JSON.stringify({ ...capture, start: {} }),
    });
    expect(r.status).toBe(400);
    r = await fetch(url('room-capture'), {
      method: 'PUT',
      headers: phone,
      body: JSON.stringify(capture),
    });
    expect(r.status).toBe(200);
    expect((await (await fetch(url('room-capture'))).json()).videoBytes).toBe(4096);

    // building spends Marble credits: refused from the phone, accepted from the laptop
    expect((await fetch(url('room-world'), { method: 'POST', headers: phone })).status).toBe(403);
    expect((await fetch(url('room-world'), { method: 'POST' })).status).toBe(202);

    const manifestPath = join(dataDir, created.id, 'scene-0', 'manifest.json');
    let manifest: SceneManifest | undefined;
    for (let i = 0; i < 100; i++) {
      manifest = SceneManifest.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
      if (manifest.world.source === 'room-scan') break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(manifest!.world.source).toBe('room-scan');
    expect(manifest!.world.roomAlign).toEqual({ yaw: 0.3, x: 0.5, z: -0.5 });
    expect(manifest!.startCamera.position[1]).toBeCloseTo(1.35);
    expect(manifest!.world.spz.k500).toMatch(/^scene-0\/world\//);
  });

  it('refuses an oversized video from its Content-Length, before reading it', async () => {
    const st = (await store.listProjects())[0]!;
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        `${base}/api/projects/${st.id}/scenes/0/room-capture/video`,
        { method: 'PUT', headers: { 'content-length': String(200 * 1024 * 1024) } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', (e) => (/socket hang up|ECONNRESET/.test(String(e)) ? undefined : reject(e)));
      req.flushHeaders();
      req.write(Buffer.alloc(16));
    });
    expect(status).toBe(413);
  });
});
