// Shared data contracts between the pipeline (server), the laptop director and the phone camera.
// Owned by the lead; work packages extend by proposal, not by unilateral edit.
import { z } from 'zod';

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3>;

/** Quaternion as [x, y, z, w] (three.js order). */
export const Quat = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Quat = z.infer<typeof Quat>;

// ---------------------------------------------------------------------------
// Screenplay → ScenePlan (output of server/pipeline/screenplay.ts)
// ---------------------------------------------------------------------------

export const Character = z.object({
  id: z.string(), // slug, stable across scenes, e.g. "maya"
  name: z.string(), // as written in the screenplay, e.g. "MAYA"
  /** Physical description for the reference image; written by the LLM if the script is silent. */
  description: z.string(),
  /**
   * Standing height in metres, read from the description by the planner (a tall man 1.85, a
   * child 1.3); absent = 1.7. The actor pipeline scales every body kind to it.
   */
  heightMeters: z.number().min(0.9).max(2.3).optional(),
  voice: z.object({
    /** Provider voice id, e.g. OpenAI "alloy" / "onyx"; the pipeline picks one per character. */
    id: z.string(),
    gender: z.enum(['female', 'male', 'neutral']).default('neutral'),
  }),
});
export type Character = z.infer<typeof Character>;

export const DialogueLine = z.object({
  id: z.string(), // "s1-l3"
  characterId: z.string(),
  text: z.string(),
  parenthetical: z.string().optional(),
  /** Order within the scene; also the index into the take playlist. */
  order: z.number().int().nonnegative(),
});
export type DialogueLine = z.infer<typeof DialogueLine>;

export const Blocking = z.object({
  characterId: z.string(),
  /** Meters in the world frame (origin = Marble source camera, y = floor). */
  position: Vec3,
  /**
   * Yaw in radians applied as three.js `rotation.y` to a model whose front is -Z.
   * 0 = facing -Z (away from the Marble source camera), π = facing the camera at the origin.
   */
  yaw: z.number(),
  /** 'standing' | 'sitting' | 'walking' — picks the motion loop. */
  pose: z.enum(['standing', 'sitting', 'walking']).default('standing'),
  /**
   * Why this spot, when the staging step (server/pipeline/staging.ts) moved the mark onto the
   * visible set: "on the sidewalk by the shelter bench". Absent for the planner's blind guess.
   */
  note: z.string().optional(),
});
export type Blocking = z.infer<typeof Blocking>;

export const DynamicElementKind = z.enum(['car', 'bus', 'bicycle', 'bird', 'pedestrian', 'generic']);
export const DynamicElement = z.object({
  id: z.string(),
  kind: DynamicElementKind,
  label: z.string(), // "a red sedan drives past"
  /** Looped path in world meters; the prop faces its direction of travel. */
  path: z.array(Vec3).min(2),
  /** Meters per second. */
  speed: z.number().positive(),
  loop: z.boolean().default(true),
  /** Seconds of pause at the end of the path before looping. */
  pauseSeconds: z.number().nonnegative().default(2),
  scale: z.number().positive().default(1),
});
export type DynamicElement = z.infer<typeof DynamicElement>;

export const SuggestedShot = z.object({
  name: z.string(), // "Two-shot over Maya's shoulder"
  position: Vec3,
  quaternion: Quat,
  fovDeg: z.number().min(10).max(120),
});
export type SuggestedShot = z.infer<typeof SuggestedShot>;

export const ScenePlan = z.object({
  index: z.number().int().nonnegative(),
  slug: z.string(), // "int-kitchen-night"
  heading: z.string(), // "INT. KITCHEN - NIGHT"
  /** Full action/description text from the script for this scene. */
  action: z.string(),
  /** Marble text prompt describing the environment only (no people). */
  worldPrompt: z.string(),
  timeOfDay: z.enum(['dawn', 'day', 'dusk', 'night']).default('day'),
  interior: z.boolean(),
  characterIds: z.array(z.string()),
  dialogue: z.array(DialogueLine),
  blocking: z.array(Blocking),
  dynamics: z.array(DynamicElement),
  shots: z.array(SuggestedShot).default([]),
});
export type ScenePlan = z.infer<typeof ScenePlan>;

export const ScreenplayPlan = z.object({
  title: z.string(),
  characters: z.array(Character),
  scenes: z.array(ScenePlan).min(1),
});
export type ScreenplayPlan = z.infer<typeof ScreenplayPlan>;

// ---------------------------------------------------------------------------
// Built assets → SceneManifest (what the browsers load)
//
// Every asset path below (spz, glb, sequenceDir, audio url) is relative to the PROJECT root,
// i.e. resolved against `/projects/<projectId>/`, never against the scene folder. Absolute
// `/…` paths are passed through unchanged.
// ---------------------------------------------------------------------------

