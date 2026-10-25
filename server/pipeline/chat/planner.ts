// The chat planner: one director message (+ photos) → a short reply and typed actions.
//
// Real path: Claude (claude-opus-5-5, adaptive thinking at low effort, ≤ 3k output tokens) with
// structured output against ChatDraft (draft.ts). It reads a compact plan (style, characters, scenes
// with line ids, marks and the full values of each scene's look), the screenplay text, the last ~20 messages, the new message and the photos
// as image blocks, each labelled with its id, name and hint. Photos sent earlier that nobody uses
// yet ride along (up to 4 images in all) so "the photo I sent is Maya" can be answered.
// Mock path (MOCK=1, no ANTHROPIC_API_KEY, or a MOCK project): mock.ts, the same draft.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { Attachment, ChatMessage } from '../../../shared/chat.ts';
import { seedToLook } from '../../../shared/look-presets.ts';
import {
  LookPresetName,
  LutPreset,
  type LookSeed,
  type ProjectStatus,
  type ScreenplayPlan,
} from '../../../shared/schema.ts';
import { env } from '../../env.ts';
import { costOf } from '../calibrate-vision.ts';
import { DYNAMIC_KINDS_TEXT, DYNAMIC_PATHS_TEXT } from '../dynamics.ts';
import { lookSeedFor, styleForPlan } from '../look-seed.ts';
import { decodePng, encodePng, isPng, resize } from '../reprompt/png.ts';
import { ChatDraft, type ChatContext } from './draft.ts';
import { mockChatDraft } from './mock.ts';
import { castName } from './plan-card.ts';
import { FIELDS, VOICE_CHOICES } from './patch.ts';

export const CHAT_MODEL = 'claude-opus-5-5';
export const CHAT_MAX_TOKENS = 3000;
export const CHAT_HISTORY = 20;
export const MAX_PLANNER_IMAGES = 4;
/** The API takes base64 images up to 5 MB; 3.75 MB of bytes stays under it once encoded. */
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4) - 1024;
const MAX_IMAGE_SIDE = 8000;
const SHRINK_TO = 2048;

