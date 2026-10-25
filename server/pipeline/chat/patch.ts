// Plan patches: a (target, field, value) triple from the chat planner, checked against the plan
// and applied to it. Shared by the Claude and the mock planner (both emit text values) and by the
// apply step, so a patch means the same thing whoever proposed it.
//
//   target "character:<id>"  fields name · description · heightMeters · voice.id · voice.gender ·
//                                   referenceImage ("" clears it; photos go through character-reference)
//   target "scene:<index>"   fields heading · action · worldPrompt · timeOfDay · interior ·
//                                   worldReference ("" clears it) · blocking.<characterId>.position |
//                                   .pose | .facing
//                                   look.preset · look.mood · look.<exposure|contrast|saturation|
//                                   temperature|tint|lut|lutStrength|vignette|grain|bloom> ·
//                                   look.fog.color|density · look.skyTint.color|strength ·
//                                   dynamics (the background action, below)
//   target "line:<lineId>"   fields text · parenthetical ("" clears it)
//   target "project"         field  title
//   target "style"           fields genre · era · worldStyle · palette (the whole screenplay's style)
//
// A look field edits the scene's LookSeed (a plan made before looks were planned starts from the
// derived one, look-seed.ts); a new preset keeps the mood words and drops the adjustments tuned to
// the old one. Style and look changes are free: on a generated scene apply.ts re-grades
// edits.json, nothing is regenerated.
//
// Scene targets use ScenePlan.index (0-based, like scene-<n>/ and every sceneIndex in the API);
// the director's "scene 2" is index 1.
//
// A scene's `dynamics` (its moving props: traffic, animals, monsters, aircraft) take a JSON value,
// either the changes or the whole new list:
//
//   {"add": [{"kind": "creature", "label": "a dinosaur walking by"}], "remove": ["s1-car", "bus"]}
//   [{"kind": "airplane", "label": "an airliner flies low overhead", "path": [[-40, 24, -150], [20, 22, 60]], "speed": 25}, …]
//
// An added element needs a label (the viewer builds its body from it); kind defaults to the one its
// words name (dynamics.ts kindForWords), path / speed / pauseSeconds to the standard path for the
// label near the scene's actors (dynamics.ts dynamicPath), loop to true, scale to 1, and id to
// "s<n>-<kind>-<k>". A point is [x, y, z] (or {x, y, z}) in metres; one point or speed 0 parks or
// hovers it there. `remove` takes element ids, or a word of the label / a kind ("dinosaur"). The
// applied value is the full new list. Free: on a generated scene apply.ts rewrites the manifest
// from the plan (world, actors and audio untouched) and the open scene swaps its props live.
import { LOOK_PRESET_LABELS, LOOK_PRESETS, seedToLook } from '../../../shared/look-presets.ts';
import {
  DynamicElement,
  DynamicElementKind,
  LookPresetName,
  LutPreset,
  ScreenplayPlan,
  type Blocking,
  type Character,
  type DialogueLine,
  type LookSeed,
  type ScenePlan,
  type Vec3,
  type VisualStyle,
} from '../../../shared/schema.ts';
import { DEFAULT_SPEED, dynamicPath, kindForWords, sceneCentre } from '../dynamics.ts';
import { VOICE_IDS } from '../fountain.ts';
import { round3, yawFacing } from '../geometry.ts';
import { lookSeedFor, styleForPlan } from '../look-seed.ts';
import { OPENAI_VOICES } from '../tts.ts';

export const VOICE_CHOICES = [...new Set<string>([...VOICE_IDS, ...OPENAI_VOICES])];
const WORLD_PROMPT_MAX = 600;

export type Target =
  | { kind: 'character'; id: string }
  | { kind: 'scene'; index: number }
  | { kind: 'line'; id: string; sceneIndex: number }
  | { kind: 'project' }
  | { kind: 'style' };

/** What a changed field invalidates on a generated project (apply.ts turns it into follow-ups). */
export type Effect = 'actor' | 'voice' | 'world' | 'manifest' | 'look' | 'none';

export interface Patch {
  target: Target;
  /** Canonical target string ("character:theo", "scene:1", "line:s2-l3", "project"). */
  targetKey: string;
  field: string;
  value: unknown;
}

