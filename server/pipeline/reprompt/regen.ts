// World regeneration for a confirmed `world-regen` plan (POST /api/projects/:id/scenes/:n/regen).
//
//   pano-inpaint: download the current world's panorama (marble-world.json
//     assets.imagery.pano_url) → OpenAI image edit (gpt-image-1.5, `images/edits`) with a prompt
//     that describes only the environmental change and a mask freeing the sky or the whole image
//     → resize back to a 2:1 panorama → upload as a Marble image prompt with `is_pano: true`.
//   text: Marble text prompt = the plan's new world prompt.
//
// Everything lands in scene-<n>/regen/<key>/ (key = hash of method + prompt) with a receipt
// (regen.json) per step, so a repeated or resumed request never pays twice: the downloaded and
// edited panoramas are reused, and the Marble receipt inside regen/<key>/world/ is the usual
// one (marble.ts). MARBLE_DRY_RUN=1 logs the exact upload + generate requests (marble-dry-run.json)
// and produces the mock world. MOCK=1 skips the network entirely (the "edited" panorama is the
// mock world's thumbnail).
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EditPlan } from '../../../shared/look.ts';
import type { WorldAsset } from '../../../shared/schema.ts';
import { env } from '../../env.ts';
import { exists, readJson, safeEndpoint, writeJsonAtomic } from '../fsutil.ts';
import { generateWorld, type GenerateWorldOptions } from '../marble.ts';
import { MOCK_WORLD_DIR } from '../mock-world.ts';
import { decodePng, editMask, encodePng, isPng, resize, toRgb } from './png.ts';

export type RegenSpec = NonNullable<EditPlan['regen']>;
export const REGEN_FILE = 'regen.json';
/** Panorama size sent to the image model and on to Marble (2:1 equirectangular). */
export const PANO_SIZE = { width: 2048, height: 1024 };
export const IMAGE_EDIT_MODELS = process.env.REGEN_IMAGE_MODEL
  ? [process.env.REGEN_IMAGE_MODEL]
  : ['gpt-image-1.5', 'gpt-image-2', 'gpt-image-1'];

export const regenKey = (r: Pick<RegenSpec, 'method' | 'prompt'>) =>
  createHash('sha256').update(`${r.method}\n${r.prompt.trim()}`).digest('hex').slice(0, 12);

const SKY_ONLY = /\b(sky|skies|clouds?|cloudy|overcast|sunset|sunrise|stars?|starry|moon|aurora|storm clouds)\b/i;
const GROUND = /\b(snow|ice|icy|frost|wet|puddles?|rain|leaves|autumn|fall|winter|summer|spring|season|desert|sand|grass|flood|ground|street|road|pavement|materials?|walls?|floor)\b/i;

/** Which part of the panorama the edit may change: only the sky, or everything. */
export function maskFor(prompt: string): 'sky' | 'whole' {
  return SKY_ONLY.test(prompt) && !GROUND.test(prompt) ? 'sky' : 'whole';
}

export function imageEditPrompt(change: string): string {
  return `${change.trim()}\n\nThis image is an equirectangular 360° panorama (2:1) of a real place. Keep the exact layout: every building, object, street, pole, bench and their positions, the camera height and a level horizon; keep the left and right edges continuous. Change only what is described above, consistently across the whole panorama, photorealistic.`;
}

export interface RegenReceipt {
  schema: 'previz.regen/1';
  key: string;
  method: RegenSpec['method'];
  prompt: string;
  status: 'running' | 'world-ready' | 'done' | 'failed';
  mask?: 'sky' | 'whole';
  panoSource?: string;
  imageModel?: string;
  error?: string;
  steps: { at: string; step: string; note: string }[];
  createdAt: string;
  updatedAt: string;
}

export type ImageEdit = (o: { image: Buffer; mask: Buffer; prompt: string; log: (m: string) => void }) => Promise<{
  png: Buffer;
  model: string;
}>;