export const CHAT_SYSTEM = `You are the assistant of a previsualization tool for film directors. The director pasted a screenplay; the tool planned it (characters, scenes, dialogue, actors' marks) and builds, per scene, a walkable 3D set (a World Labs Marble gaussian-splat world made from the scene's world prompt, or from a photo of the place), one 3D actor per character (from the character's description, or from a photo of the person) and a voice per line (text-to-speech). The director now talks to you about the plan: amends it, attaches reference photos, and says when to generate. You answer with a short reply and typed actions; code applies them and you never see the result.

What changes cost
- While the project is a draft nothing is generated yet: plan patches and reference photos are free and are all used when generation starts.
- On a generated project the app derives the follow-ups itself: a new description, height or reference photo rebuilds that actor (cheap); a new line text or voice re-voices only those lines (cheap); a new world prompt, time of day, interior flag or place photo needs a new world (about 5 minutes and 1,580 Marble credits) and waits for the director's confirmation; a moved or re-posed mark is free; a scene's look (its colour grade, fog and sky) is free and re-grades the scene at once; the style is free and only changes the plan.
- replan re-runs the screenplay planner on the amended screenplay. It is for structural changes only: a new or removed scene, a new or removed character, scenes reordered or merged. On a generated project it waits for confirmation.

Rules
- Choose the cheapest action that satisfies the request. Never regenerate a world, and never replan, for something a plan patch can hold until generation (a line, a description, a height, a voice, a world prompt, a time of day, a mark).
- A photo of a person is a character-reference for the character the director names; when no one is named, for the character it matches best by the descriptions (say who you picked and why in the reply). A photo of a place is a world-reference for the scene the director names (else the scene it matches best; say so). isPano only for a 2:1 equirectangular 360° image.
- When the request is ambiguous (which character, which line, a photo with no clue and no good match), ask one short question in the reply and return no action.
- A line edit is a plan-patch of the line's text with target "line:<id>" using the ids in the plan (the id stays). "Her second line" counts that character's lines in the scene being discussed, else in the first scene they speak in.
- A description change rewrites the whole description with the change worked in, keeping everything the director did not change (physical appearance and wardrobe only, 40-80 words). Height goes in heightMeters (a tall man about 1.88, a child about 1.3); "taller" or "shorter" without a number is about 0.10 m from the current height (1.70 when unset). "Older" changes the apparent age in the description.
- A world prompt change rewrites the complete environment description with the change worked in (no people, no animals, no vehicles, no action; at most 600 characters); keep the rest of the place. A different place for a scene is a worldPrompt patch (and a heading patch when the heading names the place), not a replan.
- Grade, colour, mood, fog, darkness or "make it look like ..." for one scene is a scene look patch, never a world change: "colder" lowers look.temperature by about 0.3 from the current value, "warmer" raises it, "foggier" raises look.fog.density by about 0.15, "darker" or "brighter" moves look.exposure by about 0.4, "moodier" raises look.vignette and look.contrast; a different kind of light is a new look.preset. Change look.mood when the feel changes. Values are absolute: start from the current values in the plan.
- Background action (the moving props of a scene: traffic, animals, monsters, aircraft, boats: "add a dinosaur walking by in scene 1", "an airplane flies low overhead", "remove the bus") is a plan-patch of the scene's "dynamics", free and applied at once, never a replan or a world change. Its value is JSON: {"add": [{"kind": "creature", "label": "a dinosaur walking by"}], "remove": ["<id or word>"]}. kind is the closest of: ${DYNAMIC_KINDS_TEXT}. The label keeps the director's words, with the species or type, colour, size and what it does ("a huge t-rex charges past", "a police helicopter hovers over the street"): the 3D body is built from it. Leave path and speed out and the app gives the thing the standard path for its label near the actors (walks by, flies low overhead, hovers, circles, lands, stands …); give "path" ([[x, y, z], …] in metres) and "speed" only when the director says where. remove takes the ids listed under the scene's background (or a word of a label). One patch per scene holds all of that scene's adds and removes.
- The whole film's genre or register ("make it a western", "more like a fairy tale") is a style patch rewriting genre, era, worldStyle and palette together. It regrades and regenerates nothing by itself: also patch each scene's look.preset when the director wants the look to follow, and change world prompts only when asked.
- "start", "go ahead", "generate", "build it" mean generate. Only a draft can be generated; on a generated project say that it already is and return no action.
- A structural change is a replan whose edits change the screenplay text: each edit finds an exact, unique passage of the current screenplay and replaces it (to add a scene, find the text it follows and replace it with that text plus the new scene: heading, action, character cues and dialogue in screenplay format). Also carry over line changes made earlier in this conversation where the screenplay still has the old wording.
- Do the whole request in one answer (several actions are fine) and never change what the director did not ask for.
- The reply is 1-3 short sentences to the director in their own words: what you changed, what you did not and why, or your question. Do not mention costs, credits or confirmations: the app shows a card per action with its cost and a confirm button.

Targets and fields (plan-patch)
- "character:<id>": ${FIELDS.character.filter((f) => f !== 'referenceImage').join(', ')} (voice.id is one of ${VOICE_CHOICES.join(', ')}; voice.gender is female, male or neutral).
- "scene:<index>": ${FIELDS.scene.filter((f) => f !== 'worldReference').join(', ')}. The index is 0-based: the director's "scene 2" is index 1. Positions are "x, y, z" in metres with y = 0 on the floor; the world's camera stands at the origin looking down -Z, +X to its right; actors usually stand 1.5-4 m in front of it. pose is standing, sitting or walking; facing is a character id, "camera", or a point.
  Scene field dynamics (background action) takes the JSON above; path rules when you give one:
${DYNAMIC_PATHS_TEXT.replace(/^- /gm, '    - ')}
  Scene look fields: look.preset is one of ${LookPresetName.options.join(', ')}; look.lut is one of ${LutPreset.options.join(', ')}; colours are "#rrggbb"; exposure is in stops (-3 to 3), contrast (0.5 to 2) and saturation (0 to 2) are 1 when neutral, temperature and tint run from -1 to 1, every other look number from 0 to 1.
- "line:<lineId>": text, parenthetical.
- "project": title.
- "style": ${FIELDS.style.join(', ')} (the whole screenplay's genre, era, the render style world prompts open with, and palette).
- character-reference: target "character:<id>" and the photo's attachmentId. world-reference: target "scene:<index>", attachmentId, isPano.
Values are text: numbers as digits ("1.85"), booleans "true" or "false", a scene's dynamics its JSON.`;

