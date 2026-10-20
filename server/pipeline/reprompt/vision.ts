// One Claude vision request: where are these named objects in the director's current view?
// Conventions follow calibrate-vision.ts: pixel coordinates in the image as sent, origin at the
// top-left corner, x right, y down; a confidence 0..1 per object. Boxes come back normalised
// (0..1) so the laptop can unproject them through its own splat raycast at the request's camera.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { env } from '../../env.ts';
import { costOf } from '../calibrate-vision.ts';
import type { TargetBox } from './draft.ts';

export const LOCATE_MODEL = 'claude-opus-5-5';
export const MAX_VIEW_BYTES = 300 * 1024;

export const LOCATE_SYSTEM = `You locate objects in a single rendered frame of a 3D scene (a gaussian-splat reconstruction of a real-looking place, sometimes with 3D actors and simple props composited in). For each requested object, return the tight pixel bounding box of the visible part of that object in the image: x0,y0 the top-left corner and x1,y1 the bottom-right corner, in pixels of the image as given (origin top-left, x right, y down). Box only the named object (the part the director would recolour or remove), not its surroundings: "the bus shelter's roof" is only the roof panel, not the whole shelter. If the object is not visible, set found=false. confidence is 0 to 1: how sure you are that the box is that object and is tight.`;

const Answer = z.object({
  objects: z.array(
    z.object({
      label: z.string().describe('the requested object label, verbatim'),
      found: z.boolean(),
      x0: z.number(),
      y0: z.number(),
      x1: z.number(),
      y1: z.number(),
      confidence: z.number(),
      note: z.string().describe('what you boxed, in a few words'),
    }),
  ),
});
export type LocateAnswer = z.infer<typeof Answer>;

export type LocateCall = (req: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
}) => Promise<Anthropic.Beta.BetaMessage>;

const defaultCall: LocateCall = async ({ system, content, schema }) => {
  const client = new Anthropic({ apiKey: env.keys.anthropic });
  const stream = client.beta.messages.stream({
    model: LOCATE_MODEL,
    max_tokens: 1500,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content }],
  });
  return stream.finalMessage();
};

/** Width × height of a baseline or progressive JPEG (SOFn marker), or null. */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

/** Strips a data-URL prefix and decodes; throws on a non-JPEG or an image over 300 KB. */
export function decodeViewImage(image: string): { jpeg: Buffer; width: number; height: number } {
  const b64 = image.replace(/^data:image\/jpe?g;base64,/i, '');
  const jpeg = Buffer.from(b64, 'base64');
  if (jpeg.length > MAX_VIEW_BYTES) throw new Error(`view image is ${Math.round(jpeg.length / 1024)} KB (max 300 KB)`);
  const size = jpegSize(jpeg);
  if (!size) throw new Error('view image is not a JPEG');
  return { jpeg, ...size };
}

export interface LocateResult {
  targets: TargetBox[];
  answer: LocateAnswer;
  usage: { input: number; output: number; costUsd: number };
}

/**
 * Asks where each `{opId, label}` is in the view; returns normalised boxes for the objects found
 * with confidence ≥ 0.3 (sorted like the request). Throws on a refusal or a malformed answer.
 */
export async function locateObjects(
  image: string,
  wanted: { opId: string; label: string }[],
  o: { call?: LocateCall; log?: (m: string) => void } = {},
): Promise<LocateResult> {
  const { jpeg, width, height } = decodeViewImage(image);
  const schema = betaZodOutputFormat(Answer).schema as Record<string, unknown>;
  const list = wanted.map((w, i) => `${i + 1}. ${w.label}`).join('\n');
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
    {
      type: 'text',
      text: `The image is ${width}×${height} pixels. Find:\n${list}\n\nOne entry per object, in this order, with the label copied verbatim.`,
    },
  ];
  const t0 = Date.now();
  const msg = await (o.call ?? defaultCall)({ system: LOCATE_SYSTEM, content, schema });
  const usage = costOf(msg.usage);
  o.log?.(
    `vision ${LOCATE_MODEL}: ${msg.stop_reason} in ${((Date.now() - t0) / 1000).toFixed(1)}s (in ${usage.input} / out ${usage.output} tokens, ~$${usage.costUsd.toFixed(4)})`,
  );
  if (msg.stop_reason === 'refusal') throw new Error('vision request was declined');
  if (msg.stop_reason === 'max_tokens') throw new Error('vision answer was cut off (max_tokens)');
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  const answer = Answer.parse(JSON.parse(text));
  const targets: TargetBox[] = [];
  wanted.forEach((w, i) => {
    const a =
      answer.objects.find((x) => x.label.trim().toLowerCase() === w.label.trim().toLowerCase()) ?? answer.objects[i];
    if (!a || !a.found || !(a.confidence >= 0.3)) return;
    const x0 = Math.max(0, Math.min(a.x0, a.x1));
    const x1 = Math.min(width, Math.max(a.x0, a.x1));
    const y0 = Math.max(0, Math.min(a.y0, a.y1));
    const y1 = Math.min(height, Math.max(a.y0, a.y1));
    if (x1 - x0 < 2 || y1 - y0 < 2) return;
    targets.push({
      opId: w.opId,
      label: w.label,
      box: { x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height },
      confidence: Math.min(1, a.confidence),
    });
  });
  return { targets, answer, usage };
}
