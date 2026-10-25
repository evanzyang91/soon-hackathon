// OpenAI `POST /v1/images/edits` (multipart), shared by the world regeneration (an edited
// panorama, reprompt/regen.ts) and the actor pipeline (a director's photo normalised into the
// full-body front-facing shot LHM needs, actors.ts). First model the account serves wins; a model
// that does not take `input_fidelity` is retried without it.
import { env } from '../env.ts';

export const IMAGE_EDIT_MODELS = process.env.REGEN_IMAGE_MODEL
  ? [process.env.REGEN_IMAGE_MODEL]
  : ['gpt-image-1.5', 'gpt-image-2', 'gpt-image-1'];

export interface ImageEditInput {
  image: Buffer;
  /** Transparent where the image may change; absent = the model may redraw everything. */
  mask?: Buffer;
  prompt: string;
  log: (m: string) => void;
  /** Default 'image/png' (the endpoint takes JPEG / WebP uploads as they are). */
  mime?: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Default '1536x1024' (the panorama canvas). */
  size?: '1024x1024' | '1536x1024' | '1024x1536';
  /** Default env REGEN_IMAGE_QUALITY or 'high'. */
  quality?: string;
}

export type ImageEdit = (o: ImageEditInput) => Promise<{ png: Buffer; model: string }>;

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

export const openaiImageEdit: ImageEdit = async (o) => {
  const { image, mask, prompt, log, mime = 'image/png' } = o;
  let last = '';
  let fidelity = true;
  for (let k = 0; k < IMAGE_EDIT_MODELS.length; k++) {
    const model = IMAGE_EDIT_MODELS[k]!;
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', prompt);
    form.set('size', o.size ?? '1536x1024');
    form.set('quality', o.quality ?? process.env.REGEN_IMAGE_QUALITY ?? 'high');
    form.set('n', '1');
    if (fidelity) form.set('input_fidelity', 'high');
    form.set('image', new Blob([new Uint8Array(image)], { type: mime }), `image.${EXT[mime]}`);
    if (mask) form.set('mask', new Blob([new Uint8Array(mask)], { type: 'image/png' }), 'mask.png');
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.keys.openai}` },
      body: form,
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      last = `OpenAI image edit (${model}) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status === 400 && fidelity && /input_fidelity/i.test(last)) {
        log(`${model} does not take input_fidelity; retrying without it`);
        fidelity = false;
        k--;
        continue;
      }
      if (
        (res.status === 400 || res.status === 404) &&
        /model|does not exist|not found|invalid_value/i.test(last)
      ) {
        log(`${model} unavailable for edits; trying the next model`);
        continue;
      }
      throw new Error(last);
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[]; usage?: unknown };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image edit (${model}) returned no image`);
    const png = Buffer.from(b64, 'base64');
    log(
      `image edit via ${model}: ${png.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s${json.usage ? ` usage ${JSON.stringify(json.usage)}` : ''}`,
    );
    return { png, model };
  }
  throw new Error(last || 'no image model configured');
};

// ---------------------------------------------------------------------------------------------
// POST /v1/images/generations: a picture from a prompt (the actors' full-body reference,
// actors.ts, and a prop's object shot, props.ts). The first model in `models` the account serves
// wins; only an unknown / unavailable model moves on to the next one.
// ---------------------------------------------------------------------------------------------

export interface ImageGenerateInput {
  prompt: string;
  models: readonly string[];
  size: '1024x1024' | '1536x1024' | '1024x1536';
  quality: string;
  log: (m: string) => void;
  /** What the log line calls the result ("reference image"). */
  what?: string;
}

export interface ImageGenerateResult {
  png: Buffer;
  model: string;
  /** The endpoint's token usage when it reports one (input_tokens / output_tokens). */
  usage?: { input_tokens?: number; output_tokens?: number };
}

export async function openaiImageGenerate(o: ImageGenerateInput): Promise<ImageGenerateResult> {
  let lastError = '';
  for (const model of o.models) {
    const t0 = Date.now();
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${env.keys.openai}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: o.prompt, size: o.size, quality: o.quality, n: 1 }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      lastError = `OpenAI image (${model}) HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if ((res.status === 400 || res.status === 404) && /model|does not exist|invalid_value/i.test(lastError)) {
        o.log(`${model} unavailable; trying the next image model`);
        continue;
      }
      throw new Error(lastError);
    }
    const json = (await res.json()) as { data?: { b64_json?: string }[]; usage?: ImageGenerateResult['usage'] };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64) throw new Error(`OpenAI image (${model}) response has no b64_json`);
    const png = Buffer.from(b64, 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('OpenAI image is not a PNG');
    o.log(`${o.what ?? 'image'} via ${model}: ${png.length} bytes in ${Date.now() - t0}ms`);
    return { png, model, ...(json.usage ? { usage: json.usage } : {}) };
  }
  throw new Error(lastError || 'no image model configured');
}

/**
 * USD for one generated image, best effort: from the reported token usage at gpt-image-1's list
 * prices ($5 / M text input, $40 / M image output tokens; newer models are priced in the same
 * range), else the per-image list price for the quality at 1024×1024.
 */
export function imageCostUsd(r: Pick<ImageGenerateResult, 'usage'>, quality: string): number {
  const out = r.usage?.output_tokens;
  if (typeof out === 'number' && out > 0) return ((r.usage?.input_tokens ?? 0) * 5 + out * 40) / 1e6;
  return quality === 'low' ? 0.011 : quality === 'high' ? 0.167 : 0.042;
}