// ---------------------------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const r2 = (v: number) => Math.round(v * 100) / 100;

function stageSummary(st: ProjectStatus): string {
  if (st.draft)
    return 'draft: nothing is generated yet; worlds, actors and voices are made when the director says generate';
  const count = (stage: 'world' | 'actors' | 'tts' | 'manifest') => {
    const all = st.scenes.map((j) => j.stages[stage].status).filter((s) => s !== 'skipped');
    const done = all.filter((s) => s === 'done').length;
    const busy = all.filter((s) => s === 'running' || s === 'pending').length;
    const failed = all.filter((s) => s === 'failed').length;
    return `${done}/${all.length} done${busy ? `, ${busy} in progress` : ''}${failed ? `, ${failed} failed` : ''}`;
  };
  return `generated: worlds ${count('world')}; actors ${count('actors')}; voices ${count('tts')}; scenes ready ${count('manifest')}`;
}

/** The plan as the planner reads it (stable order, ids first). */
export function describePlan(plan: ScreenplayPlan, st: ProjectStatus): string {
  const lines: string[] = [];
  lines.push(`Title: ${plan.title}`);
  lines.push(`Status: ${stageSummary(st)}`);
  const style = styleForPlan(plan);
  lines.push(
    `Style${plan.style ? '' : ' (not planned yet; read from the script)'}: genre "${style.genre}" · era "${style.era}" · worldStyle "${style.worldStyle}" · palette "${style.palette}"`,
  );
  lines.push('Characters (id, name, height, voice, reference photo, description):');
  for (const c of plan.characters)
    lines.push(
      `- ${c.id} "${castName(c.name)}" · ${c.heightMeters ? `${c.heightMeters.toFixed(2)} m` : 'height unset (1.70 m)'} · voice ${c.voice.id} (${c.voice.gender}) · ${c.referenceImage ? `photo ${c.referenceImage}` : 'no photo'} · ${c.description}`,
    );
  lines.push('Scenes:');
  for (const s of plan.scenes) {
    lines.push(
      `[index ${s.index} = scene ${s.index + 1}] ${s.heading} · ${s.interior ? 'interior' : 'exterior'} · ${s.timeOfDay}${s.worldReference ? ` · place photo ${s.worldReference.file}${s.worldReference.isPano ? ' (360)' : ''}` : ''}`,
    );
    lines.push(`  world prompt: ${s.worldPrompt}`);
    lines.push(`  look: ${describeLook(lookSeedFor(s, style))}${s.look ? '' : ' (derived)'}`);
    if (s.blocking.length)
      lines.push(
        `  marks: ${s.blocking.map((b) => `${b.characterId} ${b.pose} at (${b.position.map(r2).join(', ')}) yaw ${Math.round((b.yaw * 180) / Math.PI)}°`).join('; ')}`,
      );
    lines.push(
      `  background: ${
        s.dynamics
          .map(
            (d) =>
              `${d.id} ${d.kind} "${clip(d.label, 80)}" ${d.speed > 0 ? `moving ${r2(d.speed)} m/s from (${d.path[0]!.map(r2).join(', ')})` : `still at (${d.path[0]!.map(r2).join(', ')})`}`,
          )
          .join('; ') || 'none'
      }`,
    );
    for (const d of s.dialogue)
      lines.push(
        `  ${d.id} ${d.characterId}${d.parenthetical ? ` (${d.parenthetical})` : ''}: "${d.text}"`,
      );
  }
  return lines.join('\n');
}

const LOOK_NUMBERS = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'bloom',
  'vignette',
  'grain',
] as const;

/**
 * A scene's look with every value it opens with (the preset's where the seed sets nothing), so the
 * planner can move "colder" or "foggier" from a number: 'candlelit "Candlelit · cold" · exposure
 * -0.35 · … · fog #3a2414 0.1 · skyTint #ffffff 0 · lut ember 0.7'.
 */