export const targetKey = (t: Target) =>
  t.kind === 'project' || t.kind === 'style'
    ? t.kind
    : t.kind === 'scene'
      ? `scene:${t.index}`
      : `${t.kind}:${t.id}`;

/** Finds a character by id or by name (any case; "Leo", "LEO", "leo"). */
export function findCharacter(plan: ScreenplayPlan, ref: string): Character | undefined {
  const r = ref.trim().toLowerCase();
  return plan.characters.find((c) => c.id.toLowerCase() === r || c.name.toLowerCase() === r);
}

export function findLine(
  plan: ScreenplayPlan,
  id: string,
): { line: DialogueLine; scene: ScenePlan } | undefined {
  for (const scene of plan.scenes) {
    const line = scene.dialogue.find((l) => l.id === id);
    if (line) return { line, scene };
  }
  return undefined;
}

/** "character:theo" | "scene:1" | "line:s2-l3" | "project" | "style" → a target that exists in the plan. */
export function parseTarget(plan: ScreenplayPlan, raw: string): Target | { error: string } {
  const t = raw.trim();
  if (t === 'project') return { kind: 'project' };
  if (t === 'style') return { kind: 'style' };
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
  return hit
    ? { kind: 'line', id: hit.line.id, sceneIndex: hit.scene.index }
    : { error: `no line "${ref}"` };
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

/** Scene look fields (LookSeed paths) and the numeric ranges of shared/schema.ts LookSeed. */
const LOOK_NUMBERS = {
  exposure: [-3, 3],
  contrast: [0.5, 2],
  saturation: [0, 2],
  temperature: [-1, 1],
  tint: [-1, 1],
  lutStrength: [0, 1],
  vignette: [0, 1],
  grain: [0, 1],
  bloom: [0, 1],
  'fog.density': [0, 1],
  'skyTint.strength': [0, 1],
} as const;
type LookNumber = keyof typeof LOOK_NUMBERS;
export const LOOK_FIELDS = [
  'look.preset',
  'look.mood',
  'look.lut',
  ...Object.keys(LOOK_NUMBERS).map((k) => `look.${k}`),
  'look.fog.color',
  'look.skyTint.color',
] as const;
const isLookField = (f: string) => (LOOK_FIELDS as readonly string[]).includes(f);
const STYLE_MAX: Record<keyof VisualStyle, number> = {
  genre: 80,
  era: 120,
  worldStyle: 200,
  palette: 120,
};

/** "Golden hour" / "golden_hour" / "golden-hour" → "golden-hour". */
const presetName = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

/** "#abc" / "AABBCC" → "#aabbcc"; anything else → undefined. */
function hexColor(s: string): string | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return undefined;
  const h = m[1]!.toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join('') : h}`;
}

/** The scene's look as the plan will hold it (a derived one for plans made before looks). */
const sceneSeed = (plan: ScreenplayPlan, scene: ScenePlan): LookSeed =>
  structuredClone(lookSeedFor(scene, styleForPlan(plan)));

/** A look field's value: the seed's own, else what its preset gives (so "colder" has a number to move). */
function lookValue(seed: LookSeed, field: string): unknown {
  const path = field.slice('look.'.length);
  if (path === 'preset') return seed.preset;
  if (path === 'mood') return seed.mood;
  const [group, key] = path.split('.') as [string, string | undefined];
  const look = seedToLook(seed) as unknown as Record<string, unknown>;
  const v = look[group];
  return key ? (v as Record<string, unknown>)[key] : v;
}

function setLookField(seed: LookSeed, field: string, v: unknown): LookSeed {
  const path = field.slice('look.'.length);
  // the old preset's adjustments do not carry over to a new one; the scene's mood words do
  if (path === 'preset') return { preset: v as LookSeed['preset'], mood: seed.mood };
  const [group, key] = path.split('.') as [string, string | undefined];
  if (group === 'fog' || group === 'skyTint') {
    const base = seed[group] ?? LOOK_PRESETS[seed.preset][group];
    return { ...seed, [group]: { ...base, [key!]: v } };
  }
  return { ...seed, [group]: v };
}

/** Fields a target accepts (blocking fields are per character: blocking.<id>.position …). */
export const FIELDS = {
  character: ['name', 'description', 'heightMeters', 'voice.id', 'voice.gender', 'referenceImage'],
  scene: [
    'heading',
    'action',
    'worldPrompt',
    'timeOfDay',
    'interior',
    'worldReference',
    'blocking.<characterId>.position',
    'blocking.<characterId>.pose',
    'blocking.<characterId>.facing',
    ...LOOK_FIELDS,
    'dynamics',
  ],
  line: ['text', 'parenthetical'],
  project: ['title'],
  style: ['genre', 'era', 'worldStyle', 'palette'],
} as const;

/** Text value → typed value for the field, or an error the planner's reply can quote. */
export function parseValue(
  plan: ScreenplayPlan,
  target: Target,
  field: string,
  raw: string,
): { value: unknown } | { error: string } {
  const s = raw.trim();
  const text = (max: number, allowEmpty = false) =>
    s || allowEmpty ? { value: s.slice(0, max) } : { error: `${field} cannot be empty` };
  switch (target.kind) {
    case 'project':
      return field === 'title' ? text(200) : { error: `project has no field ${field}` };
    case 'style':
      return field in STYLE_MAX
        ? text(STYLE_MAX[field as keyof VisualStyle])
        : { error: `the style has no field ${field} (${FIELDS.style.join(', ')})` };
    case 'line':
      if (field === 'text') return text(1000);
      if (field === 'parenthetical')
        return {
          value: s
            .replace(/^\(|\)$/g, '')
            .trim()
            .slice(0, 200),
        };
      return { error: `a line has no field ${field} (text, parenthetical)` };
    case 'character':
      switch (field) {
        case 'name':
          return s ? { value: s.toUpperCase().slice(0, 60) } : { error: 'name cannot be empty' };
        case 'description':
          return text(1200);
        case 'heightMeters': {
          const h = parseHeight(s);
          if (!Number.isFinite(h) || h < 0.9 || h > 2.3)
            return { error: `height "${s}" is outside 0.9-2.3 m` };
          return { value: Math.round(h * 100) / 100 };
        }
        case 'voice.id': {
          const v = s.toLowerCase();
          return VOICE_CHOICES.includes(v)
            ? { value: v }
            : { error: `unknown voice "${s}" (${VOICE_CHOICES.join(', ')})` };
        }
        case 'voice.gender': {
          const g = s.toLowerCase();
          return g === 'female' || g === 'male' || g === 'neutral'
            ? { value: g }
            : { error: `voice.gender must be female, male or neutral` };
        }
        case 'referenceImage':
          return s
            ? { error: 'set a reference photo with character-reference; "" clears it' }
            : { value: '' };
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
          return p === 'standing' || p === 'sitting' || p === 'walking'
            ? { value: p }
            : { error: 'pose must be standing, sitting or walking' };
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
      if (isLookField(field)) return parseLookValue(field, s);
      if (field === 'dynamics') return parseDynamics(plan.scenes[target.index]!, s);
      switch (field) {
        case 'heading':
          return s
            ? { value: s.toUpperCase().slice(0, 200) }
            : { error: 'heading cannot be empty' };
        case 'action':
          return text(8000, true);
        case 'worldPrompt':
          return text(WORLD_PROMPT_MAX);
        case 'timeOfDay': {
          const t = s.toLowerCase();
          return ['dawn', 'day', 'dusk', 'night'].includes(t)
            ? { value: t }
            : { error: 'timeOfDay must be dawn, day, dusk or night' };
        }
        case 'interior': {
          const v = parseBool(s);
          return v === undefined ? { error: 'interior must be true or false' } : { value: v };
        }
        case 'worldReference':
          return s
            ? { error: 'set a place photo with world-reference; "" clears it' }
            : { value: '' };
      }
      return { error: `a scene has no field ${field} (${FIELDS.scene.join(', ')})` };
    }
  }
}

const DYNAMICS_SHAPE = 'dynamics takes JSON: {"add": [{"kind", "label", "path"?, "speed"?}], "remove": ["<id or word>"]} or the full list';

/** "[1, 0, -8]" | {x, y, z} | [x, z] → a point, else undefined. */
function point(v: unknown): Vec3 | undefined {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : NaN);
  let p: number[] = [];
  if (Array.isArray(v)) p = v.length === 2 ? [n(v[0]), 0, n(v[1])] : v.slice(0, 3).map(n);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    p = [n(o.x), o.y === undefined ? 0 : n(o.y), n(o.z)];
  }
  return p.length === 3 && p.every(Number.isFinite) ? [round3(p[0]!), round3(p[1]!), round3(p[2]!)] : undefined;
}

/** A `dynamics` patch value → the scene's new list (see the header for the shape). */
export function parseDynamics(scene: ScenePlan, raw: string): { value: DynamicElement[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: DYNAMICS_SHAPE };
  }
  const list = structuredClone(scene.dynamics);
  let adds: unknown[];
  if (Array.isArray(v)) {
    list.length = 0;
    adds = v;
  } else if (v && typeof v === 'object') {
    const o = v as { add?: unknown; remove?: unknown };
    const removes = Array.isArray(o.remove) ? o.remove : o.remove == null ? [] : [o.remove];
    for (const r of removes) {
      const want = String(r).trim().toLowerCase();
      if (!want) continue;
      const byId = list.filter((d) => d.id.toLowerCase() === want);
      const word = new RegExp(`\\b${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
      const byLabel = byId.length ? byId : list.filter((d) => word.test(d.label));
      const kind = DynamicElementKind.safeParse(want).success ? want : kindForWords(want);
      const hits = byLabel.length ? byLabel : list.filter((d) => d.kind === kind);
      if (!hits.length) return { error: `scene ${scene.index + 1} has no background "${String(r)}" (${list.map((d) => d.id).join(', ') || 'none'})` };
      for (const h of hits) list.splice(list.indexOf(h), 1);
    }
    adds = Array.isArray(o.add) ? o.add : o.add == null ? [] : [o.add];
  } else return { error: DYNAMICS_SHAPE };
  const centre = sceneCentre(scene.blocking);
  for (const a of adds) {
    const o = (typeof a === 'string' ? { label: a } : a) as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return { error: DYNAMICS_SHAPE };
    const label = String(o.label ?? '').trim().slice(0, 160);
    const asked = String(o.kind ?? '').trim().toLowerCase();
    const known = DynamicElementKind.safeParse(asked);
    const kind = known.success ? known.data : (kindForWords(`${asked} ${label}`) ?? 'generic');
    if (kind === 'model') return { error: 'a model prop comes from an imported or generated 3D file, not from the chat' };
    if (!label && !known.success) return { error: 'an added background element needs a label' };
    const given = Array.isArray(o.path) ? o.path.map(point) : [];
    if (given.some((p) => !p)) return { error: `${label || kind}: a path point is [x, y, z] in metres` };
    const auto = dynamicPath(kind, label || kind, { centre });
    const path = given.length ? (given as Vec3[]) : auto.path;
    const length = path.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - path[i]![0], p[1] - path[i]![1], p[2] - path[i]![2]), 0);
    const speed =
      typeof o.speed === 'number' && o.speed >= 0
        ? Math.min(o.speed, 120)
        : given.length
          ? path.length < 2 || length < 1
            ? 0
            : DEFAULT_SPEED[kind]
          : auto.speed;
    const taken = new Set(list.map((d) => d.id));
    let id = typeof o.id === 'string' && o.id.trim() && !taken.has(o.id.trim()) ? o.id.trim() : '';
    for (let k = 1; !id; k++) if (!taken.has(`s${scene.index + 1}-${kind}-${k}`)) id = `s${scene.index + 1}-${kind}-${k}`;
    const el = DynamicElement.safeParse({
      id,
      kind,
      label: label || kind,
      path,
      speed,
      loop: typeof o.loop === 'boolean' ? o.loop : true,
      pauseSeconds: typeof o.pauseSeconds === 'number' && o.pauseSeconds >= 0 ? o.pauseSeconds : given.length ? 2 : auto.pauseSeconds,
      scale: typeof o.scale === 'number' && o.scale > 0 ? Math.min(10, Math.max(0.1, o.scale)) : 1,
    });
    if (!el.success) return { error: `${label || kind}: ${el.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
    list.push(el.data);
  }
  return { value: list };
}

function parseLookValue(field: string, s: string): { value: unknown } | { error: string } {
  const path = field.slice('look.'.length);
  if (path === 'preset') {
    const want = presetName(s);
    const hit = LookPresetName.options.find(
      (p) => p === want || presetName(LOOK_PRESET_LABELS[p]) === want,
    );
    return hit
      ? { value: hit }
      : { error: `unknown look preset "${s}" (${LookPresetName.options.join(', ')})` };
  }
  if (path === 'mood') return { value: s.slice(0, 60).trim() };
  if (path === 'lut') {
    const lut = LutPreset.safeParse(presetName(s));
    return lut.success
      ? { value: lut.data }
      : { error: `unknown LUT "${s}" (${LutPreset.options.join(', ')})` };
  }
  if (path.endsWith('.color')) {
    const c = hexColor(s);
    return c ? { value: c } : { error: `"${s}" is not a colour (#rrggbb)` };
  }
  const range = LOOK_NUMBERS[path as LookNumber];
  const v = num(s);
  if (!range || !Number.isFinite(v)) return { error: `${field} needs a number` };
  return v < range[0] || v > range[1]
    ? { error: `${field} ${v} is outside ${range[0]}…${range[1]}` }
    : { value: round3(v) };
}

