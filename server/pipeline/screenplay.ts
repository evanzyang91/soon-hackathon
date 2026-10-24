// Screenplay text → ScreenplayPlan. Real path: Claude with structured outputs (JSON schema
// derived from a zod "draft" schema), validated against shared/schema.ts, one retry with the
// validation errors fed back. Mock path (MOCK=1 or no ANTHROPIC_API_KEY): fountain.ts.
//
// The draft schema differs from ScreenplayPlan on purpose: vectors are {x,y,z} objects (tuples are
// not expressible in structured outputs), actors face a point instead of a yaw, shots aim at a
// point instead of a quaternion, and ids/order are assigned here — all things an LLM gets wrong
// more often than code does.
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import {
  ScreenplayPlan,
  type Beat,
  type Blocking,
  type Character,
  type DynamicElement,
  type ScenePlan,
  type SuggestedShot,
  type Vec3,
} from '../../shared/schema.ts';
import { env } from '../env.ts';
import {
  VOICES,
  VOICE_IDS,
  countSceneHeadings,
  heuristicBlocking,
  mockPlan,
  parseFountain,
} from './fountain.ts';
import { clamp, lookAtQuat, round3, slugify, uniqueSlug, yawFacing } from './geometry.ts';

export const SCREENPLAY_MODEL = 'claude-opus-5-5';
const WORLD_PROMPT_MAX = 600;

// ---------------------------------------------------------------------------
// Draft schema (what Claude fills in)
// ---------------------------------------------------------------------------

const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });
type Point = z.infer<typeof Point>;

const Draft = z.object({
  title: z.string(),
  characters: z.array(
    z.object({
      id: z.string().describe('lowercase slug of the name, e.g. "maya"; used everywhere else'),
      name: z.string().describe("exactly as in the character cue, without (V.O.)/(CONT'D)"),
      gender: z.enum(['female', 'male', 'neutral']),
      voice: z.enum(VOICE_IDS),
      description: z.string().describe('physical description for a full-body reference image'),
    }),
  ),
  scenes: z.array(
    z.object({
      heading: z.string(),
      action: z.string(),
      timeOfDay: z.enum(['dawn', 'day', 'dusk', 'night']),
      interior: z.boolean(),
      worldPrompt: z.string(),
      characterIds: z.array(z.string()),
      dialogue: z.array(
        z.object({
          characterId: z.string(),
          text: z.string(),
          parenthetical: z.string().nullable(),
        }),
      ),
      blocking: z.array(
        z.object({
          characterId: z.string(),
          position: Point,
          facing: Point.describe('point in world meters the character faces'),
          pose: z.enum(['standing', 'sitting', 'walking']),
          beats: z
            .array(
              z.object({
                t: z.number().describe('scene seconds when it starts'),
                action: z.string().describe('what the character does, for the director'),
                moveTo: Point.nullable().describe('walk to this mark, or null to stay put'),
                facing: Point.nullable().describe('point to face afterwards, or null'),
                pose: z.enum(['standing', 'sitting']).nullable(),
              }),
            )
            .default([]),
        }),
      ),
      dynamics: z.array(
        z.object({
          kind: z.enum(['car', 'bus', 'bicycle', 'bird', 'pedestrian', 'generic']),
          label: z.string(),
          path: z.array(Point),
          speed: z.number().describe('meters per second'),
          loop: z.boolean(),
          pauseSeconds: z.number(),
          scale: z.number(),
        }),
      ),
      shots: z.array(
        z.object({
          name: z.string(),
          position: Point,
          lookAt: Point,
          fovDeg: z.number(),
        }),
      ),
    }),
  ),
});
type Draft = z.infer<typeof Draft>;

