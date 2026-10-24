// Plan patches: a (target, field, value) triple from the chat planner, checked against the plan
// and applied to it. Shared by the Claude and the mock planner (both emit text values) and by the
// apply step, so a patch means the same thing whoever proposed it.
//
//   target "character:<id>"  fields name · description · heightMeters · voice.id · voice.gender ·
//                                   referenceImage ("" clears it; photos go through character-reference)
//   target "scene:<index>"   fields heading · action · worldPrompt · timeOfDay · interior ·
//                                   worldReference ("" clears it) · blocking.<characterId>.position |
//                                   .pose | .facing
//   target "line:<lineId>"   fields text · parenthetical ("" clears it)
//   target "project"         field  title
//
// Scene targets use ScenePlan.index (0-based, like scene-<n>/ and every sceneIndex in the API);
// the director's "scene 2" is index 1.
import { ScreenplayPlan, type Blocking, type Character, type DialogueLine, type ScenePlan, type Vec3 } from '../../../shared/schema.ts';
import { VOICE_IDS } from '../fountain.ts';
import { round3, yawFacing } from '../geometry.ts';
import { OPENAI_VOICES } from '../tts.ts';

export const VOICE_CHOICES = [...new Set<string>([...VOICE_IDS, ...OPENAI_VOICES])];
const WORLD_PROMPT_MAX = 600;

export type Target =
  | { kind: 'character'; id: string }
  | { kind: 'scene'; index: number }
  | { kind: 'line'; id: string; sceneIndex: number }
  | { kind: 'project' };

/** What a changed field invalidates on a generated project (apply.ts turns it into follow-ups). */
export type Effect = 'actor' | 'voice' | 'world' | 'manifest' | 'none';

export interface Patch {
  target: Target;
  /** Canonical target string ("character:theo", "scene:1", "line:s2-l3", "project"). */
  targetKey: string;
  field: string;
  value: unknown;
}

export const targetKey = (t: Target) =>
  t.kind === 'project' ? 'project' : t.kind === 'scene' ? `scene:${t.index}` : `${t.kind}:${t.id}`;

/** Finds a character by id or by name (any case; "Leo", "LEO", "leo"). */
export function findCharacter(plan: ScreenplayPlan, ref: string): Character | undefined {
  const r = ref.trim().toLowerCase();
  return plan.characters.find((c) => c.id.toLowerCase() === r || c.name.toLowerCase() === r);
}

export function findLine(plan: ScreenplayPlan, id: string): { line: DialogueLine; scene: ScenePlan } | undefined {
  for (const scene of plan.scenes) {
    const line = scene.dialogue.find((l) => l.id === id);
    if (line) return { line, scene };
  }
  return undefined;
}

/** "character:theo" | "scene:1" | "line:s2-l3" | "project" → a target that exists in the plan. */
export function parseTarget(plan: ScreenplayPlan, raw: string): Target | { error: string } {
  const t = raw.trim();
  if (t === 'project') return { kind: 'project' };
  const m = /^(character|scene|line):(.+)$/i.exec(t);
  if (!m) return { error: `unknown target "${t}"` };
  const kind = m[1]!.toLowerCase();
  const ref = m[2]!.trim();
  if (kind === 'character') {
    const c = findCharacter(plan, ref);
    return c ? { kind: 'character', id: c.id } : { error: `no character "${ref}"` };
  }
  if (kind === 'scene') {
    const index = Number(ref);
    return Number.isInteger(index) && plan.scenes[index]
      ? { kind: 'scene', index }
      : { error: `no scene ${ref} (scenes are 0…${plan.scenes.length - 1})` };
  }
  const hit = findLine(plan, ref);
  return hit ? { kind: 'line', id: hit.line.id, sceneIndex: hit.scene.index } : { error: `no line "${ref}"` };
}

const num = (s: string) => {
  const m = /-?\d+(?:\.\d+)?/.exec(s);
  return m ? Number(m[0]) : NaN;
};

/** "1.85", "1.85 m", "185 cm", "185" → metres. */
export function parseHeight(s: string): number {
  const v = num(s);
  if (!Number.isFinite(v)) return NaN;
  return /cm\b/i.test(s) || v > 3 ? v / 100 : v;
}

