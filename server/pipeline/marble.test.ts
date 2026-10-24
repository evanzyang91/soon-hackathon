import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { WorldAsset } from '../../shared/schema.ts';
import { generateWorld, RECEIPT_FILE, type MarbleReceipt } from './marble.ts';
import { encodeSpz } from './spz.ts';

const KEY = 'wlt-test-key-123';
const SPZ = encodeSpz([
  { position: [0, 0, 1], scale: [0.1, 0.1, 0.1], rgb: [1, 0, 0], opacity: 1 },
]);

interface FakeOptions {
  pollsUntilDone?: number;
  opError?: string;
  submitStatus?: number;
  flatWorld?: boolean;
  badSpz?: boolean;
}

/** In-memory Marble API + CDN; records every request. */
function fakeMarble(o: FakeOptions = {}) {
  const calls: { method: string; url: string; key: string | null }[] = [];
  let polls = 0;
  let ops = 0;
  const json = (v: unknown, status = 200) =>
    new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    calls.push({ method, url, key: headers.get('WLT-Api-Key') });
    if (method === 'POST' && url === 'https://api.worldlabs.ai/marble/v1/worlds:generate') {
      if (o.submitStatus) return json({ message: 'bad prompt' }, o.submitStatus);
      ops++;
      return json({ operation_id: `op-${ops}`, done: false });
    }
    const op = url.match(/\/marble\/v1\/operations\/(op-\d+)$/);
    if (op) {
      polls++;
      if (polls <= (o.pollsUntilDone ?? 1)) {
        return json({
          done: false,
          metadata: { progress: { status: 'IN_PROGRESS', description: `step ${polls}` } },
        });
      }
      if (o.opError) return json({ done: true, error: { message: o.opError } });
      return json({
        done: true,
        metadata: {
          world_id: 'w-1',
          progress: { status: 'SUCCEEDED', description: 'World ready' },
        },
      });
    }
    if (url === 'https://api.worldlabs.ai/marble/v1/worlds/w-1') {
      const world = {
        world_id: 'w-1',
        caption: 'a rainy street',
        assets: {
          thumbnail_url: 'https://cdn.test/w-1/thumb.webp?sig=SECRET',
          splats: {
            spz_urls: {
              '100k': 'https://cdn.test/w-1/100k.spz?sig=SECRET',
              '500k': 'https://cdn.test/w-1/500k.spz?sig=SECRET',
              full_res: 'https://cdn.test/w-1/full.spz?sig=SECRET',
            },
            semantics_metadata: { metric_scale_factor: 1.7, ground_plane_offset: 1.2 },
          },
          mesh: { collider_mesh_url: 'https://cdn.test/w-1/collider.glb?sig=SECRET' },
        },
      };
      return json(o.flatWorld ? world : { world });
    }
    if (url.startsWith('https://cdn.test/')) {
      const body = url.includes('.spz')
        ? o.badSpz
          ? Buffer.from('<html>expired</html>')
          : SPZ
        : Buffer.from('binary-asset');
      return new Response(new Uint8Array(body), {
        headers: { 'content-length': String(body.length) },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch: fakeFetch,
    calls,
    count: (m: string, re: RegExp) => calls.filter((c) => c.method === m && re.test(c.url)).length,
  };
}

let outDir: string;
let logs: string[];
beforeEach(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'previz-marble-'));
  logs = [];
});

const run = (
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof generateWorld>[0]> = {},
) =>
  generateWorld({
    prompt: 'A rain-slick city street at night. No people.',
    name: 'test world',
    outDir,
    model: 'marble-1.1',
    mock: false,
    log: (m) => logs.push(m),
    ...extra,
    deps: { fetch, apiKey: KEY, sleep: async () => {}, pollIntervalMs: 1, ...extra.deps },
  });

const receipt = async () =>
  JSON.parse(await readFile(join(outDir, RECEIPT_FILE), 'utf8')) as MarbleReceipt;

