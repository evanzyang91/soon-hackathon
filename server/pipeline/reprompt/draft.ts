// The planner's intermediate "draft" (what Claude — or the offline keyword planner — fills in)
// and the deterministic step that turns it into a validated EditPlan under the scope rules of
// docs/PLAN-v2.md §2. Kept separate from the Claude call so both planners share every rule.
//
// The draft avoids unions and optional fields on purpose (structured outputs limit both): every
// field is required, with sentinels ("none", "", scale 1, a zero vector) for "no change".
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  EditPlan,
  EditScope,
  Light,
  LightKind,
  LutPreset,
  SceneEdit,
  type Look,
} from '../../../shared/look.ts';
import { DynamicElementKind, type DynamicElement, type Quat, type Vec3 } from '../../../shared/schema.ts';
import { encodeLookPatch, type LookPatch, type RegionEdit } from '../../../web/src/viewer/edits/model.ts';
import { clamp, round3, yawFacing } from '../geometry.ts';
import type { SceneContext } from './context.ts';

export const REGEN = { minutes: 5, credits: 1580 } as const;

// ---------------------------------------------------------------------------------------------
// Draft schema
// ---------------------------------------------------------------------------------------------

const Point = z.object({ x: z.number(), y: z.number(), z: z.number() });
export type Point = z.infer<typeof Point>;

export const LOOK_NUMERIC = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'shadows',
  'highlights',
  'lutStrength',
  'vignette',
  'grain',
  'bloom',
  'fogDensity',
  'skyTintStrength',
  'focusDistance',
  'fStop',
  'ambient',
] as const;
export type LookNumeric = (typeof LOOK_NUMERIC)[number];

export const Draft = z.object({
  scope: EditScope.describe('the cheapest scope that satisfies the prompt'),
  summary: z
    .string()
    .describe('one or two sentences: what will change and what will not ("Recolour the left pillow red (one region). Nothing else changes.")'),
  question: z.string().describe('scope "clarify": the question to ask the director; otherwise ""'),
  look: z.object({
    name: z.string().describe('a short look name when the overall mood changes ("Night", "Warm dusk"), else ""'),
    set: z
      .array(z.object({ param: z.enum(LOOK_NUMERIC), value: z.number() }))
      .describe('new absolute values of the look parameters that change'),
    colors: z.array(z.object({ param: z.enum(['fogColor', 'skyTintColor']), hex: z.string() })),
    lut: z.enum([...LutPreset.options, 'unchanged']),
    depthOfField: z.enum(['unchanged', 'on']),
    addLights: z.array(
      z.object({
        name: z.string(),
        kind: LightKind,
        position: Point,
        target: Point.describe('spot/sun aim point (any point for point lights)'),
        color: z.string().describe('css hex'),
        intensity: z.number().describe('0-20, 1 = normal'),
        radius: z.number().describe('falloff radius in metres (point/spot)'),
        coneDeg: z.number().describe('spot cone in degrees'),
      }),
    ),
  }),
  transforms: z.array(
    z.object({
      targetType: z.enum(['actor', 'prop', 'light', 'camera']),
      targetId: z.string().describe('id from the scene description'),
      move: z.enum(['none', 'to', 'by']),
      point: Point.describe('move "to": the new position (world metres); "by": the offset in metres; else zeros'),
      turn: z.enum(['none', 'yaw', 'face']),
      yawDeg: z.number().describe('turn "yaw": new yaw in degrees (0 faces -Z, 180 faces the source camera)'),
      facePoint: Point.describe('turn "face": the point to face'),
      scale: z.number().describe('uniform scale relative to now; 1 = unchanged'),
    }),
  ),
  props: z.array(
    z.object({
      action: z.enum(['add', 'remove']),
      elementId: z.string().describe('remove: the prop id; add: ""'),
      kind: DynamicElementKind,
      label: z.string().describe('add: short description, e.g. "a blue bicycle leaning on the shelter"'),
      path: z
        .array(Point)
        .describe('add: one point = parked there; two points = parked at the first facing the second; more = it moves along them'),
      moving: z.boolean().describe('add: true when it drives/walks/flies along the path'),
      speed: z.number().describe('metres per second when moving'),
      scale: z.number().describe('1 = normal size'),
    }),
  ),
  regions: z.array(
    z.object({
      label: z.string().describe('the object as the director names it ("bus shelter ad panel")'),
      colorMode: z.enum(['none', 'hue', 'multiply', 'set']),
      colorHex: z.string().describe('target colour, css hex ("" for none)'),
      strength: z.number().describe('0-1 colour strength'),
      hide: z.boolean().describe('remove the object (opacity 0)'),
      moveBy: Point.describe('move the object by this many metres (world frame); zeros = no move'),
      scale: z.number().describe('grow/shrink about its centre; 1 = unchanged'),
    }),
  ),
  regen: z.object({
    environmental: z
      .boolean()
      .describe('true when the change is the sky, weather, season, time of day or the materials of the whole place (an edit of the world panorama can make it)'),
    imageEdit: z
      .string()
      .describe('scope world-regen: an image-edit instruction for the world panorama describing ONLY the environmental change; else ""'),
    worldPrompt: z
      .string()
      .describe('scope world-regen: the complete new world prompt (the current one with the change, environment only); else ""'),
  }),
});
export type Draft = z.infer<typeof Draft>;