export const SYSTEM_PROMPT = `You are a previsualization assistant. You turn a short screenplay into a structured staging plan that is used to build one walkable 3D set per scene (a gaussian-splat world generated from a text prompt), place 3D actors in it, voice their lines with text-to-speech, and suggest camera setups. Return one JSON object matching the schema.

Scenes
- One scene per scene heading (INT., EXT., EST., INT./EXT., I/E), in script order. Copy the heading verbatim. "action" is the scene's action/description text, verbatim, paragraphs separated by blank lines.
- timeOfDay: dawn, day, dusk or night from the heading and action (MORNING is day unless it is explicitly early or dawn). interior: true for INT.

Characters
- Every speaking character appears once in "characters". "id" is a lowercase slug of the name (letters, digits, hyphens) and is the only way other fields refer to the character. "name" is exactly as written in the character cue, without extensions such as (V.O.) or (CONT'D).
- "description" is a physical description for generating a full-body reference image: apparent age, gender presentation, height and build, skin tone, hair, notable facial features, and specific wardrobe (garments, colors, materials, shoes) that fits the story, era and setting. Use what the script says; where it is silent, invent plausible, specific details that suit the character. 40-80 words. No real people, no camera or lighting language.
- "gender" and "voice": choose the voice to match the character. female: nova, shimmer, coral, sage. male: onyx, ash, echo, ballad. neutral or unknown: alloy, fable. Give each character a different voice when possible.

Dialogue
- Every line of dialogue in the scene, in script order, text verbatim. "parenthetical" is the parenthetical direction without the parentheses, or null.

Blocking (world frame)
- Units are meters. Y is up and the floor is y = 0. The world's source camera is at the origin looking down -Z; +X is to its right. Actors stand with their feet on the floor (y = 0), 1.5-4 m in front of the camera (z between -1.5 and -4) and within 2 m of the center line (x between -2 and 2).
- One entry per character present in the scene (anyone who speaks or is described as present). Two people in conversation stand roughly 1.2-1.8 m apart, facing each other. Groups form an open arc that faces inward and slightly toward the camera.
- "facing" is the point the character looks toward: usually the other character's position, or the origin when they address no one in particular. "pose" is sitting when the action says they sit, walking when they are described as moving, otherwise standing.
- "position", "facing" and "pose" are where the character is when the scene starts. "beats" is what they do after that, in time order, so the scene plays out instead of everyone holding still: arriving, crossing to a spot, sitting down, standing up, turning to someone or away, pacing, leaving. Take beats from the action lines and parentheticals, and add the small motivated moves a director would give (turning toward whoever they answer, stepping closer or away on an emotional line). 0-6 beats per character; an empty list is fine for someone who really stays put.
- Beat timing: the scene clock starts at 0 with the first line. Each dialogue line lasts about 0.4 s per word plus 0.6 s, one after another in order; time a beat to the line it belongs to. A walk takes about 1 s per 1.2 m; give "moveTo" (feet on the floor, inside the same area as the blocking) for any move, and keep marks at least 0.6 m from other characters. "facing" is where they look after the beat (null keeps the direction they walked or were facing). "pose" is sitting or standing after the beat, or null when it does not change. A character described as entering starts at the edge (2-4 m from their first mark) with pose standing and a first beat at t 0 that walks them in.

Dynamics
- Things that move through the scene according to the action lines (a car driving by, a bus, cyclists, birds, joggers), never the speaking characters. kind is car, bus, bicycle, bird, pedestrian or generic.
- Ground traffic: a straight path across the view on the ground (y = 0), 8-15 m out (z between -8 and -15), x from about -30 to 30 or the reverse. Speeds: cars about 8 m/s, buses 6, bicycles 5, pedestrians 1.4. loop true with a 2-4 s pause. Birds: a closed loop of 8-12 points, 6-12 m up, speed about 6, pause 0. scale 1 unless the script implies otherwise.
- Only include what the script implies; an empty list is fine (interiors usually have none).

Shots
- 2-3 camera setups that would cover the scene (for example a wide master, a two-shot, an over-the-shoulder or a close-up). "position" is the camera location (eye height 1.5-1.7 m unless motivated otherwise) and "lookAt" is the point it aims at (usually a character's head, y about 1.6). fovDeg between 25 and 70.

World prompt
- "worldPrompt" describes ONLY the environment of the scene, for a text-to-3D-world generator, as a rich photographic description: the space and its layout, architecture, materials and textures, props and set dressing, lighting quality and direction, time of day and weather, color palette and atmosphere. It contains no people, no characters, no animals, no vehicles, and no action or story: just the empty set as seen from where the camera stands, with open floor in the foreground where the actors will stand. At most ${WORLD_PROMPT_MAX} characters.

Title: the screenplay's title from its title page, or a short fitting one.`;

// ---------------------------------------------------------------------------
// Claude call (injectable for tests)
// ---------------------------------------------------------------------------