/** OpenAI `POST /v1/images/edits` (multipart), first model the account has. */
export const openaiImageEdit: ImageEdit = async ({ image, mask, prompt, log }) => {
  let last = '';
  for (const model of IMAGE_EDIT_MODELS) {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('size', '1536x1024');
    form.set('quality', process.env.REGEN_IMAGE_QUALITY ?? 'high');
    form.set('n', '1');
    form.set('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'pano.png');
    form.set('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.keys.openai}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      last = `OpenAI image edit (${model}) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if ((res.status === 400 || res.status === 404) && /model|does not exist|not found|invalid_value/i.test(last)) {
        log(`${model} unavailable for edits; trying the next model`);
        continue;
      }
      throw new Error(last);
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[]; usage?: unknown };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image edit (${model}) returned no image`);
    const png = Buffer.from(b64, 'base64');
    log(`image edit via ${model}: ${png.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s${json.usage ? ` usage ${JSON.stringify(json.usage)}` : ''}`);
    return { png, model };
  }
  throw new Error(last || 'no image model configured');
};

export interface ProduceOptions {
  sceneDir: string;
  /** Marble display name. */
  name: string;
  regen: RegenSpec;
  mock: boolean;
  log: (m: string) => void;
  dryRun?: boolean;
  model?: string;
  deps?: {
    fetch?: typeof fetch;
    imageEdit?: ImageEdit;
    generateWorld?: (o: GenerateWorldOptions) => Promise<WorldAsset>;
  };
}

/** Builds the new world in scene-<n>/regen/<key>/world/ and returns that directory. */
export async function produceRegenWorld(o: ProduceOptions): Promise<{ dir: string; note: string; key: string }> {
  const key = regenKey(o.regen);
  const jobDir = join(o.sceneDir, 'regen', key);
  const worldDir = join(jobDir, 'world');
  await mkdir(jobDir, { recursive: true });
  const receiptPath = join(jobDir, REGEN_FILE);
  const now = () => new Date().toISOString();
  let r: RegenReceipt = (await readJson<RegenReceipt>(receiptPath)) ?? {
    schema: 'previz.regen/1',
    key,
    method: o.regen.method,
    prompt: o.regen.prompt,
    status: 'running',
    steps: [],
    createdAt: now(),
    updatedAt: now(),
  };
  const step = async (name: string, note: string, patch: Partial<RegenReceipt> = {}) => {
    r = { ...r, ...patch, steps: [...r.steps, { at: now(), step: name, note }], updatedAt: now() };
    await writeJsonAtomic(receiptPath, r);
    o.log(`${name}: ${note}`);
  };
  await step('start', `${o.regen.method} "${o.regen.prompt.slice(0, 120)}"`, { status: 'running' });
  const gen = o.deps?.generateWorld ?? generateWorld;
  const dryRun = o.dryRun ?? env.marbleDryRun;
  try {
    let note: string;
    if (o.regen.method === 'pano-inpaint') {
      const mask = maskFor(o.regen.prompt);
      const panoPath = join(jobDir, 'pano.png');
      const editedPath = join(jobDir, 'pano-edited.png');
      if (!(await exists(panoPath))) {
        if (o.mock) {
          await copyFile(join(MOCK_WORLD_DIR, 'thumbnail.png'), panoPath);
          await step('pano', 'mock: the mock world thumbnail stands in for the panorama', { panoSource: 'mock' });
        } else {
          const world = await readJson<{ assets?: { imagery?: { pano_url?: string } } }>(join(o.sceneDir, 'world', 'marble-world.json'));
          const url = r.panoSource && r.panoSource !== 'mock' ? r.panoSource : world?.assets?.imagery?.pano_url;
          if (!url) throw new Error('the world has no panorama (marble-world.json assets.imagery.pano_url); use a text regen');
          const res = await (o.deps?.fetch ?? fetch)(url, { redirect: 'follow' });
          if (!res.ok) throw new Error(`panorama download ${safeEndpoint(url)} -> HTTP ${res.status}`);
          const bytes = Buffer.from(await res.arrayBuffer());
          if (!isPng(bytes)) throw new Error('the panorama is not a PNG');
          await writeFile(panoPath, bytes);
          await step('pano', `downloaded ${safeEndpoint(url)} (${(bytes.length / 1e6).toFixed(1)} MB)`, { panoSource: url });
        }
      }
      if (!(await exists(editedPath))) {
        const src = decodePng(await readFile(panoPath));
        const small = resize(toRgb(src), PANO_SIZE.width, PANO_SIZE.height);
        const maskPng = encodePng(editMask(PANO_SIZE.width, PANO_SIZE.height, mask));
        await writeFile(join(jobDir, 'pano-input.png'), encodePng(small));
        await writeFile(join(jobDir, 'mask.png'), maskPng);
        const prompt = imageEditPrompt(o.regen.prompt);
        await writeJsonAtomic(join(jobDir, 'image-edit-request.json'), {
          method: 'POST',
          url: 'https://api.openai.com/v1/images/edits',
          form: { model: IMAGE_EDIT_MODELS[0], size: '1536x1024', quality: process.env.REGEN_IMAGE_QUALITY ?? 'high', n: 1, prompt, image: 'pano-input.png', mask: 'mask.png' },
          mask,
        });
        const edit = o.deps?.imageEdit ?? (env.keys.openai ? openaiImageEdit : null);
        if (o.mock || !edit) {
          await writeFile(editedPath, encodePng(small));
          await step('edit', `${o.mock ? 'mock' : 'OPENAI_API_KEY not set'}: panorama passed through unedited (mask ${mask})`, { mask });
        } else {
          const out = await edit({ image: encodePng(small), mask: maskPng, prompt, log: o.log });
          const edited = resize(toRgb(decodePng(out.png)), PANO_SIZE.width, PANO_SIZE.height);
          await writeFile(editedPath, encodePng(edited));
          await step('edit', `edited with ${out.model} (mask ${mask}), resized to ${PANO_SIZE.width}×${PANO_SIZE.height}`, { mask, imageModel: out.model });
        }
      }
      await gen({
        prompt: o.regen.prompt,
        name: o.name,
        outDir: worldDir,
        model: o.model,
        mock: o.mock,
        dryRun,
        log: o.log,
        imagePrompt: { file: editedPath, isPano: true },
      });
      note = `regenerated from the edited panorama (${mask === 'sky' ? 'sky' : 'whole image'})`;
    } else {
      await gen({ prompt: o.regen.prompt, name: o.name, outDir: worldDir, model: o.model, mock: o.mock, dryRun, log: o.log });
      note = 'regenerated from the new text prompt';
    }
    const asset = await readJson<WorldAsset>(join(worldDir, 'world-asset.json'));
    if (asset?.provider === 'mock' && !o.mock) note += dryRun ? ' — mock world (MARBLE_DRY_RUN: request logged, not submitted)' : ' — mock world';
    await step('world', note, { status: 'world-ready' });
    return { dir: worldDir, note, key };
  } catch (e) {
    await step('failed', (e as Error).message.slice(0, 300), { status: 'failed', error: (e as Error).message.slice(0, 300) });
    throw e;
  }
}

export async function markRegenDone(sceneDir: string, key: string, note: string): Promise<void> {
  const p = join(sceneDir, 'regen', key, REGEN_FILE);
  const r = await readJson<RegenReceipt>(p);
  if (!r) return;
  const at = new Date().toISOString();
  await writeJsonAtomic(p, { ...r, status: 'done', steps: [...r.steps, { at, step: 'done', note }], updatedAt: at });
}

export async function regenStatus(sceneDir: string, regen: Pick<RegenSpec, 'method' | 'prompt'>): Promise<RegenReceipt | undefined> {
  return readJson<RegenReceipt>(join(sceneDir, 'regen', regenKey(regen), REGEN_FILE));
}