describe('marble client', () => {
  it('submits, polls, fetches and downloads; URLs are relative filenames', async () => {
    const m = fakeMarble({ pollsUntilDone: 2 });
    const asset = await run(m.fetch);
    expect(WorldAsset.parse(asset)).toEqual({
      provider: 'marble',
      worldId: 'w-1',
      spz: { k500: 'world_500k.spz', k100: 'world_100k.spz', full: 'world_full.spz' },
      colliderGlb: 'collider.glb',
      thumbnail: 'thumbnail.webp',
      metricScaleFactor: 1.7,
      groundPlaneOffset: 1.2,
      opencvFrame: true,
      caption: 'a rainy street',
    });
    for (const f of [
      'world_500k.spz',
      'world_100k.spz',
      'world_full.spz',
      'collider.glb',
      'thumbnail.webp',
      'world-asset.json',
    ]) {
      expect(existsSync(join(outDir, f)), f).toBe(true);
    }
    const r = await receipt();
    expect(r).toMatchObject({ status: 'complete', operation_id: 'op-1', world_id: 'w-1' });
    expect(Object.keys(r.files!)).toHaveLength(5);
    expect(m.count('POST', /worlds:generate/)).toBe(1);
    // the request body is the documented shape
    // API calls carry the key; CDN downloads never do
    for (const c of m.calls)
      expect(c.key).toBe(c.url.startsWith('https://api.worldlabs.ai') ? KEY : null);
    // progress descriptions are logged, secrets never are
    expect(logs.some((l) => l.includes('step 1'))).toBe(true);
    expect(logs.join('\n')).not.toMatch(/SECRET|wlt-test-key/);
  });

  it('sends the documented generate body', async () => {
    let body: unknown;
    const m = fakeMarble();
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('worlds:generate')) body = JSON.parse(String(init?.body));
      return m.fetch(input, init);
    }) as typeof fetch;
    await run(spy, { model: 'marble-1.0-draft' });
    expect(body).toEqual({
      display_name: 'test world',
      model: 'marble-1.0-draft',
      world_prompt: {
        type: 'text',
        text_prompt: 'A rain-slick city street at night. No people.',
        disable_recaption: true,
      },
      permission: { public: false },
    });
  });

  it('a crash while polling resumes by polling the recorded operation, never resubmitting', async () => {
    const m = fakeMarble({ pollsUntilDone: 3 });
    const crash = async () => {
      throw new Error('process killed');
    };
    await expect(run(m.fetch, { deps: { sleep: crash } })).rejects.toThrow('process killed');
    expect(await receipt()).toMatchObject({ status: 'submitted', operation_id: 'op-1' });
    expect(existsSync(join(outDir, 'world_500k.spz'))).toBe(false);

    const asset = await run(m.fetch);
    expect(asset.worldId).toBe('w-1');
    expect(m.count('POST', /worlds:generate/)).toBe(1);
    expect(logs.some((l) => /polling operation op-1/.test(l))).toBe(true);
  });

  it('a recorded world id is fetched, not regenerated; a complete receipt needs no network', async () => {
    const m = fakeMarble({ badSpz: true });
    await expect(run(m.fetch)).rejects.toThrow(/not a valid SPZ/);
    expect(await receipt()).toMatchObject({ status: 'generated', world_id: 'w-1' });
    expect(existsSync(join(outDir, 'world_500k.spz'))).toBe(false); // nothing half-written

    const good = fakeMarble({ flatWorld: true });
    const asset = await run(good.fetch);
    expect(asset.spz.k500).toBe('world_500k.spz');
    expect(good.count('POST', /worlds:generate/)).toBe(0);
    expect(good.count('GET', /operations/)).toBe(0);

    const none = fakeMarble();
    await expect(run(none.fetch)).resolves.toEqual(asset);
    expect(none.calls).toHaveLength(0);
  });

  it('refuses to resubmit when a submission has no recorded operation id', async () => {
    await writeFile(
      join(outDir, RECEIPT_FILE),
      JSON.stringify({
        schema: 'previz.marble-receipt/1',
        status: 'submitting',
        name: 'x',
        model: 'marble-1.1',
        promptSha256: 'x',
        createdAt: '',
        updatedAt: '',
      }),
    );
    const m = fakeMarble();
    await expect(run(m.fetch)).rejects.toMatchObject({ kind: 'uncertain' });
    expect(m.calls).toHaveLength(0);
  });

  it('a 4xx on submit is recorded as rejected and may be resubmitted', async () => {
    const bad = fakeMarble({ submitStatus: 400 });
    await expect(run(bad.fetch)).rejects.toThrow(/HTTP 400: bad prompt/);
    expect((await receipt()).status).toBe('rejected');
    const good = fakeMarble();
    await run(good.fetch);
    const r = await receipt();
    expect(r.status).toBe('complete');
    expect(r.history?.[0]).toMatchObject({ status: 'rejected' });
  });

  it('a provider-side failure is only resubmitted on an explicit retry', async () => {
    const m = fakeMarble({ opError: 'content policy' });
    await expect(run(m.fetch)).rejects.toThrow(/content policy/);
    expect((await receipt()).status).toBe('failed');
    await expect(run(m.fetch)).rejects.toMatchObject({ kind: 'failed' });
    expect(m.count('POST', /worlds:generate/)).toBe(1);

    const ok = fakeMarble();
    await run(ok.fetch, { retryFailed: true });
    expect(ok.count('POST', /worlds:generate/)).toBe(1);
    expect((await receipt()).history?.at(-1)).toMatchObject({
      status: 'failed',
      operation_id: 'op-1',
    });
  });

  it('mock mode copies the fixture world without any network', async () => {
    const m = fakeMarble();
    const asset = await run(m.fetch, { mock: true });
    expect(asset).toMatchObject({
      provider: 'mock',
      spz: { k500: 'world.spz' },
      metricScaleFactor: 1,
      groundPlaneOffset: 0,
    });
    expect(existsSync(join(outDir, 'world.spz'))).toBe(true);
    expect(existsSync(join(outDir, 'thumbnail.png'))).toBe(true);
    expect(m.calls).toHaveLength(0);
  });
});