export interface ClaudeRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: Record<string, unknown>;
}
export type ClaudeCall = (req: ClaudeRequest) => Promise<Anthropic.Beta.BetaMessage>;

const defaultCall: ClaudeCall = async ({ system, messages, schema }) => {
  const client = new Anthropic({ apiKey: env.keys.anthropic });
  const stream = client.beta.messages.stream({
    model: SCREENPLAY_MODEL,
    max_tokens: 64000,
    // Server-side refusal fallback: a policy decline is retried on the default fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    system,
    messages,
  });
  return stream.finalMessage();
};

export interface ParseOptions {
  mock: boolean;
  log: (m: string) => void;
  /** Overrides the screenplay's own title. */
  title?: string;
  /** Test seam; defaults to the Anthropic SDK. */
  call?: ClaudeCall;
}

export async function parseScreenplay(text: string, opts: ParseOptions): Promise<ScreenplayPlan> {
  if (!text.trim()) throw new Error('screenplay is empty');
  if (opts.mock || (!env.keys.anthropic && !opts.call)) {
    if (!opts.mock) opts.log('ANTHROPIC_API_KEY not set: using the offline screenplay parser');
    return ScreenplayPlan.parse(mockPlan(text, { title: opts.title, log: opts.log }));
  }
  return parseWithClaude(text, opts);
}

async function parseWithClaude(text: string, opts: ParseOptions): Promise<ScreenplayPlan> {
  const call = opts.call ?? defaultCall;
  const schema = betaZodOutputFormat(Draft).schema as Record<string, unknown>;
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: 'user',
      content: `${opts.title ? `Working title: ${opts.title}\n\n` : ''}<screenplay>\n${text}\n</screenplay>`,
    },
  ];
  let lastProblems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    opts.log(
      `claude ${SCREENPLAY_MODEL}: planning screenplay (attempt ${attempt}, ${text.length} chars)`,
    );
    const msg = await call({ system: SYSTEM_PROMPT, messages, schema });
    const u = msg.usage;
    opts.log(
      `claude: ${msg.stop_reason} in ${((Date.now() - started) / 1000).toFixed(1)}s (in ${u?.input_tokens ?? '?'} / out ${u?.output_tokens ?? '?'} tokens)`,
    );
    if (msg.stop_reason === 'refusal') throw new Error('Claude declined to plan this screenplay');
    if (msg.stop_reason === 'max_tokens')
      throw new Error('Claude ran out of output tokens planning this screenplay');
    const out = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    const result = checkDraft(out, text, opts.title);
    if (result.plan) {
      for (const n of result.notes) opts.log(`plan: ${n}`);
      return result.plan;
    }
    lastProblems = result.problems;
    opts.log(
      `plan failed validation (${lastProblems.length} problem(s)): ${lastProblems.slice(0, 3).join('; ')}`,
    );
    messages.push(
      { role: 'assistant', content: msg.content as Anthropic.Beta.BetaContentBlockParam[] },
      {
        role: 'user',
        content: `That plan failed validation:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\n\nReturn the complete corrected plan (all scenes, all dialogue) as JSON matching the schema.`,
      },
    );
  }
  throw new Error(`screenplay plan invalid after retry: ${lastProblems.slice(0, 5).join('; ')}`);
}

// ---------------------------------------------------------------------------
// Draft → ScreenplayPlan
// ---------------------------------------------------------------------------

const v3 = (p: Point): Vec3 => [round3(p.x), round3(p.y), round3(p.z)];
const DEFAULT_SPEED: Record<DynamicElement['kind'], number> = {
  car: 8,
  bus: 6,
  bicycle: 5,
  bird: 6,
  pedestrian: 1.4,
  generic: 3,
};

function trimPrompt(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  if (t.length <= WORLD_PROMPT_MAX) return t;
  const cut = t.slice(0, WORLD_PROMPT_MAX);
  const sentence = cut.lastIndexOf('. ');
  return sentence > WORLD_PROMPT_MAX * 0.6
    ? cut.slice(0, sentence + 1)
    : cut.slice(0, cut.lastIndexOf(' '));
}

export interface DraftCheck {
  plan?: ScreenplayPlan;
  problems: string[];
  notes: string[];
}