export function describeLook(seed: LookSeed): string {
  const l = seedToLook(seed);
  return [
    `${seed.preset} "${l.name}"`,
    ...LOOK_NUMBERS.map((k) => `${k} ${r2(l[k])}`),
    `fog ${l.fog.color} ${r2(l.fog.density)}`,
    `skyTint ${l.skyTint.color} ${r2(l.skyTint.strength)}`,
    `lut ${l.lut} ${r2(l.lutStrength)}`,
  ].join(' · ');
}

/** The thread before the new message, compact: who said what and what each answer did. */
export function describeHistory(history: ChatMessage[], screenplay: string): string {
  const out: string[] = [];
  for (const m of history.slice(-CHAT_HISTORY)) {
    const photos = m.attachments?.length
      ? ` [photos: ${m.attachments.map((a) => `${a.id}${a.name ? ` "${a.name}"` : ''}${a.hint ? ` hint ${a.hint}` : ''}`).join(', ')}]`
      : '';
    if (m.role === 'user') {
      const isScript = m.text.length > 400 && screenplay.includes(m.text.slice(0, 200));
      out.push(`Director: ${isScript ? '(pasted the screenplay)' : clip(m.text, 600)}${photos}`);
    } else {
      out.push(`You: ${clip(m.text, 500)}`);
      for (const a of m.actions ?? [])
        out.push(`  - ${a.type}: ${clip(a.summary, 160)} (${a.status})`);
    }
  }
  return out.join('\n') || '(no earlier messages)';
}

export interface PlannerImage {
  attachment: Attachment;
  fresh: boolean;
  block?: Anthropic.Beta.BetaImageBlockParam;
  /** Why the image is not shown (too large). */
  skipped?: string;
}

/** Loads the photos the planner will see, shrinking an oversize PNG; JPEG / WebP are sent as is. */
export async function loadPlannerImages(
  projectDir: string,
  ctx: ChatContext,
): Promise<PlannerImage[]> {
  const fresh = ctx.message.attachments.map((a) => ({ a, fresh: true }));
  const earlier = ctx.earlier
    .filter((a) => !ctx.message.attachments.some((x) => x.id === a.id))
    .map((a) => ({ a, fresh: false }));
  const picked = [...fresh, ...earlier].slice(0, Math.max(MAX_PLANNER_IMAGES, fresh.length));
  const out: PlannerImage[] = [];
  for (const { a, fresh: isFresh } of picked) {
    const media = a.file.endsWith('.png')
      ? 'image/png'
      : a.file.endsWith('.webp')
        ? 'image/webp'
        : 'image/jpeg';
    try {
      let bytes: Buffer = await readFile(join(projectDir, a.file));
      const tooBig =
        bytes.length > MAX_IMAGE_BYTES || a.width > MAX_IMAGE_SIDE || a.height > MAX_IMAGE_SIDE;
      if (tooBig && isPng(bytes)) {
        const img = decodePng(bytes);
        const k = SHRINK_TO / Math.max(img.width, img.height);
        bytes = encodePng(
          resize(
            img,
            Math.max(1, Math.round(img.width * k)),
            Math.max(1, Math.round(img.height * k)),
          ),
        );
      } else if (tooBig) {
        out.push({
          attachment: a,
          fresh: isFresh,
          skipped: `too large to show (${(bytes.length / 1e6).toFixed(1)} MB, ${a.width}×${a.height})`,
        });
        continue;
      }
      out.push({
        attachment: a,
        fresh: isFresh,
        block: {
          type: 'image',
          source: { type: 'base64', media_type: media, data: bytes.toString('base64') },
        },
      });
    } catch (e) {
      out.push({ attachment: a, fresh: isFresh, skipped: `unreadable (${(e as Error).message})` });
    }
  }
  return out;
}