/** The field's current value (blocking fields read the character's mark). */
export function getValue(plan: ScreenplayPlan, p: Pick<Patch, 'target' | 'field'>): unknown {
  const t = p.target;
  if (t.kind === 'project') return plan.title;
  if (t.kind === 'style') return plan.style?.[p.field as keyof VisualStyle];
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
  if (isLookField(p.field)) return lookValue(sceneSeed(plan, scene), p.field);
  const b = BLOCKING_FIELD.exec(p.field);
  if (b) {
    const mark = scene.blocking.find((x) => x.characterId === findCharacter(plan, b[1]!)?.id)!;
    return b[2] === 'pose'
      ? mark.pose
      : b[2] === 'position'
        ? mark.position
        : Math.round((mark.yaw * 1800) / Math.PI) / 10;
  }
  if (p.field === 'worldReference') return scene.worldReference?.file;
  if (p.field === 'dynamics') return scene.dynamics;
  return scene[p.field as 'heading' | 'action' | 'worldPrompt' | 'timeOfDay' | 'interior'];
}

/** Applies a checked patch to `plan` in place; resolves with the before / after values. */
export function applyPatch(plan: ScreenplayPlan, p: Patch): { before: unknown; after: unknown } {
  const before = getValue(plan, p);
  const t = p.target;
  const v = p.value;
  if (t.kind === 'project') plan.title = v as string;
  else if (t.kind === 'style') plan.style = { ...styleForPlan(plan), [p.field]: v as string };
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
    if (isLookField(p.field)) scene.look = setLookField(sceneSeed(plan, scene), p.field, v);
    else if (b) {
      const mark: Blocking = scene.blocking.find(
        (x) => x.characterId === findCharacter(plan, b[1]!)?.id,
      )!;
      if (b[2] === 'pose') mark.pose = v as Blocking['pose'];
      else if (b[2] === 'position') mark.position = v as Vec3;
      else mark.yaw = round3(yawFacing(mark.position, v as Vec3));
    } else if (p.field === 'worldReference') delete scene.worldReference;
    else if (p.field === 'dynamics') scene.dynamics = v as DynamicElement[];
    else if (p.field === 'interior') scene.interior = v as boolean;
    else scene[p.field as 'heading' | 'action' | 'worldPrompt' | 'timeOfDay'] = v as never;
  }
  return { before, after: getValue(plan, p) };
}

/** What the change means for a project whose assets exist. */
export function effectOf(p: Pick<Patch, 'target' | 'field'>): Effect {
  const t = p.target;
  if (t.kind === 'project' || t.kind === 'style') return 'none';
  if (t.kind === 'line') return 'voice';
  if (t.kind === 'character') {
    if (p.field.startsWith('voice.')) return 'voice';
    return p.field === 'name' ? 'manifest' : 'actor';
  }
  // a grade is applied at render time: free, never a new world
  if (isLookField(p.field)) return 'look';
  if (['worldPrompt', 'timeOfDay', 'interior', 'worldReference'].includes(p.field)) return 'world';
  return 'manifest';
}

/** Checks a text patch against the plan; a valid one is returned typed and ready to apply. */
export function checkPatch(
  plan: ScreenplayPlan,
  target: string,
  field: string,
  value: string,
): Patch | { error: string } {
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
  if (!ok.success)
    return { error: ok.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return patch;
}
