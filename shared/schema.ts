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

/**
 * Something an actor does at a moment of the scene (shared/beats.ts turns a blocking's beats into
 * where the actor is, which way it faces and whether it stands, sits or walks at any scene time).
 */
export const Beat = z.object({
  /** Scene clock seconds when the beat starts (a walk starts later if the previous one is not done). */
  t: z.number().nonnegative(),
  /** What happens, as written for a director: "crosses to the window", "sinks onto the bench". */
  action: z.string().max(200),
  /** Walk to this mark (metres, world frame; y is ignored, actors stay on the floor). */
  moveTo: Vec3.optional(),
  /** After the beat (on arrival, for a walk): stand or sit. Absent = read from `action`. */
  pose: z.enum(['standing', 'sitting']).optional(),
  /** After the beat: face this yaw (Blocking.yaw convention). Absent = keep / direction walked. */
  yaw: z.number().optional(),
  /**
   * A distinct body motion to perform on the spot, as a text-to-motion prompt ("A person slams
   * both palms down on a table in front of them."). Absent for walks, sits and plain turns.
   */
  gesture: z.string().max(240).optional(),
  /**
   * Motion clip played once from the beat's start (set by the pipeline from `gesture`): a clip of
   * the manifest's `motion` library (generated for this prompt) or of the actor's own library.
   */
  clip: z.string().optional(),
});
export type Beat = z.infer<typeof Beat>;

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
   * What the actor does over the scene, in time order. Absent or empty: the actor holds its mark
   * (a 'walking' pose then walks in to it, as before).
   */
  beats: z.array(Beat).max(24).optional(),
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
  /** Where the world came from: a prompt (default) or the director's scanned room (Marble video). */
  source: z.enum(['generated', 'room-scan']).optional(),
  /**
   * room-scan worlds: a rigid placement applied after the metric transform (turn about +Y by
   * `yaw`, then shift by x / z metres) so the scene frame is the scan's pose `offset` frame and
   * the generated room sits exactly over the real one (server/pipeline/room-world.ts).
   */
  roomAlign: z.object({ yaw: z.number(), x: z.number(), z: z.number() }).optional(),
  /**
   * The camera this world wants the scene to start from (a scanned room: the scan's Recentre
   * point at standing height, so a phone that restores the scan's frame walks the room 1:1).
   * Absent: the default start camera.
   */
  startCamera: z.object({ position: Vec3, quaternion: Quat, fovDeg: z.number() }).optional(),
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
  /**
   * The scene's generated gesture clips (previz.motion-library/1 JSON, project-relative), played
   * by beats whose `clip` names one of them. Absent: beats use the actors' own clips only.
   */
  motion: z.object({ library: z.string() }).optional(),
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