/** Parses and validates Claude's JSON. Fixable issues are repaired (notes); others are problems. */
export function checkDraft(json: string, screenplay: string, titleOverride?: string): DraftCheck {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    return { problems: [`output is not valid JSON (${(e as Error).message})`], notes: [] };
  }
  const parsed = Draft.safeParse(data);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
      notes: [],
    };
  }
  return draftToPlan(parsed.data, screenplay, titleOverride);
}

export function draftToPlan(draft: Draft, screenplay: string, titleOverride?: string): DraftCheck {
  const problems: string[] = [];
  const notes: string[] = [];

  if (draft.scenes.length === 0) problems.push('no scenes returned');
  const headings = countSceneHeadings(screenplay);
  if (headings > 0 && draft.scenes.length !== headings) {
    problems.push(
      `the screenplay has ${headings} scene headings but the plan has ${draft.scenes.length} scenes`,
    );
  }
  const expectedLines = parseFountain(screenplay).scenes.reduce((n, s) => n + s.dialogue.length, 0);
  const gotLines = draft.scenes.reduce((n, s) => n + s.dialogue.length, 0);
  if (expectedLines >= 4 && gotLines < expectedLines * 0.8) {
    problems.push(
      `the plan has ${gotLines} dialogue lines but the screenplay has about ${expectedLines}; include every line`,
    );
  }

  // Characters: normalized unique ids, distinct voices where the pool allows.
  const idMap = new Map<string, string>();
  const taken = new Set<string>();
  const usedVoices = new Set<string>();
  const characters: Character[] = draft.characters.map((c) => {
    const id = uniqueSlug(slugify(c.id || c.name, 24), taken);
    idMap.set(c.id, id);
    idMap.set(c.id.toLowerCase(), id);
    idMap.set(slugify(c.name, 24), id);
    let voice: string = c.voice;
    if (usedVoices.has(voice)) {
      const pool: readonly string[] = VOICES[c.gender];
      const free = pool.find((v) => !usedVoices.has(v));
      if (free) voice = free;
    }
    usedVoices.add(voice);
    return {
      id,
      name: c.name.trim().toUpperCase(),
      description: c.description.trim(),
      voice: { id: voice, gender: c.gender },
    };
  });
  const resolve = (ref: string, where: string): string | undefined => {
    const id = idMap.get(ref) ?? idMap.get(ref.toLowerCase()) ?? idMap.get(slugify(ref, 24));
    if (!id) problems.push(`${where}: unknown characterId "${ref}" (not in characters)`);
    return id;
  };

  const slugs = new Set<string>();
  const scenes: ScenePlan[] = draft.scenes.map((s, index) => {
    const where = `scenes[${index}]`;
    const dialogue = s.dialogue.flatMap((d, order) => {
      const characterId = resolve(d.characterId, `${where}.dialogue[${order}]`);
      if (!characterId) return [];
      const parenthetical = d.parenthetical?.replace(/^\(|\)$/g, '').trim();
      return [
        {
          id: `s${index + 1}-l${order + 1}`,
          characterId,
          text: d.text.trim(),
          ...(parenthetical ? { parenthetical } : {}),
          order,
        },
      ];
    });
    const characterIds = [
      ...new Set([
        ...s.characterIds.flatMap((r) => resolve(r, `${where}.characterIds`) ?? []),
        ...dialogue.map((d) => d.characterId),
        ...s.blocking.flatMap((b) => idMap.get(b.characterId) ?? []),
      ]),
    ];

    const blocking: Blocking[] = [];
    for (const b of s.blocking) {
      const characterId = resolve(b.characterId, `${where}.blocking`);
      if (!characterId || blocking.some((x) => x.characterId === characterId)) continue;
      const position: Vec3 = [round3(b.position.x), 0, round3(b.position.z)];
      const beats: Beat[] = [];
      let at = position;
      for (const d of b.beats ?? []) {
        if (!(d.t >= 0) || !d.action.trim()) continue;
        const moveTo: Vec3 | undefined = d.moveTo
          ? [round3(d.moveTo.x), 0, round3(d.moveTo.z)]
          : undefined;
        if (moveTo) at = moveTo;
        beats.push({
          t: round3(d.t),
          action: d.action.trim().slice(0, 200),
          ...(moveTo ? { moveTo } : {}),
          ...(d.pose ? { pose: d.pose } : {}),
          ...(d.facing ? { yaw: round3(yawFacing(at, v3(d.facing))) } : {}),
        });
      }
      blocking.push({
        characterId,
        position,
        yaw: round3(yawFacing(position, v3(b.facing))),
        pose: b.pose,
        ...(beats.length ? { beats: beats.slice(0, 24) } : {}),
      });
    }
    const unplaced = characterIds.filter((id) => !blocking.some((b) => b.characterId === id));
    if (unplaced.length) {
      notes.push(`${where}: no blocking for ${unplaced.join(', ')}; placed heuristically`);
      const fill = heuristicBlocking(unplaced, s.interior);
      for (const b of fill) b.position = [round3(b.position[0] + 2.5), 0, b.position[2]];
      blocking.push(...fill);
    }

    const dynamics: DynamicElement[] = s.dynamics.flatMap((d, k) => {
      if (d.path.length < 2) {
        notes.push(`${where}.dynamics[${k}]: path has < 2 points; dropped`);
        return [];
      }
      return [
        {
          id: `s${index + 1}-${d.kind}-${k + 1}`,
          kind: d.kind,
          label: d.label.trim() || d.kind,
          path: d.path.map(v3),
          speed: d.speed > 0 ? d.speed : DEFAULT_SPEED[d.kind],
          loop: d.loop,
          pauseSeconds: Math.max(0, d.pauseSeconds),
          scale: d.scale > 0 ? d.scale : 1,
        },
      ];
    });

    const shots: SuggestedShot[] = s.shots.map((sh) => {
      const position = v3(sh.position);
      return {
        name: sh.name.trim(),
        position,
        quaternion: lookAtQuat(position, v3(sh.lookAt)),
        fovDeg: round3(clamp(sh.fovDeg, 10, 120)),
      };
    });

    const worldPrompt = trimPrompt(s.worldPrompt);
    if (worldPrompt.length < s.worldPrompt.trim().length)
      notes.push(`${where}: worldPrompt trimmed to ${worldPrompt.length} chars`);
    if (!worldPrompt) problems.push(`${where}: worldPrompt is empty`);

    return {
      index,
      slug: uniqueSlug(slugify(s.heading), slugs),
      heading: s.heading.trim(),
      action: s.action.trim(),
      worldPrompt,
      timeOfDay: s.timeOfDay,
      interior: s.interior,
      characterIds,
      dialogue,
      blocking,
      dynamics,
      shots,
    };
  });

  if (problems.length) return { problems, notes };
  const checked = ScreenplayPlan.safeParse({
    title: titleOverride?.trim() || draft.title.trim() || 'Untitled',
    characters,
    scenes,
  });
  if (!checked.success) {
    return {
      problems: checked.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
      notes,
    };
  }
  return { plan: checked.data, problems: [], notes };
}

