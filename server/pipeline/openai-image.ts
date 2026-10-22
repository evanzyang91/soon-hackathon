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
