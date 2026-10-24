import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateWorld, promptKey } from '../marble.ts';
import { compositeMasked, decodePng, editMask, encodePng, resize, type Image } from './png.ts';
import { imageEditPrompt, maskFor, produceRegenWorld, regenKey, type ImageEdit } from './regen.ts';

const solid = (w: number, h: number, rgb: [number, number, number]): Image => {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) data.set(rgb, i * 3);
  return { width: w, height: h, channels: 3, data };
};

describe('png codec', () => {
  it('round-trips RGB and RGBA, resizes bilinearly', () => {
    const img = solid(7, 5, [10, 200, 30]);
    img.data[0] = 255;
    const back = decodePng(encodePng(img));
    expect(back).toMatchObject({ width: 7, height: 5, channels: 3 });
    expect([...back.data]).toEqual([...img.data]);
    const mask = editMask(8, 100, 'sky');
    const m = decodePng(encodePng(mask));
    expect(m.channels).toBe(4);
    expect(m.data[3]).toBe(0); // top row editable
    expect(m.data[(99 * 8) * 4 + 3]).toBe(255); // bottom row kept
    expect(editMask(4, 4, 'whole').data.filter((_, i) => i % 4 === 3).every((a) => a === 0)).toBe(true);
    const r = resize(solid(4, 2, [100, 100, 100]), 8, 4);
    expect(r.width).toBe(8);
    expect(r.data.every((v) => v === 100)).toBe(true);
  });
});

describe('panorama edit canvas', () => {
  it('sky edits keep every ground pixel of the original', () => {
    const pano = solid(200, 100, [10, 20, 30]);
    const edited = solid(200, 100, [250, 250, 250]);
    const out = compositeMasked(pano, edited, editMask(200, 100, 'sky'));
    expect([...out.data.subarray(0, 3)]).toEqual([250, 250, 250]); // sky from the edit
    expect([...out.data.subarray((99 * 200) * 3, (99 * 200) * 3 + 3)]).toEqual([10, 20, 30]); // ground from the original
  });
});

describe('regen helpers', () => {
  it('mask: sky-only changes free the sky, everything else the whole panorama', () => {
    expect(maskFor('Replace the sky with dark storm clouds')).toBe('sky');
    expect(maskFor('Make it snow: snow on the ground and roofs')).toBe('whole');
    expect(maskFor('turn it into autumn')).toBe('whole');
    expect(maskFor('Replace only the sky with a dark, stormy night sky, rain falling. Keep the street exactly the same.')).toBe('sky');
    expect(maskFor('A clear starry sky. Keep the street and the shelter.')).toBe('sky');
  });
  it('keys are stable per method + prompt', () => {
    expect(regenKey({ method: 'text', prompt: 'a' })).toBe(regenKey({ method: 'text', prompt: ' a ' }));
    expect(regenKey({ method: 'text', prompt: 'a' })).not.toBe(regenKey({ method: 'pano-inpaint', prompt: 'a' }));
    expect(imageEditPrompt('Make it snow.')).toMatch(/^Make it snow\.\n\n.*equirectangular/s);
  });
});