/** "1.2, 0, -2.5" | "[1.2, 0, -2.5]" | "1.2, -2.5" (x, z on the floor) → Vec3. */
export function parsePoint(s: string): Vec3 | undefined {
  const nums = (s.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (nums.length === 2) return [round3(nums[0]!), 0, round3(nums[1]!)];
  if (nums.length === 3) return [round3(nums[0]!), round3(nums[1]!), round3(nums[2]!)];
  return undefined;
}

function parseBool(s: string): boolean | undefined {
  const v = s.trim().toLowerCase();
  if (['true', 'yes', 'interior', 'int', 'inside', 'indoors'].includes(v)) return true;
  if (['false', 'no', 'exterior', 'ext', 'outside', 'outdoors'].includes(v)) return false;
  return undefined;
}

const BLOCKING_FIELD = /^blocking\.([^.]+)\.(position|pose|facing)$/;

/** Fields a target accepts (blocking fields are per character: blocking.<id>.position …). */
export const FIELDS = {
  character: ['name', 'description', 'heightMeters', 'voice.id', 'voice.gender', 'referenceImage'],
  scene: ['heading', 'action', 'worldPrompt', 'timeOfDay', 'interior', 'worldReference', 'blocking.<characterId>.position', 'blocking.<characterId>.pose', 'blocking.<characterId>.facing'],
  line: ['text', 'parenthetical'],
  project: ['title'],
} as const;

/** Text value → typed value for the field, or an error the planner's reply can quote. */
export function parseValue(plan: ScreenplayPlan, target: Target, field: string, raw: string): { value: unknown } | { error: string } {
  const s = raw.trim();
  const text = (max: number, allowEmpty = false) =>
    s || allowEmpty ? { value: s.slice(0, max) } : { error: `${field} cannot be empty` };
  switch (target.kind) {
    case 'project':
      return field === 'title' ? text(200) : { error: `project has no field ${field}` };
    case 'line':
      if (field === 'text') return text(1000);
      if (field === 'parenthetical') return { value: s.replace(/^\(|\)$/g, '').trim().slice(0, 200) };
      return { error: `a line has no field ${field} (text, parenthetical)` };
    case 'character':
      switch (field) {
        case 'name':
          return s ? { value: s.toUpperCase().slice(0, 60) } : { error: 'name cannot be empty' };
        case 'description':
          return text(1200);
        case 'heightMeters': {
          const h = parseHeight(s);
          if (!Number.isFinite(h) || h < 0.9 || h > 2.3) return { error: `height "${s}" is outside 0.9-2.3 m` };
          return { value: Math.round(h * 100) / 100 };
        }
        case 'voice.id': {
          const v = s.toLowerCase();
          return VOICE_CHOICES.includes(v) ? { value: v } : { error: `unknown voice "${s}" (${VOICE_CHOICES.join(', ')})` };
        }
        case 'voice.gender': {
          const g = s.toLowerCase();
          return g === 'female' || g === 'male' || g === 'neutral' ? { value: g } : { error: `voice.gender must be female, male or neutral` };
        }
        case 'referenceImage':
          return s ? { error: 'set a reference photo with character-reference; "" clears it' } : { value: '' };
      }
      return { error: `a character has no field ${field} (${FIELDS.character.join(', ')})` };
    case 'scene': {
      const b = BLOCKING_FIELD.exec(field);
      if (b) {
        const scene = plan.scenes[target.index]!;
        const who = findCharacter(plan, b[1]!);
        if (!who || !scene.blocking.some((x) => x.characterId === who.id))
          return { error: `${b[1]} has no mark in scene ${target.index}` };
        if (b[2] === 'pose') {
          const p = s.toLowerCase();
          return p === 'standing' || p === 'sitting' || p === 'walking' ? { value: p } : { error: 'pose must be standing, sitting or walking' };
        }
        if (b[2] === 'facing') {
          const other = findCharacter(plan, s);
          const mark = other && scene.blocking.find((x) => x.characterId === other.id);
          if (mark) return { value: mark.position };
          if (/^(camera|the camera|origin)$/i.test(s)) return { value: [0, 0, 0] as Vec3 };
        }
        const p = parsePoint(s);
        return p ? { value: p } : { error: `"${s}" is not a point (x, y, z in metres)` };
      }
      switch (field) {
        case 'heading':
          return s ? { value: s.toUpperCase().slice(0, 200) } : { error: 'heading cannot be empty' };
        case 'action':
          return text(8000, true);
        case 'worldPrompt':
          return text(WORLD_PROMPT_MAX);
        case 'timeOfDay': {
          const t = s.toLowerCase();
          return ['dawn', 'day', 'dusk', 'night'].includes(t) ? { value: t } : { error: 'timeOfDay must be dawn, day, dusk or night' };
        }
        case 'interior': {
          const v = parseBool(s);
          return v === undefined ? { error: 'interior must be true or false' } : { value: v };
        }
        case 'worldReference':
          return s ? { error: 'set a place photo with world-reference; "" clears it' } : { value: '' };
      }
      return { error: `a scene has no field ${field} (${FIELDS.scene.join(', ')})` };
    }
  }
}

/** The field's current value (blocking fields read the character's mark). */
export function getValue(plan: ScreenplayPlan, p: Pick<Patch, 'target' | 'field'>): unknown {
  const t = p.target;
  if (t.kind === 'project') return plan.title;
  if (t.kind === 'line') {
    const l = findLine(plan, t.id)!.line;
    return p.field === 'text' ? l.text : l.parenthetical;
  }
  if (t.kind === 'character') {
    const c = plan.characters.find((x) => x.id === t.id)!;
    if (p.field === 'voice.id') return c.voice.id;
    if (p.field === 'voice.gender') return c.voice.gender;
    return c[p.field as 'name' | 'description' | 'heightMeters' | 'referenceImage'];
  }
  const scene = plan.scenes[t.index]!;
  const b = BLOCKING_FIELD.exec(p.field);
  if (b) {
    const mark = scene.blocking.find((x) => x.characterId === findCharacter(plan, b[1]!)?.id)!;
    return b[2] === 'pose' ? mark.pose : b[2] === 'position' ? mark.position : Math.round((mark.yaw * 1800) / Math.PI) / 10;
  }
  if (p.field === 'worldReference') return scene.worldReference?.file;
  return scene[p.field as 'heading' | 'action' | 'worldPrompt' | 'timeOfDay' | 'interior'];
}

/** Applies a checked patch to `plan` in place; resolves with the before / after values. */
export function applyPatch(plan: ScreenplayPlan, p: Patch): { before: unknown; after: unknown } {
  const before = getValue(plan, p);
  const t = p.target;
  const v = p.value;
  if (t.kind === 'project') plan.title = v as string;
  else if (t.kind === 'line') {
    const l = findLine(plan, t.id)!.line;
    if (p.field === 'text') l.text = v as string;
    else if (v) l.parenthetical = v as string;
    else delete l.parenthetical;
  } else if (t.kind === 'character') {
    const c = plan.characters.find((x) => x.id === t.id)!;
    if (p.field === 'voice.id') c.voice.id = v as string;
    else if (p.field === 'voice.gender') c.voice.gender = v as Character['voice']['gender'];
    else if (p.field === 'referenceImage') delete c.referenceImage;
    else if (p.field === 'heightMeters') c.heightMeters = v as number;
    else c[p.field as 'name' | 'description'] = v as string;
  } else {
    const scene = plan.scenes[t.index]!;
    const b = BLOCKING_FIELD.exec(p.field);
    if (b) {
      const mark: Blocking = scene.blocking.find((x) => x.characterId === findCharacter(plan, b[1]!)?.id)!;
      if (b[2] === 'pose') mark.pose = v as Blocking['pose'];
      else if (b[2] === 'position') mark.position = v as Vec3;
      else mark.yaw = round3(yawFacing(mark.position, v as Vec3));
    } else if (p.field === 'worldReference') delete scene.worldReference;
    else if (p.field === 'interior') scene.interior = v as boolean;
    else scene[p.field as 'heading' | 'action' | 'worldPrompt' | 'timeOfDay'] = v as never;
  }
  return { before, after: getValue(plan, p) };
}

/** What the change means for a project whose assets exist. */
export function effectOf(p: Pick<Patch, 'target' | 'field'>): Effect {
  const t = p.target;
  if (t.kind === 'project') return 'none';
  if (t.kind === 'line') return 'voice';
  if (t.kind === 'character') {
    if (p.field.startsWith('voice.')) return 'voice';
    return p.field === 'name' ? 'manifest' : 'actor';
  }
  if (['worldPrompt', 'timeOfDay', 'interior', 'worldReference'].includes(p.field)) return 'world';
  return 'manifest';
}

/** Checks a text patch against the plan; a valid one is returned typed and ready to apply. */
export function checkPatch(plan: ScreenplayPlan, target: string, field: string, value: string): Patch | { error: string } {
  const t = parseTarget(plan, target);
  if ('error' in t) return t;
  const f = field.trim();
  const parsed = parseValue(plan, t, f, value);
  if ('error' in parsed) return parsed;
  const patch: Patch = { target: t, targetKey: targetKey(t), field: f, value: parsed.value };
  // the whole plan must still validate (lengths, ranges) after the change
  const trial = structuredClone(plan);
  applyPatch(trial, patch);
  const ok = ScreenplayPlan.safeParse(trial);
  if (!ok.success) return { error: ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return patch;
}