export function summarizePlan(plan: ScreenplayPlan): string {
  const lines = [
    `"${plan.title}": ${plan.scenes.length} scene(s), ${plan.characters.length} character(s)`,
  ];
  for (const c of plan.characters)
    lines.push(`  ${c.name} (${c.id}, ${c.voice.gender}, voice ${c.voice.id}): ${c.description}`);
  for (const s of plan.scenes) {
    lines.push(
      `  [${s.index}] ${s.heading} — ${s.timeOfDay}${s.interior ? ', interior' : ''}; ${s.dialogue.length} line(s), ${s.dynamics.length} dynamic(s), ${s.shots.length} shot(s)`,
    );
    lines.push(`      world: ${s.worldPrompt}`);
    for (const b of s.blocking) {
      lines.push(
        `      ${b.characterId} @ [${b.position.join(', ')}] yaw ${b.yaw.toFixed(2)} ${b.pose}`,
      );
    }
    for (const d of s.dynamics)
      lines.push(`      ${d.kind}: ${d.label} (${d.path.length} pts, ${d.speed} m/s)`);
    for (const sh of s.shots)
      lines.push(`      shot "${sh.name}" @ [${sh.position.join(', ')}] fov ${sh.fovDeg}`);
    for (const d of s.dialogue.slice(0, 2)) lines.push(`      ${d.id} ${d.characterId}: ${d.text}`);
  }
  return lines.join('\n');
}