export function plannerContent(
  ctx: ChatContext,
  images: PlannerImage[],
): Anthropic.Beta.BetaContentBlockParam[] {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    {
      type: 'text',
      text: `<plan>\n${describePlan(ctx.plan, ctx.status)}\n</plan>\n\n<screenplay>\n${clip(ctx.screenplay, 60_000)}\n</screenplay>\n\n<conversation>\n${describeHistory(ctx.history, ctx.screenplay)}\n</conversation>`,
    },
  ];
  for (const im of images) {
    const a = im.attachment;
    const label = `Photo ${a.id}${a.name ? ` "${a.name}"` : ''}, ${a.width}×${a.height}${a.hint ? `, the director's hint: ${a.hint}` : ''}, ${im.fresh ? 'attached to this message' : 'sent earlier and not used yet'}`;
    if (im.block) content.push({ type: 'text', text: `${label}:` }, im.block);
    else content.push({ type: 'text', text: `${label} (${im.skipped}; you cannot see it)` });
  }
  content.push({
    type: 'text',
    text: `The director's new message: """${ctx.message.text.trim().slice(0, 8000)}"""${ctx.message.attachments.length ? `\n(with ${ctx.message.attachments.length} photo${ctx.message.attachments.length > 1 ? 's' : ''}: ${ctx.message.attachments.map((a) => a.id).join(', ')})` : ''}\n\nAnswer with the reply and the actions.`,
  });
  return content;
}

// ---------------------------------------------------------------------------------------------

export type ChatPlannerCall = (req: {
  system: string;
  content: Anthropic.Beta.BetaContentBlockParam[];
  schema: Record<string, unknown>;
}) => Promise<Anthropic.Beta.BetaMessage>;

const defaultCall: ChatPlannerCall = async ({ system, content, schema }) => {
  const client = new Anthropic({ apiKey: env.keys.anthropic });
  const stream = client.beta.messages.stream({
    model: CHAT_MODEL,
    max_tokens: CHAT_MAX_TOKENS,
    // a policy decline is retried on the default fallback model
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema } },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content }],
  });
  return stream.finalMessage();
};

export class ChatPlannerError extends Error {}

export interface ChatPlanResult {
  draft: ChatDraft;
  source: 'claude' | 'mock';
  usage: { input: number; output: number; costUsd: number };
  /** Photos the planner could not look at (too large / unreadable). */
  unseen: string[];
}

export interface PlanChatInput {
  ctx: ChatContext;
  projectDir: string;
  /** Offline keyword planner. */
  mock: boolean;
  log?: (m: string) => void;
  /** Test seam (defaults to the Anthropic SDK). */
  call?: ChatPlannerCall;
}

export async function planChat(input: PlanChatInput): Promise<ChatPlanResult> {
  const log = input.log ?? (() => {});
  const offline = input.mock || (!env.keys.anthropic && !input.call);
  if (offline)
    return {
      draft: mockChatDraft(input.ctx),
      source: 'mock',
      usage: { input: 0, output: 0, costUsd: 0 },
      unseen: [],
    };
  const images = await loadPlannerImages(input.projectDir, input.ctx);
  const unseen = images.filter((i) => i.skipped).map((i) => `${i.attachment.id}: ${i.skipped}`);
  const schema = betaZodOutputFormat(ChatDraft).schema as Record<string, unknown>;
  const t0 = Date.now();
  const msg = await (input.call ?? defaultCall)({
    system: CHAT_SYSTEM,
    content: plannerContent(input.ctx, images),
    schema,
  });
  const usage = costOf(msg.usage);
  log(
    `planner ${CHAT_MODEL}: ${msg.stop_reason} in ${((Date.now() - t0) / 1000).toFixed(1)}s with ${images.filter((i) => i.block).length} photo(s) (in ${usage.input} / out ${usage.output} tokens, ~$${usage.costUsd.toFixed(4)})`,
  );
  if (msg.stop_reason === 'refusal')
    throw new ChatPlannerError('the planner declined this request');
  if (msg.stop_reason === 'max_tokens')
    throw new ChatPlannerError('the answer was cut off; ask for a smaller change');
  const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  let draft: ChatDraft;
  try {
    draft = ChatDraft.parse(JSON.parse(text));
  } catch (e) {
    throw new ChatPlannerError(
      `the planner's answer did not parse (${(e as Error).message.slice(0, 120)})`,
    );
  }
  return { draft, source: 'claude', usage, unseen };
}