export const emptyDraft = (scope: Draft['scope'] = 'clarify'): Draft => ({
  scope,
  summary: '',
  question: '',
  look: { name: '', set: [], colors: [], lut: 'unchanged', depthOfField: 'unchanged', addLights: [] },
  transforms: [],
  props: [],
  regions: [],
  regen: { environmental: false, imageEdit: '', worldPrompt: '' },
});

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/** The director's viewport selection (shared/api.ts reprompt body). */
export interface Selection {
  point?: Vec3;
  region?: { center: Vec3; size: Vec3; shape: 'sphere' | 'box' };
}

/** The current view (shared/api.ts reprompt body): jpeg base64 + the camera that took it. */
export interface ViewInfo {
  image: string;
  position: Vec3;
  quaternion: Quat;
  fovDeg: number;
  aspect: number;
}

/** A planner target: where the named object is in the view image (normalised, origin top-left). */
export interface TargetBox {
  opId: string;
  label: string;
  box: { x: number; y: number; w: number; h: number };
  confidence: number;
}

// ---------------------------------------------------------------------------------------------
// Draft → EditPlan
// ---------------------------------------------------------------------------------------------

const v3 = (p: Point): Vec3 => [round3(p.x), round3(p.y), round3(p.z)];
const isZero = (p: Point) => Math.hypot(p.x, p.y, p.z) < 1e-4;
const HEX = /^#[0-9a-f]{6}$/i;
const hex = (s: string, fallback: string) => {
  const t = s.trim();
  if (HEX.test(t)) return t.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${[...t.slice(1)].map((c) => c + c).join('')}`.toLowerCase();
  return fallback;
};

const RANGES: Record<LookNumeric, [number, number]> = {
  exposure: [-3, 3],
  contrast: [0.5, 2],
  saturation: [0, 2],
  temperature: [-1, 1],
  tint: [-1, 1],
  shadows: [-1, 1],
  highlights: [-1, 1],
  lutStrength: [0, 1],
  vignette: [0, 1],
  grain: [0, 1],
  bloom: [0, 1],
  fogDensity: [0, 1],
  skyTintStrength: [0, 1],
  focusDistance: [0.1, 200],
  fStop: [0.95, 22],
  ambient: [0, 1],
};

const DEFAULT_SPEED: Record<DynamicElement['kind'], number> = {
  car: 8,
  bus: 6,
  bicycle: 5,
  bird: 6,
  pedestrian: 1.4,
  generic: 3,
};

export interface FinalizeOptions {
  prompt: string;
  scene: SceneContext;
  selection?: Selection;
  /** Prefix for new op ids (random by default; tests pin it). */
  idPrefix?: string;
}

export interface Finalized {
  plan: EditPlan;
  notes: string[];
}

/** Priority when ops of several kinds come back: the most specific scope names the plan. */
const SCOPE_ORDER: EditPlan['scope'][] = ['splat-region', 'prop', 'transform', 'look'];
const opScope = (op: SceneEdit): EditPlan['scope'] =>
  op.kind === 'splat-region' ? 'splat-region' : op.kind === 'look' ? 'look' : op.kind === 'transform' ? 'transform' : 'prop';

/** What a regeneration keeps and drops, from the scene's current edits. */
export function regenKeepsDrops(scene: SceneContext): { keeps: string[]; drops: string[] } {
  const enabled = scene.edits.edits.filter((e) => e.enabled);
  const regions = enabled.filter((e) => e.kind === 'splat-region').length;
  const keeps = ['actors', 'look', 'props'];
  if (enabled.some((e) => e.kind === 'transform')) keeps.push('moves');
  return { keeps, drops: regions ? [`${regions} region edit${regions > 1 ? 's' : ''}`] : [] };
}

/**
 * Validates a draft against the scene and the scope rules:
 * - clarify and world-regen carry no ops; world-regen gets method / cost / keeps / drops;
 *   pano-inpaint only when the world's panorama is available and the change is environmental;
 * - every op must point at something that exists (unknown actors/props are dropped with a note);
 * - a splat-region op without a 3D target (no selection) is returned with `needsTarget` — the
 *   region is never guessed;
 * - the scope names the ops that survive; none left → clarify.
 */
export function draftToPlan(draft: Draft, o: FinalizeOptions): Finalized {
  const notes: string[] = [];
  const scene = o.scene;
  const prefix = o.idPrefix ?? randomBytes(3).toString('hex');
  let n = 0;
  const newId = (kind: string) => `${kind}-${prefix}-${++n}`;
  const summary = draft.summary.trim();

  if (draft.scope === 'clarify') {
    return {
      plan: EditPlan.parse({
        scope: 'clarify',
        summary: summary || 'Not sure what to change.',
        question: draft.question.trim() || 'Which object do you mean? Click it in the viewport or name it.',
      }),
      notes,
    };
  }

  if (draft.scope === 'world-regen') {
    const pano = !!scene.world.panoUrl && draft.regen.environmental && !!draft.regen.imageEdit.trim();
    const prompt = (pano ? draft.regen.imageEdit : draft.regen.worldPrompt).trim() || draft.regen.worldPrompt.trim();
    if (!prompt) {
      notes.push('world-regen without a prompt: asking instead');
      return {
        plan: EditPlan.parse({
          scope: 'clarify',
          summary: summary || 'That needs a new world, but the change is unclear.',
          question: 'What should the new world look like?',
        }),
        notes,
      };
    }
    const { keeps, drops } = regenKeepsDrops(scene);
    return {
      plan: EditPlan.parse({
        scope: 'world-regen',
        summary: summary || `Regenerate the world: ${prompt}`,
        regen: {
          method: pano ? 'pano-inpaint' : 'text',
          prompt: prompt.slice(0, 2000),
          estimatedMinutes: REGEN.minutes,
          estimatedCredits: REGEN.credits,
          keeps,
          drops,
        },
      }),
      notes,
    };
  }

  const ops: SceneEdit[] = [];
  const needsTarget: EditPlan['needsTarget'] = [];

  // ---- look
  const lookOp = lookFromDraft(draft.look, scene.look, newId, notes);
  if (lookOp) ops.push(lookOp);

  // ---- transforms
  for (const t of draft.transforms) {
    const op = transformFromDraft(t, scene, newId, notes);
    if (op) ops.push(op);
  }

  // ---- props
  for (const p of draft.props) {
    const op = propFromDraft(p, scene, o.selection, newId, notes);
    if (op) ops.push(op);
  }

  // ---- regions
  let selectionUsed = false;
  for (const r of draft.regions) {
    const colour = r.colorMode !== 'none' && HEX.test(hex(r.colorHex, ''));
    const moves = !isZero(r.moveBy);
    const scales = Math.abs(r.scale - 1) > 0.01 && r.scale > 0;
    if (!colour && !r.hide && !moves && !scales) {
      notes.push(`region "${r.label}": nothing to change; dropped`);
      continue;
    }
    const id = newId('region');
    const sel = !selectionUsed ? o.selection : undefined;
    let place: Pick<RegionEdit, 'shape' | 'center' | 'size'>;
    if (sel?.region) {
      place = { shape: sel.region.shape, center: sel.region.center, size: sel.region.size };
      selectionUsed = true;
    } else if (sel?.point) {
      place = { shape: 'sphere', center: sel.point, size: [0.4, 0.4, 0.4] };
      selectionUsed = true;
    } else {
      // placeholder until the director (or a vision target) places it: never applied like this
      place = { shape: 'sphere', center: [0, 0, 0], size: [0.4, 0.4, 0.4] };
      needsTarget.push({ opId: id, label: r.label.trim() || 'the object' });
    }
    ops.push(
      SceneEdit.parse({
        kind: 'splat-region',
        id,
        label: r.label.trim().slice(0, 80) || 'region',
        ...place,
        softEdge: 0.15,
        ...(colour
          ? { color: { mode: r.colorMode, value: hex(r.colorHex, '#ffffff'), strength: clamp(r.strength || 1, 0, 1) } }
          : {}),
        ...(r.hide ? { opacity: 0 } : {}),
        ...(moves ? { displace: v3(r.moveBy) } : {}),
        ...(scales ? { scale: clamp(r.scale, 0.2, 4) } : {}),
      }),
    );
  }

  if (!ops.length) {
    return {
      plan: EditPlan.parse({
        scope: 'clarify',
        summary: summary || 'Nothing in the prompt matched this scene.',
        question:
          draft.question.trim() ||
          `I could not find what to change for "${o.prompt.slice(0, 80)}". Name the actor, prop or object, or click it.`,
      }),
      notes,
    };
  }
  const scopes = new Set(ops.map(opScope));
  const scope = SCOPE_ORDER.find((s) => scopes.has(s))!;
  if (scope !== draft.scope) notes.push(`scope ${draft.scope} → ${scope} (from the ops that survived)`);
  return { plan: EditPlan.parse({ scope, summary: summary || describeOps(ops), ops, needsTarget }), notes };
}

function lookFromDraft(
  l: Draft['look'],
  current: Look,
  newId: (k: string) => string,
  notes: string[],
): SceneEdit | null {
  const patch: LookPatch = {};
  const fog = { ...current.fog };
  const sky = { ...current.skyTint };
  const dof = { ...current.dof };
  let fogSet = false;
  let skySet = false;
  let dofSet = false;
  for (const { param, value } of l.set) {
    if (!Number.isFinite(value)) continue;
    const [lo, hi] = RANGES[param];
    const v = round3(clamp(value, lo, hi));
    if (param === 'fogDensity') [fog.density, fogSet] = [v, true];
    else if (param === 'skyTintStrength') [sky.strength, skySet] = [v, true];
    else if (param === 'focusDistance') [dof.focusDistance, dofSet] = [v, true];
    else if (param === 'fStop') [dof.fStop, dofSet] = [v, true];
    else (patch as Record<string, number>)[param] = v;
  }
  for (const c of l.colors) {
    const h = hex(c.hex, '');
    if (!h) continue;
    if (c.param === 'fogColor') [fog.color, fogSet] = [h, true];
    else [sky.color, skySet] = [h, true];
  }
  if (l.depthOfField === 'on') [dof.enabled, dofSet] = [true, true];
  if (fogSet) patch.fog = fog;
  if (skySet) patch.skyTint = sky;
  if (dofSet) patch.dof = dof;
  if (l.lut !== 'unchanged') patch.lut = l.lut;
  if (l.name.trim()) patch.name = l.name.trim().slice(0, 40);
  const lights: Light[] = [];
  for (const d of l.addLights) {
    const parsed = Light.safeParse({
      id: newId('light'),
      name: d.name.trim().slice(0, 40) || 'Light',
      kind: d.kind,
      position: v3(d.position),
      ...(d.kind === 'point' ? {} : { target: v3(d.target) }),
      color: hex(d.color, '#ffffff'),
      intensity: clamp(d.intensity || 1, 0, 20),
      radius: d.radius > 0 ? Math.min(d.radius, 100) : 6,
      coneDeg: clamp(d.coneDeg || 45, 5, 120),
      enabled: true,
    });
    if (parsed.success) lights.push(parsed.data);
    else notes.push(`light "${d.name}" invalid; dropped`);
  }
  if (lights.length) patch.lights = lights;
  if (!Object.keys(patch).length) return null;
  return SceneEdit.parse({ kind: 'look', id: newId('look'), patch: encodeLookPatch(patch) });
}

function findActor(scene: SceneContext, id: string) {
  const k = id.trim().toLowerCase();
  return scene.actors.find((a) => a.id === k || a.name.toLowerCase() === k);
}

function findProp(scene: SceneContext, id: string, kind?: string) {
  const k = id.trim().toLowerCase();
  return (
    scene.props.find((p) => p.id.toLowerCase() === k) ??
    scene.props.find((p) => p.kind === k || (kind && p.kind === kind && !k)) ??
    (kind ? scene.props.find((p) => p.kind === kind) : undefined)
  );
}

function transformFromDraft(
  t: Draft['transforms'][number],
  scene: SceneContext,
  newId: (k: string) => string,
  notes: string[],
): SceneEdit | null {
  let current: { position: Vec3; yaw: number; scale: number; floor: boolean } | null = null;
  let id = t.targetId;
  if (t.targetType === 'actor') {
    const a = findActor(scene, t.targetId);
    if (a) [current, id] = [{ position: a.position, yaw: a.yaw, scale: a.scale, floor: true }, a.id];
  } else if (t.targetType === 'prop') {
    const p = findProp(scene, t.targetId);
    if (p) [current, id] = [{ position: p.position, yaw: 0, scale: p.scale, floor: true }, p.id];
  } else if (t.targetType === 'light') {
    // lights live in the Look: a light move is a look patch that upserts the moved light
    const l = scene.lights.find((x) => x.id === t.targetId || x.name.toLowerCase() === t.targetId.toLowerCase());
    if (!l) {
      notes.push(`light "${t.targetId}" is not in this scene; dropped`);
      return null;
    }
    const position: Vec3 | undefined =
      t.move === 'to' ? v3(t.point) : t.move === 'by' && !isZero(t.point) ? [round3(l.position[0] + t.point.x), round3(l.position[1] + t.point.y), round3(l.position[2] + t.point.z)] : undefined;
    const target = t.turn === 'face' ? v3(t.facePoint) : undefined;
    const intensity = t.scale > 0 && Math.abs(t.scale - 1) > 0.01 ? round3(clamp(l.intensity * t.scale, 0, 20)) : undefined;
    if (!position && !target && intensity === undefined) {
      notes.push(`light ${l.id}: no change; dropped`);
      return null;
    }
    const moved = { ...l, ...(position ? { position } : {}), ...(target ? { target } : {}), ...(intensity !== undefined ? { intensity } : {}) };
    return SceneEdit.parse({ kind: 'look', id: newId('look'), patch: { lights: [moved] } });
  } else {
    notes.push('cameras live on the laptop: drag or re-drop them there');
    return null;
  }
  if (!current) {
    notes.push(`${t.targetType} "${t.targetId}" is not in this scene; dropped`);
    return null;
  }
  let position: Vec3 | undefined;
  if (t.move === 'to') position = v3(t.point);
  else if (t.move === 'by' && !isZero(t.point))
    position = [round3(current.position[0] + t.point.x), round3(current.position[1] + t.point.y), round3(current.position[2] + t.point.z)];
  if (position && current.floor) position[1] = round3(Math.max(0, position[1]));
  let yaw: number | undefined;
  if (t.turn === 'yaw' && Number.isFinite(t.yawDeg)) yaw = round3((t.yawDeg * Math.PI) / 180);
  else if (t.turn === 'face') yaw = round3(yawFacing(position ?? current.position, v3(t.facePoint)));
  const scale = t.scale > 0 && Math.abs(t.scale - 1) > 0.01 ? round3(clamp(current.scale * t.scale, 0.1, 10)) : undefined;
  if (!position && yaw === undefined && scale === undefined) {
    notes.push(`${t.targetType} ${id}: no change; dropped`);
    return null;
  }
  return SceneEdit.parse({
    kind: 'transform',
    id: newId('move'),
    target: { type: t.targetType, id },
    ...(position ? { position } : {}),
    ...(yaw !== undefined ? { yaw } : {}),
    ...(scale !== undefined ? { scale } : {}),
  });
}

function propFromDraft(
  p: Draft['props'][number],
  scene: SceneContext,
  selection: Selection | undefined,
  newId: (k: string) => string,
  notes: string[],
): SceneEdit | null {
  if (p.action === 'remove') {
    const found = findProp(scene, p.elementId, p.kind);
    if (!found) {
      notes.push(`no prop "${p.elementId || p.kind}" to remove`);
      return null;
    }
    return SceneEdit.parse({ kind: 'prop-remove', id: newId('unprop'), elementId: found.id });
  }
  let path = p.path.map(v3).map((q) => [q[0], Math.max(0, q[1]), q[2]] as Vec3);
  // a click selection places a parked prop exactly where the director pointed
  if (!p.moving && selection?.point) {
    const at = selection.point;
    const dir = path.length >= 2 ? [path[1]![0] - path[0]![0], path[1]![2] - path[0]![2]] : [0, 1];
    path = [[round3(at[0]), Math.max(0, round3(at[1])), round3(at[2])]];
    path.push([round3(at[0] + dir[0]! * 0.01), path[0]![1], round3(at[2] + dir[1]! * 0.01)]);
  }
  if (!path.length) path = [[0, 0, -3]];
  if (!p.moving) {
    // parked: two points 5 cm apart (the viewer keeps paths under 10 cm still), facing the second
    const a = path[0]!;
    const b = path[1] ?? [a[0], a[1], a[2] + 1];
    const d = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    path = [a, [round3(a[0] + ((b[0] - a[0]) / d) * 0.05), a[1], round3(a[2] + ((b[2] - a[2]) / d) * 0.05)]];
  } else if (path.length < 2) {
    notes.push(`moving ${p.kind} needs a path; parked instead`);
    const a = path[0]!;
    path = [a, [a[0], a[1], round3(a[2] + 0.05)]];
  }
  const element = {
    id: newId(`prop-${p.kind}`),
    kind: p.kind,
    label: p.label.trim().slice(0, 80) || p.kind,
    path,
    speed: p.moving ? (p.speed > 0 ? Math.min(p.speed, 60) : DEFAULT_SPEED[p.kind]) : 0.01,
    loop: true,
    pauseSeconds: p.moving ? 2 : 0,
    scale: p.scale > 0 ? clamp(p.scale, 0.2, 5) : 1,
  };
  return SceneEdit.parse({ kind: 'prop-add', id: newId('prop'), element });
}

/** Fallback summary when the planner wrote none. */
export function describeOps(ops: SceneEdit[]): string {
  const parts = ops.map((op) => {
    switch (op.kind) {
      case 'look':
        return 'adjust the look';
      case 'transform':
        return `move ${op.target.id}`;
      case 'prop-add':
        return `add ${op.element.label}`;
      case 'prop-remove':
        return `remove ${op.elementId}`;
      case 'splat-region':
        return `edit the ${op.label}`;
    }
  });
  const s = parts.join(', ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}. Nothing else changes.`;
}