export const WorldAsset = z.object({
  provider: z.enum(['marble', 'mock']),
  worldId: z.string().optional(),
  /** URLs relative to the project root served at /projects/<id>/ . */
  spz: z.object({ k500: z.string(), full: z.string().optional(), k100: z.string().optional() }),
  colliderGlb: z.string().optional(),
  thumbnail: z.string().optional(),
  /** Provider caption of the generated world, when available. */
  caption: z.string().optional(),
  /** Marble semantics; see docs/PLAN.md "Coordinate conventions". */
  metricScaleFactor: z.number().positive(),
  groundPlaneOffset: z.number(),
  /** true when the SPZ is OpenCV (Y down) and needs the 180° X flip. Marble: true. */
  opencvFrame: z.boolean().default(true),
  /**
   * Measured correction applied on top of metricScaleFactor (effective scale = factor × metric).
   * Written by the scale calibration step from real-world references (door, counter, ceiling,
   * a 1.7 m human); absent or 1 means Marble's estimate was kept.
   */
  scaleCalibration: z
    .object({
      factor: z.number().positive(),
      method: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
      /** Human-readable measurements, e.g. "door 2.04 m, counter 0.91 m, ceiling 2.6 m". */
      evidence: z.string(),
      /** Short HUD text, e.g. "door 2.04 m" or "unverified". */
      headline: z.string().optional(),
    })
    .optional(),
  /**
   * Measured height of the real ground above Marble's declared floor plane, in meters (Marble's
   * outdoor floors sit 0.1–0.2 m above the splats' ground). The viewer lowers y = 0 by this much so
   * actors stand on the visible ground. Absent = 0.
   */
  floorOffsetMeters: z.number().optional(),
  /**
   * Ground height field measured from the splats (shared/ground.ts, previz.ground-field/1): the
   * visible ground's height per xz cell, so each actor's feet land on the ground at ITS spot
   * (curbs, slopes, steps) instead of at the one median floorOffsetMeters encodes. `file` is a
   * JSON GroundField, project-root-relative like every other asset path. Absent = flat floor.
   */
  ground: z
    .object({
      file: z.string(),
      /** cell size, m */
      cell: z.number().positive(),
      /** cells with ground data / cells in the field */
      covered: z.number().int().nonnegative(),
      cells: z.number().int().positive(),
    })
    .optional(),
});
export type WorldAsset = z.infer<typeof WorldAsset>;

/**
 * Set on assets produced by an offline/free fallback (mannequin, beep audio) while real keys were
 * present, so the pipeline knows a retry may upgrade them and never caches them as final.
 */
const Fallback = { fallback: z.boolean().optional() };

/**
 * Build quality of an actor. `standard` = LHM-500M (the default, ~3 min GPU); `high` = LHM-1B plus
 * a fine-tune against the reference image (sharper face and clothing), about 5 minutes per actor,
 * triggered from the laptop UI per character.
 */
export const ActorDetail = z.enum(['standard', 'high']);
export type ActorDetail = z.infer<typeof ActorDetail>;
const Detail = { detail: ActorDetail.optional() };

export const ActorAsset = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('splat-sequence'),
    ...Fallback,
    ...Detail,
    characterId: z.string(),
    /** Directory containing sequence.json (previz.actor-sequence/1) + PLY frames. */
    sequenceDir: z.string(),
    fps: z.number().positive(),
    /** Height of the avatar in its native units; browser scales so it stands `heightMeters` tall. */
    nativeHeight: z.number().positive(),
    heightMeters: z.number().positive().default(1.7),
  }),
  z.object({
    kind: z.literal('glb-humanoid'),
    ...Fallback,
    characterId: z.string(),
    /** GLB path, or the marker `procedural:mannequin` for the built-in browser mannequin. */
    glb: z.string(),
    /** Animation clip names inside the GLB. */
    clips: z.object({ idle: z.string(), talk: z.string(), walk: z.string().optional() }),
    tint: z.string().optional(), // css hex, distinguishes fallback actors
    /** Standing height the body is scaled to (Character.heightMeters); absent = 1.7. */
    heightMeters: z.number().positive().optional(),
  }),
]);
export type ActorAsset = z.infer<typeof ActorAsset>;

export const LineAudio = z.object({
  ...Fallback,
  lineId: z.string(),
  url: z.string(), // mp3/wav relative to project root
  durationSeconds: z.number().nonnegative(),
});
export type LineAudio = z.infer<typeof LineAudio>;

export const SceneManifest = z.object({
  version: z.literal(1),
  projectId: z.string(),
  plan: ScenePlan,
  characters: z.array(Character),
  world: WorldAsset,
  actors: z.array(ActorAsset),
  audio: z.array(LineAudio),
  /** Default director camera when the scene opens. */
  startCamera: z.object({ position: Vec3, quaternion: Quat, fovDeg: z.number() }),
});
export type SceneManifest = z.infer<typeof SceneManifest>;

// ---------------------------------------------------------------------------
// Job status (pipeline progress shown on the laptop)
// ---------------------------------------------------------------------------

export const StageName = z.enum(['parse', 'world', 'actors', 'tts', 'manifest']);
export const StageStatus = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
export const SceneJob = z.object({
  sceneIndex: z.number().int(),
  slug: z.string(),
  heading: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  stages: z.record(StageName, z.object({ status: StageStatus, note: z.string().optional() })),
  manifestUrl: z.string().optional(),
});
/** Per-character build state shown in the laptop's project panel (rebuilds are per character). */
export const ActorBuildStatus = z.object({
  characterId: z.string(),
  name: z.string(),
  /** Detail level of the build currently referenced by the manifests. */
  detail: ActorDetail,
  kind: z.enum(['splat-sequence', 'glb-humanoid']).optional(),
  fallback: z.boolean().optional(),
  /** A rebuild in progress (or its outcome) at the requested detail. */
  rebuild: z
    .object({ detail: ActorDetail, status: StageStatus, note: z.string().optional(), startedAt: z.string().optional() })
    .optional(),
});
export type ActorBuildStatus = z.infer<typeof ActorBuildStatus>;

export const ProjectStatus = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  mock: z.boolean(),
  parse: z.object({ status: StageStatus, note: z.string().optional() }),
  scenes: z.array(SceneJob),
  actors: z.array(ActorBuildStatus).optional(),
});
export type ProjectStatus = z.infer<typeof ProjectStatus>;
