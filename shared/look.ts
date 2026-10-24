// Look development + scoped scene edits. Owned by the lead; extend by proposal.
// A Look and a list of SceneEdits live in `scene-<n>/edits.json` and are applied at render time
// on both laptop and phone — nothing here re-renders or re-generates anything by itself.
import { z } from 'zod';
import { DynamicElement, Vec3 } from './schema';

const unit = z.number().min(0).max(1);

export const LightKind = z.enum(['point', 'spot', 'sun']);
export const Light = z.object({
  id: z.string(),
  name: z.string(), // "Key", "Streetlamp"
  kind: LightKind,
  position: Vec3, // meters, world frame (sun: direction from this point to the origin)
  /** Spot/sun aim point; ignored for point lights. */
  target: Vec3.optional(),
  color: z.string().default('#ffffff'), // css hex
  intensity: z.number().min(0).max(20).default(1),
  /** Falloff radius in meters (point/spot). */
  radius: z.number().positive().default(6),
  /** Spot cone in degrees. */
  coneDeg: z.number().min(5).max(120).default(45),
  enabled: z.boolean().default(true),
});
export type Light = z.infer<typeof Light>;

export const LutPreset = z.enum(['neutral', 'teal-orange', 'noir', 'kodak', 'bleach', 'cool-night', 'golden']);

export const Look = z.object({
  name: z.string().default('Default'),
  exposure: z.number().min(-3).max(3).default(0), // stops
  contrast: z.number().min(0.5).max(2).default(1),
  saturation: z.number().min(0).max(2).default(1),
  temperature: z.number().min(-1).max(1).default(0), // − cool … + warm
  tint: z.number().min(-1).max(1).default(0), // − green … + magenta
  shadows: z.number().min(-1).max(1).default(0),
  highlights: z.number().min(-1).max(1).default(0),
  lut: LutPreset.default('neutral'),
  lutStrength: unit.default(1),
  vignette: unit.default(0),
  grain: unit.default(0),
  bloom: unit.default(0),
  fog: z.object({ color: z.string().default('#9aa3ad'), density: unit.default(0) }).prefault({}),
  /** Multiplies the colour of splats above the horizon band; the honest way to "tint the sky". */
  skyTint: z.object({ color: z.string().default('#ffffff'), strength: unit.default(0) }).prefault({}),
  dof: z
    .object({
      enabled: z.boolean().default(false),
      focusDistance: z.number().positive().default(3), // meters
      fStop: z.number().min(0.95).max(22).default(2.8),
    })
    .prefault({}),
  lights: z.array(Light).default([]),
  /** 0 = scene lighting untouched; 1 = only the Look's lights brighten the splats. */
  ambient: unit.default(1),
});
export type Look = z.infer<typeof Look>;
export const defaultLook = (): Look => Look.parse({});

// ---------------------------------------------------------------------------
// Scene edits
// ---------------------------------------------------------------------------

export const RegionShape = z.enum(['sphere', 'box']);
/** A non-destructive GPU edit of the splats inside a region (Spark SplatEdit). */
export const SplatRegionEdit = z.object({
  kind: z.literal('splat-region'),
  id: z.string(),
  label: z.string(), // "pillow on the left"
  shape: RegionShape,
  center: Vec3,
  /** Sphere radius, or box half-extents (x, y, z). */
  size: Vec3,
  yaw: z.number().default(0),
  softEdge: z.number().min(0).max(1).default(0.15),
  /** Colour op: multiply keeps shading, hue re-hues keeping luminance, set replaces. */
  color: z
    .object({ mode: z.enum(['multiply', 'hue', 'set']), value: z.string(), strength: unit.default(1) })
    .optional(),
  /** 0 hides the object. */
  opacity: unit.optional(),
  /** Move the splats by this vector (meters). */
  displace: Vec3.optional(),
  /** Uniform scale about the region centre (implemented as a displacement field). */
  scale: z.number().positive().optional(),
  enabled: z.boolean().default(true),
});

export const TransformEdit = z.object({
  kind: z.literal('transform'),
  id: z.string(),
  target: z.object({ type: z.enum(['actor', 'prop', 'light', 'camera']), id: z.string() }),
  position: Vec3.optional(),
  yaw: z.number().optional(),
  scale: z.number().positive().optional(),
  enabled: z.boolean().default(true),
});

export const PropEdit = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prop-add'), id: z.string(), element: DynamicElement, enabled: z.boolean().default(true) }),
  z.object({ kind: z.literal('prop-remove'), id: z.string(), elementId: z.string(), enabled: z.boolean().default(true) }),
]);

export const LookEdit = z.object({
  kind: z.literal('look'),
  id: z.string(),
  /** Partial Look merged in order of application. */
  patch: Look.partial(),
  enabled: z.boolean().default(true),
});

export const SceneEdit = z.discriminatedUnion('kind', [SplatRegionEdit, TransformEdit, LookEdit, ...PropEdit.options]);
export type SceneEdit = z.infer<typeof SceneEdit>;

// ---------------------------------------------------------------------------
// Re-prompt planning
// ---------------------------------------------------------------------------

export const EditScope = z.enum(['look', 'transform', 'prop', 'splat-region', 'world-regen', 'clarify']);

/** What the planner wants to do; `splat-region` ops may arrive with `needsTarget` set. */
export const EditPlan = z.object({
  scope: EditScope,
  summary: z.string(), // "Recolour the left pillow red (one region, nothing else changes)."
  ops: z.array(SceneEdit).default([]),
  /** Named objects the planner could not locate; the UI asks the director to click them. */
  needsTarget: z.array(z.object({ opId: z.string(), label: z.string() })).default([]),
  /** Present only for world-regen: what it costs and the new prompt; applied only after confirm. */
  regen: z
    .object({
      method: z.enum(['pano-inpaint', 'text']),
      prompt: z.string(),
      estimatedMinutes: z.number(),
      estimatedCredits: z.number(),
      keeps: z.array(z.string()), // "actors", "look", "props"
      drops: z.array(z.string()), // "2 region edits"
    })
    .optional(),
  /** For scope 'clarify': the question to ask. */
  question: z.string().optional(),
});
export type EditPlan = z.infer<typeof EditPlan>;

/** Persisted per scene at scene-<n>/edits.json. */
export const SceneEdits = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  look: Look,
  edits: z.array(SceneEdit),
  history: z
    .array(
      z.object({
        at: z.string(),
        prompt: z.string(),
        plan: EditPlan,
        appliedOpIds: z.array(z.string()),
      }),
    )
    .default([]),
});
export type SceneEdits = z.infer<typeof SceneEdits>;
export const emptySceneEdits = (): SceneEdits => ({ version: 1, revision: 0, look: defaultLook(), edits: [], history: [] });