describe('pano-inpaint under MARBLE_DRY_RUN', () => {
  it('downloads the panorama, edits it, logs the exact upload + generate requests, produces the mock world; reruns reuse every step', async () => {
    const sceneDir = await mkdtemp(join(tmpdir(), 'previz-regen-'));
    await mkdir(join(sceneDir, 'world'), { recursive: true });
    const panoUrl = 'https://cdn.test/w/pano/rgb_0.png';
    await writeFile(join(sceneDir, 'world', 'marble-world.json'), JSON.stringify({ assets: { imagery: { pano_url: panoUrl } } }));
    const pano = encodePng(solid(64, 32, [40, 40, 60]));
    let downloads = 0;
    const fakeFetch = (async (url: string) => {
      downloads++;
      expect(url).toBe(panoUrl);
      return new Response(new Uint8Array(pano));
    }) as unknown as typeof fetch;
    let edits = 0;
    let seen: Parameters<ImageEdit>[0] | undefined;
    const imageEdit: ImageEdit = async (o) => {
      edits++;
      seen = o;
      return { png: encodePng(solid(48, 32, [230, 230, 240])), model: 'gpt-image-1.5' };
    };
    const logs: string[] = [];
    const regen = { method: 'pano-inpaint' as const, prompt: 'Make it snow: snow on the ground', estimatedMinutes: 5, estimatedCredits: 1580, keeps: [], drops: [] };
    const run = () =>
      produceRegenWorld({ sceneDir, name: 'Bus stop (regen)', regen, mock: false, dryRun: true, log: (m) => logs.push(m), deps: { fetch: fakeFetch, imageEdit } });
    const r = await run();
    expect(r.dir).toBe(join(sceneDir, 'regen', regenKey(regen), 'world'));
    expect(r.note).toMatch(/edited panorama.*MARBLE_DRY_RUN/);
    expect(downloads).toBe(1);
    expect(edits).toBe(1);
    expect(seen!.prompt).toMatch(/^Make it snow/);
    const input = decodePng(seen!.image);
    expect([input.width, input.height]).toEqual([1536, 1024]); // the model's 3:2 size
    const sentMask = decodePng(seen!.mask!);
    expect(sentMask.channels).toBe(4);
    expect(sentMask.data[3]).toBe(0); // whole-image change: everything free
    const edited = decodePng(await readFile(join(sceneDir, 'regen', regenKey(regen), 'pano-edited.png')));
    expect([edited.width, edited.height]).toEqual([2048, 1024]);
    const dry = JSON.parse(await readFile(join(r.dir, 'marble-dry-run.json'), 'utf8'));
    expect(dry.upload.body).toEqual({ file_name: 'pano-edited.png', kind: 'image', extension: 'png' });
    expect(dry.generate.body.world_prompt).toEqual({
      type: 'image',
      image_prompt: { source: 'media_asset', media_asset_id: '<dry-run: not uploaded>' },
      is_pano: true,
    });
    const asset = JSON.parse(await readFile(join(r.dir, 'world-asset.json'), 'utf8'));
    expect(asset.provider).toBe('mock');
    expect(logs.some((l) => /DRY RUN.*not submitted/.test(l))).toBe(true);
    await run();
    expect([downloads, edits]).toEqual([1, 1]);
  });
});

describe('marble image prompt (live path, fake API)', () => {
  it('uploads the PNG (no API key on the presigned URL) and generates with is_pano', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'previz-marble-img-'));
    const file = join(outDir, 'pano-edited.png');
    await writeFile(file, encodePng(solid(8, 4, [1, 2, 3])));
    const calls: { method: string; url: string; key: string | null; body?: unknown }[] = [];
    const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
    const fakeFetch = (async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const key = new Headers(init?.headers).get('WLT-Api-Key');
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, key, body });
      if (url.endsWith('/media-assets:prepare_upload'))
        return json({ media_asset: { id: 'ma-1' }, upload_info: { upload_url: 'https://storage.test/up?sig=S', upload_method: 'PUT', required_headers: { 'x-goog-content-length-range': '0,1000' } } });
      if (url === 'https://storage.test/up?sig=S') return new Response('', { status: 200 });
      if (url.endsWith('/worlds:generate')) return json({ operation_id: 'op-1' });
      return new Response('{}', { status: 404 }); // stop at the first poll (covered by marble.test.ts)
    }) as unknown as typeof fetch;
    await generateWorld({
      prompt: 'snow',
      name: 'regen',
      outDir,
      mock: false,
      dryRun: false,
      log: () => {},
      imagePrompt: { file, isPano: true },
      deps: { fetch: fakeFetch, apiKey: 'k', sleep: async () => {}, pollIntervalMs: 1 },
    }).catch(() => {});
    expect(calls[0]).toMatchObject({ method: 'POST', url: 'https://api.worldlabs.ai/marble/v1/media-assets:prepare_upload', key: 'k', body: { file_name: 'pano-edited.png', kind: 'image', extension: 'png' } });
    expect(calls[1]).toMatchObject({ method: 'PUT', url: 'https://storage.test/up?sig=S', key: null });
    expect(calls[2]!.body).toMatchObject({ world_prompt: { type: 'image', image_prompt: { source: 'media_asset', media_asset_id: 'ma-1' }, is_pano: true } });
    const receipt = JSON.parse(await readFile(join(outDir, 'marble-receipt.json'), 'utf8'));
    expect(receipt).toMatchObject({ status: 'submitted', operation_id: 'op-1', media_asset_id: 'ma-1' });
    expect(receipt.promptSha256).toBe(await promptKey({ prompt: 'snow', imagePrompt: { file, isPano: true } }));
  });
});
