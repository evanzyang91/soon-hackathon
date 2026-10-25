// Project store + in-process pipeline. Everything lives on disk under <dataDir>/<id>/ and every
// stage is idempotent, so a restart (or a retry) resumes from what is already there:
//
//   project.json            ProjectStatus (what the laptop polls)
//   input.json              { title? } as submitted
//   screenplay.fountain     the submitted text
//   plan.json               ScreenplayPlan (parse stage, once per project)
//   log.txt                 human-readable pipeline log
//   actors/<characterId>/   one actor per character, shared by every scene (actor.json caches it;
//                           live projects copy a matching actors-library avatar instead of Modal)
//   actors/<characterId>/high/  the "High detail" rebuild (LHM-1B + fine-tune), next to the
//                           standard build; actor.json points at whichever the manifests use
//   scene-<n>/world/        Marble outputs + marble-receipt.json + world-asset.json (or a copy of
//                           a matching world-library world: live projects only, no credits);
//                           scale-calibration.json once the world's scale has been measured
//   scene-<n>/audio/        one file per dialogue line; scene-<n>/audio.json caches LineAudio[]
//   scene-<n>/staging.json  StagingReport: the actors' marks staged on this world (staging.ts)
//   scene-<n>/manifest.json SceneManifest, written once world/actors/tts have all settled
//   scene-<n>/edits.json    look + edits (edits.ts); the manifest step writes the plan's look
//                           (look-seed.ts) when the scene has none yet, never over an existing one
//
// A new Marble world is scale-calibrated right after download (calibrate.ts: collider references +
// Claude vision with 1.70 m mannequins) and the result lands in world-asset.json as
// scaleCalibration, also in the world-library copy so reuse carries it. CALIBRATE=0 or
// `calibrate: false` turns it off; a failure never fails the world stage.
//
// Then the actors are staged on the set (staging.ts: Claude picks each character's mark on free
// ground seen from the start camera) into scene-<n>/staging.json, reused while the world and the
// scene's blocking/action/cast are unchanged; the manifest carries the staged blocking, plan.json
// keeps the planner's. Live Marble worlds with ANTHROPIC_API_KEY only; STAGING=0 or
// `stage: false` turns it off; a failure keeps the planner's blocking and never fails the stage.
//
// Actor rebuilds (rebuildActor, POST /api/projects/:id/actors/:characterId/rebuild) run one
// character in the background at a detail level, recorded in ProjectStatus.actors[].rebuild; the
// current build stays in the manifests until the new one is ready, then every scene manifest
// showing the character is rewritten to it. A failure changes nothing but the note.
//
// Director's photos (the project chat, shared/chat.ts): a character with Character.referenceImage is
// built from that photo (actors.ts) and never from the actors library; a scene with
// ScenePlan.worldReference is generated with the photo as Marble's image prompt and never from the
// world library. After the plan changed on a live project the chat calls rebuildActorFromPlan
// (actors/<id>/ set aside as prev-<k>/, rebuilt from the current character) and regenerateWorld
// (scene-<n>/world/ set aside as world.prev-<k>/, regenerated from the current prompt + photo
// through the scoped re-prompt regen machinery).
//
// Per scene, world / actors / tts run concurrently (Marble jobs capped at 3 across the server);
// manifest follows. Found models (models.ts) are looked up for the scene's background action as
// soon as its world stage is scheduled and joined in the manifest step (20 s budget from their
// start): each element that got one carries it as `model` in the manifest's plan.dynamics
// (plan.json keeps the plan as planned). FOUND_MODELS=0 / MOCK skip it (FOUND_MODELS=1 forces it).
// A failed stage is recorded with a note; the manifest is still written when the
// world succeeded. Asset URLs inside manifests are relative to the project root
// (/projects/<id>/), matching shared/api.ts.
import { randomBytes } from 'node:crypto';
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { api } from '../../shared/api.ts';
import {
  ActorAsset,
  LineAudio,
  ProjectStatus,
  SceneManifest,
  ScreenplayPlan,
  WorldAsset,
  type ActorBuildStatus,
  type ActorDetail,
  type Character,
  type DialogueLine,
  type ScenePlan,
  type VisualStyle,
} from '../../shared/schema.ts';
import { env, keyPresence } from '../env.ts';
import { copyLibraryActor, findLibraryActor } from './actor-library.ts';
import { actorDirFor, buildActor, heightFor, photoSha, withHeight } from './actors.ts';
import {
  calibrateWorld,
  previousCalibration,
  redecide,
  withGround,
  writeCalibration,
  type CalibrateOptions,
  type CalibrationReport,
} from './calibrate.ts';
import { storedGroundField, writeGroundField } from './calibrate-ground.ts';
import { parseFountain } from './fountain.ts';
import { editsStoreFor } from './edits.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { slugify } from './geometry.ts';
import { lookSeedFor, seedSceneLook, styleForPlan } from './look-seed.ts';
import { ASSET_FILE, generateWorld, promptKey, RECEIPT_FILE, type GenerateWorldOptions } from './marble.ts';
import { mockSetFromCaption, pickMockSet } from './mock-set.ts';
import { photoToPng, readPhoto } from './photo.ts';
import { dropRegionEdits, findGeneratedWorld, produceRegenWorld, type RegenSpec } from './reprompt/regen.ts';
import { parseScreenplay } from './screenplay.ts';
import {
  groundMarks,
  measureGroundAtMarks,
  readStaging,
  stageScene,
  stagedBlocking,
  stagingCurrent,
  writeStaging,
  type StageOptions,
  type StagingReport,
} from './staging.ts';
import { synthesizeLine } from './tts.ts';
import { copyLibraryWorld, findLibraryWorld } from './world-library.ts';
import { FoundModels } from './models.ts';
import type { AmendResult } from './chat/apply.ts';
import { planCardMessage } from './chat/plan-card.ts';
import { planDiff } from './chat/plan-diff.ts';
import { mergeReplan } from './chat/replan.ts';
import { ChatStore, newMessageId } from './chat/store.ts';
import { calibrationFactor } from '../../web/src/viewer/transform.ts';

export type StageName = 'parse' | 'world' | 'actors' | 'tts' | 'manifest';
type StageStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
type Stage = { status: StageStatus; note?: string };
type SceneJob = ProjectStatus['scenes'][number];
type SceneStage = Exclude<StageName, 'parse' | 'manifest'>;

export const START_CAMERA: SceneManifest['startCamera'] = {
  position: [0, 1.6, 0],
  quaternion: [0, 0, 0, 1],
  fovDeg: 50,
};

/** scene-<n>/world-regen.json: a regenerateWorld queued or running (resumed after a restart). */
export const WORLD_REGEN_FILE = 'world-regen.json';
/** actors/<id>/rebuild.json: a rebuildActorFromPlan in progress (stays put when the build moves aside). */
export const REBUILD_FILE = 'rebuild.json';

interface RebuildMarker {
  reason: 'plan';
  startedAt: string;
  /** 'prev-<k>' once the previous build has been moved aside ('' when there was none) */
  retired?: string;
  status?: 'done' | 'failed';
}

/** What a character's build is made from; a change while it builds rebuilds it once more. */
const buildInputs = (c: Character) => JSON.stringify([c.description, c.heightMeters ?? null, c.referenceImage ?? null]);

/** The asset with its files under `from` (a project-relative dir prefix) moved to `to`. */
function relocateActor(a: ActorAsset, from: string, to: string): ActorAsset {
  const move = (p: string) => (p.startsWith(from) ? to + p.slice(from.length) : p);
  return a.kind === 'splat-sequence' ? { ...a, sequenceDir: move(a.sequenceDir) } : { ...a, glb: move(a.glb) };
}

export interface PipelineDeps {
  parseScreenplay: (
    text: string,
    opts: { mock: boolean; log: (m: string) => void; title?: string },
  ) => Promise<ScreenplayPlan>;
  generateWorld: (opts: GenerateWorldOptions) => Promise<WorldAsset>;
  calibrateWorld: (worldDir: string, opts: CalibrateOptions) => Promise<CalibrationReport>;
  /** Actors' marks onto the set (staging.ts); throws when the world cannot be staged at all. */
  stageScene: (opts: StageOptions) => Promise<StagingReport>;
  buildActor: (opts: {
    character: Character;
    projectDir: string;
    sceneDir: string;
    mock: boolean;
    log: (m: string) => void;
    /** 'high' (rebuilds only): LHM-1B + fine-tune into actors/<id>/high/; throws on failure. */
    detail?: ActorDetail;
    /** The screenplay's style: a generated reference keeps the cast's wardrobe in its genre and era. */
    style?: VisualStyle;
  }) => Promise<ActorAsset>;
  synthesizeLine: (opts: {
    line: DialogueLine;
    character: Character;
    outDir: string;
    mock: boolean;
    log: (m: string) => void;
  }) => Promise<LineAudio>;
}

export interface StoreOptions {
  dataDir: string;
  /** Server-wide MOCK: new projects are mock projects; real projects are not resumed. */
  mock: boolean;
  marbleModel?: string;
  /**
   * Key presence (never values). Missing keys fall back to offline stages. Defaults to env.
   * `modal` / `tts` decide whether a cached `fallback: true` actor / line may be upgraded.
   */
  keys?: StoreKeys;
  deps?: Partial<PipelineDeps>;
  /**
   * Pre-generated worlds reused by live (non-MOCK) projects before calling Marble; null disables.
   * Default: env WORLD_LIBRARY_DIR or data/marble.
   */
  worldLibraryDir?: string | null;
  /**
   * Pre-built avatars (<dir>/<characterId>/sequence/) reused by live projects before Modal; null
   * disables. Default: env ACTORS_LIBRARY_DIR or data/actors-library.
   */
  actorsLibraryDir?: string | null;
  /**
   * Look up found models for background action (models.ts). Default env FOUND_MODELS: '1' on,
   * '0' off, unset = on unless the store is MOCK.
   */
  foundModels?: boolean;
  /** Where found models are downloaded (default env MODELS_LIBRARY_DIR or data/models-library). */
  modelsLibraryDir?: string;
  /** Per-scene budget for the found-model lookups, ms (default 20 s). */
  foundModelsBudgetMs?: number;
  /** Scale-calibrate new Marble worlds after download (default env CALIBRATE, on). */
  calibrate?: boolean;
  /** Include the Claude-vision half when the Anthropic key is set (default env CALIBRATE_VISION). */
  calibrateVision?: boolean;
  /** Stage the actors on live Marble worlds when the Anthropic key is set (default env STAGING). */
  stage?: boolean;
  maxWorldJobs?: number;
  maxActorJobs?: number;
  maxTtsJobs?: number;
  /** Mirror project log lines to the console (default true). */
  echo?: boolean;
}

export interface StoreKeys {
  anthropic: boolean;
  marble: boolean;
  modal?: boolean;
  tts?: boolean;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isProjectId = (id: string) => ID_RE.test(id);

class Semaphore {
  private waiters: (() => void)[] = [];
  constructor(private free: number) {}
  async use<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
    if (this.free > 0) this.free--;
    else {
      onWait?.();
      await new Promise<void>((r) => this.waiters.push(r));
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.free++;
    }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 400);
const settled = (s: Stage) => s.status !== 'pending' && s.status !== 'running';

/** "LEO" → "Leo", "MR. SMITH" → "Mr. Smith" (screenplay names are upper case). */
export const displayName = (name: string) =>
  name.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

/** 292_000 → "4m 52s". */
export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

/** ProjectStatus.actors entry for a character from its current actor asset. */
export function actorBuildStatus(
  character: Pick<Character, 'id' | 'name'>,
  asset: ActorAsset | undefined,
  rebuild?: ActorBuildStatus['rebuild'],
): ActorBuildStatus {
  return {
    characterId: character.id,
    name: character.name,
    detail: asset?.kind === 'splat-sequence' && asset.detail ? asset.detail : 'standard',
    ...(asset ? { kind: asset.kind } : {}),
    ...(asset?.fallback ? { fallback: true } : {}),
    ...(rebuild ? { rebuild } : {}),
  };
}

function initJob(scene: ScenePlan): SceneJob {
  return {
    sceneIndex: scene.index,
    slug: scene.slug,
    heading: scene.heading,
    stages: {
      parse: { status: 'done' },
      world: { status: 'pending' },
      actors: scene.characterIds.length
        ? { status: 'pending' }
        : { status: 'skipped', note: 'no characters' },
      tts: scene.dialogue.length
        ? { status: 'pending' }
        : { status: 'skipped', note: 'no dialogue' },
      manifest: { status: 'pending' },
    },
  };
}

/** A draft's scene job: the same stages, each waiting for generate(). */
function draftJob(scene: ScenePlan): SceneJob {
  const job = initJob(scene);
  for (const s of Object.values(job.stages))
    if (s.status === 'pending') s.note = 'waiting for generate';
  return job;
}

export class ProjectStore {
  readonly dataDir: string;
  private readonly mock: boolean;
  private readonly model: string;
  private readonly keys: StoreKeys;
  private readonly libraryDir: string | null;
  private readonly actorsLibraryDir: string | null;
  private readonly libraryActors = new Set<string>();
  private readonly deps: PipelineDeps;
  private readonly echo: boolean;
  private readonly calibrate: boolean;
  private readonly calibrateVision: boolean;
  private readonly stage: boolean;
  private readonly worldSem: Semaphore;
  private readonly actorSem: Semaphore;
  private readonly ttsSem: Semaphore;
  /** Found-model lookups per background-action label (models.ts), shared by every project. */
  private readonly found: FoundModels;

  private readonly statuses = new Map<string, ProjectStatus>();
  private readonly plans = new Map<string, ScreenplayPlan>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly actorBuilds = new Map<string, Promise<ActorAsset | undefined>>();
  private readonly actorErrors = new Map<string, string>();
  private readonly worldRetryFailed = new Set<string>();
  /** `${id}:${sceneIndex}` of regenerateWorld calls queued or running in this process */
  private readonly worldRegens = new Set<string>();
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  /** <project>/chat.json (server/pipeline/chat/); each write is mirrored into chatRevision. */
  readonly chat: ChatStore;
  private readonly planLocks = new Map<string, Promise<unknown>>();

  constructor(o: StoreOptions) {
    this.dataDir = resolve(o.dataDir);
    this.mock = o.mock;
    this.model = o.marbleModel ?? env.marbleModel;
    this.keys = o.keys ?? keyPresence();
    this.libraryDir = o.worldLibraryDir === undefined ? env.worldLibraryDir : o.worldLibraryDir;
    this.actorsLibraryDir =
      o.actorsLibraryDir === undefined ? env.actorsLibraryDir : o.actorsLibraryDir;
    this.deps = {
      parseScreenplay: o.deps?.parseScreenplay ?? parseScreenplay,
      generateWorld: o.deps?.generateWorld ?? generateWorld,
      calibrateWorld: o.deps?.calibrateWorld ?? calibrateWorld,
      stageScene: o.deps?.stageScene ?? stageScene,
      buildActor: o.deps?.buildActor ?? buildActor,
      synthesizeLine: o.deps?.synthesizeLine ?? synthesizeLine,
    };
    this.echo = o.echo ?? true;
    this.calibrate = o.calibrate ?? env.calibrate;
    this.calibrateVision = o.calibrateVision ?? env.calibrateVision;
    this.stage = o.stage ?? env.staging;
    this.worldSem = new Semaphore(o.maxWorldJobs ?? 3);
    this.actorSem = new Semaphore(o.maxActorJobs ?? 2);
    this.ttsSem = new Semaphore(o.maxTtsJobs ?? 4);
    this.found = new FoundModels({
      enabled: o.foundModels ?? (env.foundModels === 'auto' ? !o.mock : env.foundModels === 'on'),
      libraryDir: o.modelsLibraryDir ?? env.modelsLibraryDir,
      ...(o.foundModelsBudgetMs ? { budgetMs: o.foundModelsBudgetMs } : {}),
    });
    this.chat = new ChatStore(
      (id) => this.dir(id),
      (id, revision) => this.mirrorChatRevision(id, revision),
    );
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * `draft`: a chat-first project (shared/chat.ts): only the parse runs; the screenplay becomes
   * the thread's first message, the plan card its answer, and generate() starts the rest.
   */
  async createProject(input: {
    title?: string;
    screenplay: string;
    draft?: boolean;
  }): Promise<ProjectStatus> {
    const screenplay = input.screenplay.replace(/\r\n?/g, '\n');
    if (!screenplay.trim()) throw new PipelineError('screenplay is empty', 400);
    const given = input.title?.trim().slice(0, 200) || undefined;
    const title = given ?? parseFountain(screenplay).title ?? 'Untitled';
    const id = `${slugify(title, 24)}-${randomBytes(3).toString('hex')}`;
    const dir = this.dir(id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'screenplay.fountain'), screenplay);
    await writeJsonAtomic(join(dir, 'input.json'), { title: given ?? null });
    const status: ProjectStatus = {
      id,
      title,
      createdAt: new Date().toISOString(),
      mock: this.mock,
      parse: { status: 'pending' },
      scenes: [],
      ...(input.draft ? { draft: true } : {}),
    };
    this.statuses.set(id, status);
    await this.persist(id);
    await this.log(
      id,
      `project created (${screenplay.length} chars, ${this.mock ? 'MOCK' : 'live'}${input.draft ? ', draft' : ''})`,
    );
    if (input.draft) {
      await this.chat.appendMessages(id, [
        { id: newMessageId(), at: status.createdAt, role: 'user', text: screenplay },
      ]);
    }
    this.enqueue(id, () => this.runParse(id));
    return structuredClone(this.statuses.get(id)!);
  }

  async getProject(id: string): Promise<ProjectStatus | undefined> {
    const st = await this.load(id);
    return st && structuredClone(st);
  }

  async listProjects(): Promise<ProjectStatus[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dataDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
    const all = await Promise.all(
      names.filter(isProjectId).map((n) => this.load(n).catch(() => undefined)),
    );
    return all
      .filter((s): s is ProjectStatus => !!s)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((s) => structuredClone(s));
  }

  /**
   * Re-runs one stage. A failed stage retries what failed (a failed Marble job is resubmitted);
   * a done stage is redone (actors/tts rebuilt; world re-verified from its receipt, never
   * regenerated). No-op while the stage is already running.
   */
  async retry(id: string, sceneIndex: number, stage: StageName): Promise<ProjectStatus> {
    const st = await this.load(id);
    if (!st) throw new PipelineError(`no project ${id}`, 404);
    if (st.draft && stage !== 'parse')
      throw new PipelineError('draft project: start the generation first (POST /generate)', 409);
    if (stage === 'parse') {
      if (st.parse.status === 'done')
        throw new PipelineError('parse already succeeded; create a new project to re-plan', 409);
      if (st.parse.status !== 'running') {
        st.parse = { status: 'pending' };
        await this.persist(id);
        await this.log(id, 'retry: parse');
        this.enqueue(id, () => this.runParse(id));
      }
      return structuredClone(st);
    }
    const job = st.scenes[sceneIndex];
    const plan = await this.plan(id);
    const scene = plan?.scenes[sceneIndex];
    if (!job || !scene) throw new PipelineError(`no scene ${sceneIndex} in ${id}`, 404);
    if (job.stages[stage].status === 'running') return structuredClone(st);
    await this.log(id, `retry: scene ${sceneIndex} ${stage} (was ${job.stages[stage].status})`);

    const sceneDir = this.sceneDir(id, sceneIndex);
    const redo = job.stages[stage].status === 'done';
    if (stage === 'world') {
      if (job.stages.world.status === 'failed') this.worldRetryFailed.add(`${id}:${sceneIndex}`);
    } else if (stage === 'actors') {
      for (const cid of scene.characterIds) {
        const cachePath = join(this.dir(id), 'actors', cid, 'actor.json');
        if (redo) await rm(cachePath, { force: true });
        const cached = ActorAsset.safeParse(await readJson(cachePath).catch(() => undefined));
        if (redo || !cached.success || this.upgradable(st, cached.data, 'modal'))
          this.actorBuilds.delete(`${id}:${cid}`);
      }
    } else if (stage === 'tts' && redo) {
      await rm(join(sceneDir, 'audio.json'), { force: true });
    }

    if (stage !== 'manifest') job.stages[stage] = { status: 'pending' };
    job.stages.manifest = { status: 'pending' };
    await this.persist(id);
    if (stage !== 'manifest') this.scheduleStage(id, sceneIndex, stage);
    else this.enqueue(`${id}:${sceneIndex}:manifest`, () => this.maybeManifest(id, sceneIndex));

    // Actors are shared: refresh every other scene that uses a rebuilt character.
    if (stage === 'actors') {
      for (const other of plan!.scenes) {
        const oj = st.scenes[other.index];
        if (!oj || other.index === sceneIndex || oj.stages.actors.status === 'running') continue;
        if (!other.characterIds.some((c) => scene.characterIds.includes(c))) continue;
        oj.stages.actors = { status: 'pending' };
        oj.stages.manifest = { status: 'pending' };
        this.scheduleStage(id, other.index, 'actors');
      }
      await this.persist(id);
    }
    return structuredClone(st);
  }

  /**
   * Rebuilds one character at `detail` in the background (the route answers 202): 'high' = LHM-1B
   * plus a fine-tune against the reference into actors/<id>/high/ (about 5 minutes on Modal);
   * 'standard' = back to the standard build in actors/<id>/ (built if missing). The current build
   * stays in every manifest until the new one is ready; then each scene manifest showing the
   * character is rewritten to it and an existing actors-library copy of the character refreshed.
   * Idempotent (a finished build is reused, a submitted Modal call recovered, never paid twice) and
   * a no-op while a rebuild of the character is running. Live projects with Modal keys only.
   */
  async rebuildActor(id: string, characterId: string, detail: ActorDetail): Promise<ProjectStatus> {
    const st = await this.load(id);
    if (!st) throw new PipelineError(`no project ${id}`, 404);
    const plan = await this.plan(id);
    const character = plan?.characters.find((c) => c.id === characterId);
    if (!plan || !character) throw new PipelineError(`no character ${characterId} in ${id}`, 404);
    if (st.mock)
      throw new PipelineError('MOCK project: actor rebuilds need a live project and Modal', 409);
    if (!this.keys.modal)
      throw new PipelineError('Modal keys are not set (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)', 409);
    const building = plan.scenes.some(
      (sc) => sc.characterIds.includes(characterId) && !settled(st.scenes[sc.index]?.stages.actors ?? { status: 'done' }),
    );
    if (building) throw new PipelineError(`${characterId} is still being built; rebuild it afterwards`, 409);
    await this.syncActors(st, plan);
    const entry = st.actors!.find((a) => a.characterId === characterId)!;
    if (entry.rebuild?.status === 'running') return structuredClone(st);
    entry.rebuild = { detail, status: 'running', note: 'queued', startedAt: new Date().toISOString() };
    await this.persist(id);
    await this.log(id, `rebuild: ${characterId} at ${detail} detail (was ${entry.detail})`);
    this.enqueue(`${id}:rebuild:${characterId}`, () => this.runRebuild(id, characterId));
    return structuredClone(st);
  }

  /**
   * Rebuilds a character from the CURRENT plan (description, heightMeters, referenceImage) at its
   * current detail, in the background — the project chat calls it when a character's description,
   * height or reference photo changed on a live project. The cached build is set aside first:
   * actors/<id>/ moves into actors/<id>/prev-<k>/ (never deleted) and actor.json + the manifests
   * point there, so the scene keeps playing the previous build until the new one lands; then
   * runRebuild builds afresh (a photo is normalised and built with LHM, never an actors-library
   * avatar, and the library is not refreshed from it) and rewrites every scene manifest showing
   * the character. Recorded in ProjectStatus.actors[].rebuild ("… from your photo" with a photo).
   * A character that was never built needs nothing (the actors stage reads the current plan); an
   * actors stage still building it is waited for. When only heightMeters changed (description and
   * photo as the manifests show them), the same build is rescaled at once: no new person, no GPU. Idempotent while a rebuild runs: a plan that
   * changed meanwhile is rebuilt once more when it ends. Resumed after a restart (rebuild.json;
   * a submitted Modal call is recovered, never paid twice). MOCK projects rebuild the mannequin.
   */
  async rebuildActorFromPlan(id: string, characterId: string): Promise<ProjectStatus> {
    const st = await this.load(id);
    if (!st) throw new PipelineError(`no project ${id}`, 404);
    const plan = await this.plan(id);
    const character = plan?.characters.find((c) => c.id === characterId);
    if (!plan || !character) throw new PipelineError(`no character ${characterId} in ${id}`, 404);
    if (!st.mock && !this.keys.modal)
      throw new PipelineError('Modal keys are not set (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET)', 409);
    const projectDir = this.dir(id);
    const stages = plan.scenes
      .filter((sc) => sc.characterIds.includes(characterId))
      .map((sc) => st.scenes[sc.index]?.stages.actors ?? { status: 'pending' as const });
    const built = await exists(join(projectDir, 'actors', characterId, 'actor.json'));
    if (st.draft || (!built && stages.every((x) => x.status === 'pending'))) {
      await this.log(id, `rebuild ${characterId} from the plan: not built yet; the actors stage will use the current plan`);
      return structuredClone(st);
    }
    await this.syncActors(st, plan);
    const entry = st.actors!.find((a) => a.characterId === characterId)!;
    if (entry.rebuild?.status === 'running') return structuredClone(st);
    const startedAt = new Date().toISOString();
    // the manifests record the character they were written with: when only the height moved, the
    // same person is rescaled (every actor kind stands at heightMeters) instead of a new LHM build
    const shown = await this.manifestCharacter(id, plan, characterId);
    if (
      built &&
      shown &&
      !stages.some((x) => x.status === 'running') &&
      shown.description === character.description &&
      (shown.referenceImage ?? null) === (character.referenceImage ?? null) &&
      (shown.heightMeters ?? null) !== (character.heightMeters ?? null)
    ) {
      const cachePath = join(projectDir, 'actors', characterId, 'actor.json');
      const raw = await readJson<{ referenceSha?: string }>(cachePath).catch(() => undefined);
      const cached = ActorAsset.safeParse(raw);
      if (cached.success) {
        const asset = withHeight(cached.data, character);
        await writeJsonAtomic(cachePath, { ...asset, ...(raw?.referenceSha ? { referenceSha: raw.referenceSha } : {}) });
        const n = await this.pointManifestsAt(st, plan, asset, character);
        const note = `${heightFor(character).toFixed(2)} m — only the height changed: rescaled, no rebuild · ${n} scene manifest(s) updated`;
        entry.rebuild = { detail: entry.detail, status: 'done', note, startedAt };
        await this.persist(id);
        await this.log(id, `rebuild ${characterId} from the plan: ${note}`);
        return structuredClone(st);
      }
    }
    entry.rebuild = { detail: entry.detail, status: 'running', note: 'queued', startedAt };
    await mkdir(actorDirFor(projectDir, characterId), { recursive: true });
    await writeJsonAtomic(join(actorDirFor(projectDir, characterId), REBUILD_FILE), {
      reason: 'plan',
      startedAt,
    } satisfies RebuildMarker);
    await this.persist(id);
    await this.log(
      id,
      `rebuild: ${characterId} from the plan at ${entry.detail} detail${character.referenceImage ? ` (from your photo ${character.referenceImage})` : ''}`,
    );
    this.enqueue(`${id}:rebuild:${characterId}`, () => this.runRebuild(id, characterId));
    return structuredClone(st);
  }

  /**
   * Regenerates scene N's world from the CURRENT plan (worldPrompt + worldReference) in the
   * background — the project chat's confirmed "regenerate the world" (~5 min, Marble credits).
   * The scoped re-prompt regen machinery does the work: produceRegenWorld builds the new world in
   * scene-<n>/regen/<key>/world/ (the photo as the Marble image prompt with the world prompt as
   * its text), replaceWorld moves the current world to world.prev-<k>/, swaps the new one in,
   * calibrates it and rewrites the manifest; look, actors, props and moves stay, region edits are
   * dropped with a note in edits.json. A world already generated from the same prompt + photo is
   * swapped back in instead of paying twice (the current one: nothing to do). The world stage shows
   * the progress. Idempotent while queued or running, queued behind a first generation still
   * running, and resumed after a restart (world-regen.json; the Marble receipt is recovered). A
   * scene whose world was never generated needs nothing: the world stage reads the current plan.
   * MARBLE_DRY_RUN=1 logs the exact requests and swaps the mock world in.
   */
  async regenerateWorld(id: string, sceneIndex: number): Promise<ProjectStatus> {
    const st = await this.load(id);
    if (!st) throw new PipelineError(`no project ${id}`, 404);
    const plan = await this.plan(id);
    const job = st.scenes[sceneIndex];
    if (!plan?.scenes[sceneIndex] || !job) throw new PipelineError(`no scene ${sceneIndex} in ${id}`, 404);
    if (!st.mock && !this.keys.marble)
      throw new PipelineError('WLT_API_KEY is not set: a live world cannot be regenerated', 409);
    const key = `${id}:${sceneIndex}`;
    if (this.worldRegens.has(key)) return structuredClone(st);
    if (st.draft || job.stages.world.status === 'pending') {
      await this.log(id, `[scene ${sceneIndex}] regenerate world: not generated yet; the world stage will use the current plan`);
      return structuredClone(st);
    }
    this.worldRegens.add(key);
    await writeJsonAtomic(join(this.sceneDir(id, sceneIndex), WORLD_REGEN_FILE), {
      status: 'queued',
      requestedAt: new Date().toISOString(),
    });
    // a first generation still running keeps its stage; this one is queued behind it
    if (job.stages.world.status !== 'running')
      await this.setStage(id, sceneIndex, 'world', { status: 'running', note: 'queued: regenerating the world from the plan' });
    await this.log(id, `[scene ${sceneIndex}] regenerate world from the plan${plan.scenes[sceneIndex]!.worldReference ? ' (with your photo)' : ''}`);
    this.scheduleStage(id, sceneIndex, 'world');
    return structuredClone(st);
  }

  /**
   * Scoped re-prompt regeneration (server/pipeline/reprompt/regen.ts). Shows the scene's world
   * stage as running with `label`, runs `produce` (under the Marble job cap) to build a new world
   * directory, then moves scene-<n>/world/ to world.prev-<k>/, puts the new one in its place,
   * calibrates it like any new world and rewrites the manifest (actors and audio unchanged). When
   * `produce` fails the current world stays and the stage goes back to done with the error.
   */
  async replaceWorld(
    id: string,
    sceneIndex: number,
    label: string,
    produce: (log: (m: string) => void) => Promise<{ dir: string; note: string }>,
  ): Promise<{ ok: boolean; note: string }> {
    const st = await this.load(id);
    const plan = await this.plan(id);
    const scene = plan?.scenes[sceneIndex];
    if (!st || !scene || !st.scenes[sceneIndex]) throw new PipelineError(`no scene ${sceneIndex} in ${id}`, 404);
    const sceneLog = this.logger(id, `[scene ${sceneIndex}] regen: `);
    // Marble's progress ("marble: …") shows on the world stage, like a first generation
    const log = (m: string) => {
      sceneLog(m);
      const job = st.scenes[sceneIndex];
      if (job?.stages.world.status === 'running' && m.startsWith('marble: ')) {
        job.stages.world = { status: 'running', note: `${label.split(' · ')[0]} · ${m.slice(8)}`.slice(0, 400) };
        void this.persist(id);
      }
    };
    const sceneDir = this.sceneDir(id, sceneIndex);
    const worldDir = join(sceneDir, 'world');
    await this.setStage(id, sceneIndex, 'world', { status: 'running', note: label });
    let result: { ok: boolean; note: string };
    try {
      const made = await this.worldSem.use(() => produce(log));
      if (resolve(made.dir) !== resolve(worldDir)) {
        let k = 1;
        while (await exists(join(sceneDir, `world.prev-${k}`))) k++;
        if (await exists(worldDir)) await rename(worldDir, join(sceneDir, `world.prev-${k}`));
        await rename(made.dir, worldDir);
        log(`previous world kept in world.prev-${k}/`);
      }
      const asset = WorldAsset.parse(await readJson(join(worldDir, ASSET_FILE)));
      const cal = await this.calibrateStep(st, scene, worldDir, asset, log);
      const staged = await this.stageStep(st, scene, worldDir, cal.asset, log);
      await this.worldDone(st, sceneIndex, cal.asset, made.note + cal.note + staged);
      result = { ok: true, note: made.note + cal.note + staged };
    } catch (e) {
      log(`FAILED ${errMsg(e)}; the current world is kept`);
      await this.setStage(id, sceneIndex, 'world', { status: 'done', note: `regeneration failed: ${errMsg(e)} (current world kept)` });
      result = { ok: false, note: errMsg(e) };
    }
    const job = st.scenes[sceneIndex];
    if (job) job.stages.manifest = { status: 'pending' };
    await this.persist(id);
    await this.maybeManifest(id, sceneIndex);
    return result;
  }

  /** Picks up unfinished work after a restart (call once at startup). */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = [];
    for (const st of await this.listProjects()) {
      const live = this.statuses.get(st.id)!;
      // a parsed draft waits for generate(): its pending stages are not unfinished work
      if (live.draft && settled(live.parse)) continue;
      const rebuilding = (live.actors ?? []).filter((a) => a.rebuild?.status === 'running');
      const unfinished =
        !settled(live.parse) ||
        rebuilding.length > 0 ||
        live.scenes.some((j) => Object.values(j.stages).some((s) => !settled(s)));
      if (!unfinished) continue;
      if (this.mock && !live.mock) {
        await this.log(st.id, 'not resumed: live project and the server is in MOCK mode');
        continue;
      }
      await this.log(st.id, 'resuming unfinished pipeline');
      resumed.push(st.id);
      if (!settled(live.parse) || live.scenes.length === 0) {
        this.enqueue(st.id, () => this.runParse(st.id));
        continue;
      }
      // a rebuild interrupted mid-call recovers its Modal receipt instead of submitting again
      for (const a of rebuilding)
        this.enqueue(`${st.id}:rebuild:${a.characterId}`, () => this.runRebuild(st.id, a.characterId));
      for (const job of live.scenes) {
        for (const stage of ['world', 'actors', 'tts'] as const) {
          if (!settled(job.stages[stage])) this.scheduleStage(st.id, job.sceneIndex, stage);
        }
        if (!settled(job.stages.manifest))
          this.enqueue(`${st.id}:${job.sceneIndex}:manifest`, () =>
            this.maybeManifest(st.id, job.sceneIndex),
          );
      }
    }
    return resumed;
  }

  /** Resolves when no pipeline work is queued or running (tests, CLI). */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  projectDir(id: string): string {
    return this.dir(id);
  }

  // -------------------------------------------------------------------------
  // Project chat (server/pipeline/chat/): plan amendments, draft generation, re-plans
  // -------------------------------------------------------------------------

  async getPlan(id: string): Promise<ScreenplayPlan | undefined> {
    const plan = await this.plan(id);
    return plan && structuredClone(plan);
  }

  readScreenplay(id: string): Promise<string> {
    return readFile(join(this.dir(id), 'screenplay.fountain'), 'utf8');
  }

  /** A line in the project's log.txt (the chat logs every action it applies). */
  logEvent(id: string, message: string): Promise<void> {
    return this.log(id, message);
  }

  /**
   * Rewrites plan.json through `fn` (a mutation of a copy, or a returned plan): validated, the
   * plan cache and project.json (title, scene headings, actor names) follow, the change is logged.
   * Characters and scenes keep their ids and order (structural changes go through replan).
   * Nothing is scheduled: the caller decides what the change invalidates.
   */
  amendPlan(id: string, fn: (plan: ScreenplayPlan) => void | ScreenplayPlan): Promise<AmendResult> {
    return this.underPlanLock(id, async () => {
      const st = await this.load(id);
      const before = await this.plan(id);
      if (!st) throw new PipelineError(`no project ${id}`, 404);
      if (!before) throw new PipelineError(`${id} has no plan yet`, 409);
      const copy = structuredClone(before);
      const plan = ScreenplayPlan.parse(fn(copy) ?? copy);
      const same = (a: { id?: string; slug?: string }[], b: { id?: string; slug?: string }[]) =>
        a.length === b.length && a.every((x, i) => (x.id ?? x.slug) === (b[i]!.id ?? b[i]!.slug));
      if (!same(plan.scenes, before.scenes) || plan.scenes.some((s, i) => s.index !== i))
        throw new PipelineError('a plan amendment cannot add, remove or reorder scenes; re-plan instead', 400);
      if (!same(plan.characters, before.characters))
        throw new PipelineError('a plan amendment cannot add or remove characters; re-plan instead', 400);
      const changed = planDiff(before, plan);
      if (changed.length) {
        await writeJsonAtomic(join(this.dir(id), 'plan.json'), plan);
        this.plans.set(id, plan);
        if (plan.title !== before.title) st.title = plan.title;
        for (const s of plan.scenes) if (st.scenes[s.index]) st.scenes[s.index]!.heading = s.heading;
        if (st.actors) await this.syncActors(st, plan);
        await this.persist(id);
        await this.log(id, `plan amended: ${changed.join('; ').slice(0, 800)}`);
      }
      return { plan: structuredClone(plan), before: structuredClone(before), changed };
    });
  }

  /**
   * Starts a draft project's worlds, actors and voices (POST /api/projects/:id/generate): clears
   * `draft` and schedules every scene like an ordinary parse does. A no-op for a project that is
   * not a draft (already generating or generated). Before the parse finishes it only clears the
   * flag, and the parse schedules the stages when it is done.
   */
  async generate(id: string): Promise<ProjectStatus> {
    const st = await this.load(id);
    if (!st) throw new PipelineError(`no project ${id}`, 404);
    if (!st.draft) return structuredClone(st);
    delete st.draft;
    const plan = st.parse.status === 'done' ? await this.plan(id) : undefined;
    if (plan) st.scenes = plan.scenes.map(initJob);
    await this.persist(id);
    await this.log(
      id,
      plan
        ? `generate: starting worlds, actors and voices for ${plan.scenes.length} scene(s)`
        : `generate: starts when the parse is done (parse ${st.parse.status})`,
    );
    if (plan)
      for (const scene of plan.scenes)
        for (const stage of ['world', 'actors', 'tts'] as const) this.scheduleStage(id, scene.index, stage);
    return structuredClone(st);
  }

  /**
   * Re-plans from an amended screenplay (the chat's structural changes). The new parse is merged
   * with the current plan (chat/replan.ts: characters keep their ids, amendments and photos;
   * scenes with an unchanged heading keep their world prompt, marks and scene-<n>/ folder, moved
   * to their new index). A draft only gets the new plan; a generated project re-runs every scene
   * (kept worlds are reused from their receipts, cached actors and line audio stay valid) and
   * folders of removed scenes are set aside as scene-<n>.replaced-<tag>/.
   */
  replan(id: string, screenplay: string): Promise<ProjectStatus> {
    return this.underPlanLock(id, async () => {
      const st = await this.load(id);
      const prev = await this.plan(id);
      if (!st) throw new PipelineError(`no project ${id}`, 404);
      if (!prev) throw new PipelineError(`${id} has no plan yet`, 409);
      const busy = st.scenes.some((j) => (['world', 'actors', 'tts'] as const).some((s) => j.stages[s].status === 'running'));
      if (!st.draft && busy) throw new PipelineError('stages are still running; re-plan when they are done', 409);
      const text = screenplay.replace(/\r\n?/g, '\n');
      if (!text.trim()) throw new PipelineError('screenplay is empty', 400);
      const dir = this.dir(id);
      const input = (await readJson<{ title?: string | null }>(join(dir, 'input.json'))) ?? {};
      const offline = st.mock || !this.keys.anthropic;
      await this.log(id, `replan: planning the amended screenplay (${text.length} chars)`);
      const next = ScreenplayPlan.parse(
        await this.deps.parseScreenplay(text, {
          mock: offline,
          log: this.logger(id, 'replan: '),
          title: input.title ?? undefined,
        }),
      );
      const merged = mergeReplan(prev, next);
      const old = await readFile(join(dir, 'screenplay.fountain'), 'utf8').catch(() => '');
      await writeFile(join(dir, 'screenplay.prev.fountain'), old);
      await writeFile(join(dir, 'screenplay.fountain'), text);
      if (!st.draft) await this.moveSceneDirs(id, merged.sceneFrom, merged.droppedScenes);
      await writeJsonAtomic(join(dir, 'plan.json'), merged.plan);
      this.plans.set(id, merged.plan);
      if (!input.title) st.title = merged.plan.title;
      st.scenes = merged.plan.scenes.map(st.draft ? draftJob : initJob);
      st.parse = {
        status: 'done',
        note: `${merged.plan.scenes.length} scene(s), ${merged.plan.characters.length} character(s) (re-planned)`,
      };
      await this.syncActors(st, merged.plan);
      await this.persist(id);
      const moves = merged.sceneFrom.map((j, i) => (j === null ? `${i}: new` : `${i} ← ${j}`)).join(', ');
      await this.log(
        id,
        `replan: done — characters kept ${merged.kept.join(', ') || 'none'}, new ${merged.added.join(', ') || 'none'}, removed ${merged.removed.join(', ') || 'none'}; scenes ${moves}`,
      );
      if (!st.draft)
        for (const scene of merged.plan.scenes)
          for (const stage of ['world', 'actors', 'tts'] as const) this.scheduleStage(id, scene.index, stage);
      return structuredClone(st);
    });
  }

  /**
   * A cached offline fallback (mannequin / beeps) is not final in a live project once the keys
   * that could replace it are present: it is rebuilt on the next run or retry instead.
   */
  private upgradable(st: ProjectStatus, asset: { fallback?: boolean }, key: 'modal' | 'tts') {
    return !!asset.fallback && !st.mock && !!this.keys[key];
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private dir(id: string): string {
    if (!isProjectId(id)) throw new PipelineError(`invalid project id`, 400);
    return join(this.dataDir, id);
  }

  private sceneDir(id: string, index: number): string {
    return join(this.dir(id), `scene-${index}`);
  }

  private async load(id: string): Promise<ProjectStatus | undefined> {
    if (!isProjectId(id)) return undefined;
    const cached = this.statuses.get(id);
    if (cached) return cached;
    const raw = await readJson(join(this.dir(id), 'project.json'));
    if (!raw) return undefined;
    const st = ProjectStatus.parse(raw);
    if (!st.actors && st.parse.status === 'done') {
      const plan = await this.plan(id).catch(() => undefined);
      if (plan) await this.syncActors(st, plan);
    }
    this.statuses.set(id, this.statuses.get(id) ?? st);
    return this.statuses.get(id);
  }

  private async plan(id: string): Promise<ScreenplayPlan | undefined> {
    const cached = this.plans.get(id);
    if (cached) return cached;
    const raw = await readJson(join(this.dir(id), 'plan.json'));
    if (!raw) return undefined;
    const plan = ScreenplayPlan.parse(raw);
    this.plans.set(id, plan);
    return plan;
  }

  /** Serialized write of the latest in-memory status. */
  private persist(id: string): Promise<void> {
    const prev = this.writes.get(id) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => {
        const st = this.statuses.get(id);
        return st ? writeJsonAtomic(join(this.dir(id), 'project.json'), st) : undefined;
      });
    this.writes.set(id, next);
    return next;
  }

  private async log(id: string, msg: string): Promise<void> {
    const line = `${new Date().toISOString()} ${msg}`;
    if (this.echo) console.log(`[${id}] ${msg}`);
    try {
      await appendFile(join(this.dir(id), 'log.txt'), `${line}\n`);
    } catch {
      /* project dir removed under us */
    }
  }

  private logger(id: string, prefix: string) {
    return (m: string) => void this.log(id, `${prefix}${m}`);
  }

  /** Plan rewrites (amendPlan, replan) of one project run one at a time. */
  private underPlanLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.planLocks.get(id) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    const tail = p.catch(() => {});
    this.planLocks.set(id, tail);
    void tail.then(() => {
      if (this.planLocks.get(id) === tail) this.planLocks.delete(id);
    });
    return p;
  }

  private async mirrorChatRevision(id: string, revision: number): Promise<void> {
    const st = await this.load(id);
    if (!st || (st.chatRevision ?? 0) >= revision) return;
    st.chatRevision = revision;
    await this.persist(id);
  }

  /** A parsed (or failed) draft answers in its thread: the plan card, or why there is none. */
  private async draftParsed(st: ProjectStatus, plan: ScreenplayPlan | undefined, error?: string) {
    try {
      const source = st.mock || !this.keys.anthropic ? 'mock' : 'claude';
      await this.chat.appendMessages(st.id, [
        plan
          ? planCardMessage(plan, { draft: true, source })
          : {
              id: newMessageId(),
              at: new Date().toISOString(),
              role: 'assistant',
              text: `I could not plan this screenplay (${error ?? 'unknown error'}). Retry the parse, or check the scene headings and character cues and paste it again.`,
              source,
            },
      ]);
    } catch (e) {
      await this.log(st.id, `chat: plan card not written: ${errMsg(e)}`);
    }
  }

  /**
   * Re-plan of a generated project: scene-<j>/ becomes scene-<i>/ for every new scene i that
   * continues old scene j (its world, receipt and edits come along; its line cache is dropped
   * because line ids follow the new order), folders of dropped scenes are set aside.
   */
  private async moveSceneDirs(id: string, sceneFrom: (number | null)[], dropped: number[]) {
    const tag = randomBytes(3).toString('hex');
    const tmp = (j: number) => join(this.dir(id), `.replan-${tag}-scene-${j}`);
    const olds = [...sceneFrom.filter((j): j is number => j !== null), ...dropped];
    for (const j of olds) if (await exists(this.sceneDir(id, j))) await rename(this.sceneDir(id, j), tmp(j));
    for (const [i, j] of sceneFrom.entries()) {
      if (j === null || !(await exists(tmp(j)))) continue;
      await rename(tmp(j), this.sceneDir(id, i));
      await rm(join(this.sceneDir(id, i), 'audio.json'), { force: true });
    }
    for (const j of dropped)
      if (await exists(tmp(j))) await rename(tmp(j), join(this.dir(id), `scene-${j}.replaced-${tag}`));
    for (const k of [...this.worldRetryFailed]) if (k.startsWith(`${id}:`)) this.worldRetryFailed.delete(k);
  }

  /** Serial task queue per key; a key already waiting to run is not queued twice. */
  private enqueue(key: string, fn: () => Promise<void>): void {
    if (this.queued.has(key)) return;
    this.queued.add(key);
    this.active++;
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      this.queued.delete(key);
      try {
        await fn();
      } catch (e) {
        console.error(`pipeline task ${key} crashed:`, e);
      } finally {
        if (--this.active === 0) for (const w of this.idleWaiters.splice(0)) w();
      }
    });
    this.chains.set(key, next);
  }

  private async setStage(
    id: string,
    sceneIndex: number,
    stage: StageName,
    s: Stage,
  ): Promise<void> {
    const st = this.statuses.get(id);
    const job = st?.scenes[sceneIndex];
    if (!job) return;
    job.stages[stage] = s.note
      ? { status: s.status, note: s.note.slice(0, 400) }
      : { status: s.status };
    await this.persist(id);
  }

  private scheduleStage(id: string, sceneIndex: number, stage: SceneStage): void {
    // the scene's found models are looked up alongside its world (joined in the manifest step)
    if (stage === 'world' && this.found.enabled)
      void this.plan(id)
        .then((plan) => {
          const scene = plan?.scenes[sceneIndex];
          if (scene) this.found.start(scene.dynamics);
        })
        .catch(() => undefined);
    this.enqueue(`${id}:${sceneIndex}:${stage}`, async () => {
      await this.runSceneStage(id, sceneIndex, stage);
      this.enqueue(`${id}:${sceneIndex}:manifest`, () => this.maybeManifest(id, sceneIndex));
    });
  }

  // -------------------------------------------------------------------------
  // Stages
  // -------------------------------------------------------------------------

  private async runParse(id: string): Promise<void> {
    const st = await this.load(id);
    if (!st || st.parse.status === 'failed' || st.parse.status === 'skipped') return;
    let plan = st.parse.status === 'done' ? await this.plan(id) : undefined;
    if (!plan) {
      st.parse = { status: 'running', note: 'planning scenes' };
      await this.persist(id);
      const dir = this.dir(id);
      try {
        const text = await readFile(join(dir, 'screenplay.fountain'), 'utf8');
        const input = (await readJson<{ title?: string | null }>(join(dir, 'input.json'))) ?? {};
        const offline = st.mock || !this.keys.anthropic;
        plan = ScreenplayPlan.parse(
          await this.deps.parseScreenplay(text, {
            mock: offline,
            log: this.logger(id, 'parse: '),
            title: input.title ?? undefined,
          }),
        );
        await writeJsonAtomic(join(dir, 'plan.json'), plan);
        this.plans.set(id, plan);
        if (!input.title) st.title = plan.title;
        st.scenes = plan.scenes.map(st.draft ? draftJob : initJob);
        const note = `${plan.scenes.length} scene(s), ${plan.characters.length} character(s)${offline && !st.mock ? ' (offline parser: ANTHROPIC_API_KEY not set)' : ''}`;
        st.parse = { status: 'done', note };
        await this.persist(id);
        await this.log(id, `parse: done — ${note}`);
        if (st.draft) await this.draftParsed(st, plan);
      } catch (e) {
        st.parse = { status: 'failed', note: errMsg(e) };
        await this.persist(id);
        await this.log(id, `parse: FAILED ${errMsg(e)}`);
        if (st.draft) await this.draftParsed(st, undefined, errMsg(e));
        return;
      }
    }
    // a draft stops after the parse; generate() schedules the rest
    if (st.draft) return;
    if (st.scenes.length !== plan.scenes.length) {
      st.scenes = plan.scenes.map((s) => st.scenes[s.index] ?? initJob(s));
      await this.persist(id);
    }
    for (const scene of plan.scenes) {
      for (const stage of ['world', 'actors', 'tts'] as const)
        this.scheduleStage(id, scene.index, stage);
    }
  }

  private async runSceneStage(id: string, idx: number, stage: SceneStage): Promise<void> {
    const st = await this.load(id);
    const plan = await this.plan(id);
    const job = st?.scenes[idx];
    const scene = plan?.scenes[idx];
    if (!st || !plan || !job || !scene) return;
    // a queued regenerateWorld (also after a restart) runs even behind a finished first generation
    if (stage === 'world' && (await this.worldRegenQueued(id, idx))) return this.runWorldRegen(st, scene);
    const s = job.stages[stage];
    if (s.status !== 'pending' && s.status !== 'running') return; // done/failed/skipped wait for retry
    if (stage === 'world') return this.worldStage(st, scene);
    if (stage === 'actors') return this.actorsStage(st, plan, scene);
    return this.ttsStage(st, plan, scene);
  }

  private async worldStage(st: ProjectStatus, scene: ScenePlan): Promise<void> {
    const { id } = st;
    const idx = scene.index;
    const outDir = join(this.sceneDir(id, idx), 'world');
    const offline = st.mock || !this.keys.marble;
    const sceneLog = this.logger(id, `[scene ${idx}] world: `);
    // the procedural set a mock world (MOCK, no key, MARBLE_DRY_RUN) uses: one that fits the heading
    const mockSet = pickMockSet(scene, (await this.plan(id))?.style);
    await this.setStage(id, idx, 'world', { status: 'running', note: 'queued' });
    try {
      // the director's photo of the place is the image prompt: never a library world
      const photo = scene.worldReference ? await this.worldPhoto(id, scene, sceneLog) : null;
      const reused = scene.worldReference ? null : await this.libraryWorld(st, scene, outDir, sceneLog);
      if (reused) {
        const cal = await this.calibrateStep(st, scene, outDir, reused.asset, sceneLog);
        const staged = await this.stageStep(st, scene, outDir, cal.asset, sceneLog);
        await this.worldDone(st, idx, cal.asset, `reused library world ${reused.id}${cal.note}${staged}`);
        return;
      }
      const asset = await this.worldSem.use(async () => {
        await this.setStage(id, idx, 'world', {
          status: 'running',
          note: offline ? `copying mock world (${mockSet} set)` : `generating with Marble${photo?.png ? ' from your photo' : ''} (~5 min)`,
        });
        return this.deps.generateWorld({
          prompt: scene.worldPrompt,
          name: `${st.title} · ${scene.heading}`,
          outDir,
          model: this.model,
          mock: offline,
          mockSet,
          ...(photo?.png
            ? { imagePrompt: { file: photo.png, isPano: photo.isPano, textPrompt: scene.worldPrompt } }
            : {}),
          retryFailed: this.worldRetryFailed.delete(`${id}:${idx}`),
          log: (m) => {
            sceneLog(m);
            const job = st.scenes[idx];
            if (job?.stages.world.status === 'running' && m.startsWith('marble: ')) {
              job.stages.world = { status: 'running', note: m.slice(8, 400) };
              void this.persist(id);
            }
          },
        });
      });
      WorldAsset.parse(asset);
      await writeJsonAtomic(join(outDir, ASSET_FILE), asset);
      const cal = await this.calibrateStep(st, scene, outDir, asset, sceneLog);
      const staged = await this.stageStep(st, scene, outDir, cal.asset, sceneLog);
      const mockNote = `mock world: ${mockSetFromCaption(asset.caption) ?? mockSet} set`;
      const note =
        (asset.provider === 'marble'
          ? `marble world ${asset.worldId ?? ''}`.trim()
          : st.mock
            ? mockNote
            : offline
              ? `${mockNote} (WLT_API_KEY not set)`
              : `${mockNote} (MARBLE_DRY_RUN: request logged, not submitted)`) +
        (photo?.png && !offline ? ' from your photo' : '') +
        (photo?.note ? ` — ${photo.note}` : '');
      await this.worldDone(st, idx, cal.asset, note + cal.note + staged);
    } catch (e) {
      await this.setStage(id, idx, 'world', { status: 'failed', note: errMsg(e) });
      sceneLog(`FAILED ${errMsg(e)}`);
    }
  }

  /** The scale step, then the ground field step, of a world just made, copied or regenerated. */
  private async calibrateStep(
    st: ProjectStatus,
    scene: ScenePlan,
    outDir: string,
    asset: WorldAsset,
    log: (m: string) => void,
  ): Promise<{ asset: WorldAsset; note: string }> {
    const scaled = await this.scaleStep(st, scene, outDir, asset, log);
    return { ...scaled, asset: await this.groundStep(scene, outDir, scaled.asset, log) };
  }

  /**
   * Every world, mock included (local, ~1 s for a 2M-splat Marble world, instant for the mock):
   * makes sure world-asset.json names a current ground height field (calibrate-ground.ts), the
   * ground each actor's feet are put on. Never throws; without a field actors stand on the median
   * floor as before.
   */
  private async groundStep(scene: ScenePlan, outDir: string, asset: WorldAsset, log: (m: string) => void): Promise<WorldAsset> {
    try {
      if (await storedGroundField(outDir, asset)) return asset;
      const marks = await this.markXZ(scene, outDir, asset);
      // the mock floor is a sparse 0.14 m lattice: 2 splats make a layer there
      const next = await writeGroundField(outDir, asset, { marks, log, minLayer: asset.provider === 'mock' ? 2 : undefined });
      await writeJsonAtomic(join(outDir, ASSET_FILE), next);
      return next;
    } catch (e) {
      log(`ground field not measured: ${errMsg(e)}; actors stand on the median floor`);
      return asset;
    }
  }

  /**
   * Live Marble worlds only: measures the scale once (an existing scaleCalibration, e.g. carried
   * by a library copy, or a previous scale-calibration.json for the same world id is reused) and
   * writes it into world-asset.json and the library copy. Never throws.
   */
  private async scaleStep(
    st: ProjectStatus,
    scene: ScenePlan,
    outDir: string,
    asset: WorldAsset,
    log: (m: string) => void,
  ): Promise<{ asset: WorldAsset; note: string }> {
    if (!this.calibrate || st.mock || asset.provider !== 'marble') return { asset, note: '' };
    const marks = await this.markXZ(scene, outDir, asset);
    if (asset.scaleCalibration) {
      // carried by a library copy: re-decided from its stored report (no Claude call), with the
      // visible ground measured where this scene's actors stand (local, ~2 s)
      try {
        const prev = await previousCalibration(outDir, asset.worldId);
        if (!prev) return { asset, note: '' };
        const report = await withGround(redecide(prev), outDir, marks);
        // rewritten when the floor moved or the decision rule changed the calibration
        const same = JSON.stringify(asset.scaleCalibration) === JSON.stringify(report.calibration);
        if (same && asset.floorOffsetMeters === report.floorOffsetMeters) return { asset, note: '' };
        return { asset: await writeCalibration(outDir, report, { log, marks }), note: '' };
      } catch (e) {
        log(`floor offset not measured: ${errMsg(e)}`);
        return { asset, note: '' };
      }
    }
    try {
      let report = await previousCalibration(outDir, asset.worldId);
      if (report) report = await withGround(redecide(report), outDir, marks);
      if (!report) {
        await this.setStage(st.id, scene.index, 'world', {
          status: 'running',
          note: 'measuring the world scale (collider + vision)',
        });
        report = await this.deps.calibrateWorld(outDir, {
          interior: scene.interior,
          vision: this.calibrateVision && this.keys.anthropic,
          log,
          marks,
        });
        if (!report.geometry && !report.vision && report.decision.method === 'none') {
          log(`scale calibration: nothing to measure (${report.visionSkipped ?? 'no collider'}); Marble scale kept`);
          return { asset, note: '' };
        }
      }
      const next = await writeCalibration(outDir, report, { libraryDir: this.libraryDir, log, marks });
      const c = report.calibration;
      log(`scale calibration: ×${c.factor} (${c.confidence}, ${c.method}): ${c.evidence}`);
      return { asset: next, note: `; scale ×${c.factor.toFixed(2)} (${c.confidence})` };
    } catch (e) {
      log(`scale calibration failed: ${errMsg(e)}; Marble scale kept`);
      return { asset, note: '' };
    }
  }

  /**
   * Where the scene's actors stand (xz, scene metres) for the floor and ground measurements: the
   * staged marks when scene-<n>/staging.json is current for this world, then the planner's
   * (staging.ts groundMarks), so a re-run measures where the previous run staged them instead of
   * flipping back and forth.
   */
  private async markXZ(scene: ScenePlan, worldDir: string, asset: WorldAsset): Promise<(readonly [number, number])[]> {
    const plan = await this.plan(this.projectOf(worldDir)).catch(() => undefined);
    const staged = plan
      ? stagedBlocking(await readStaging(join(worldDir, '..')), { asset, scene, characters: plan.characters })
      : undefined;
    return groundMarks(staged, scene.blocking);
  }

  /** The project id a scene world dir belongs to (<dataDir>/<id>/scene-<n>/world). */
  private projectOf(worldDir: string): string {
    return relative(this.dataDir, worldDir).split(sep)[0] ?? '';
  }

  /**
   * Live Marble worlds with a collider and the Anthropic key: stages the scene's actors on the set
   * once (staging.ts) into scene-<n>/staging.json, reused while its inputs are unchanged (a report
   * that kept the planner's blocking is reused too, so a hopeless set is not paid for twice).
   * Returns a note suffix for the world stage. Never throws: a failure keeps the planner's marks.
   */
  private async stageStep(
    st: ProjectStatus,
    scene: ScenePlan,
    worldDir: string,
    asset: WorldAsset,
    log: (m: string) => void,
  ): Promise<string> {
    if (!this.stage || st.mock || !this.keys.anthropic) return '';
    if (asset.provider !== 'marble' || !asset.colliderGlb || !scene.characterIds.length) return '';
    const plan = await this.plan(st.id);
    if (!plan) return '';
    const sceneDir = this.sceneDir(st.id, scene.index);
    const summary = (r: StagingReport) =>
      r.status === 'staged' ? `; ${r.blocking.length} actor(s) staged on the set` : '; staging kept the planner marks';
    try {
      const prev = await readStaging(sceneDir);
      const factor = calibrationFactor(asset);
      if (prev && stagingCurrent(prev, { worldId: asset.worldId, scene, characters: plan.characters, factor })) {
        log(`staging: reusing ${sceneDir.split(sep).slice(-1)[0]}/staging.json (${prev.status})`);
        return summary(prev);
      }
      await this.setStage(st.id, scene.index, 'world', {
        status: 'running',
        note: 'staging the actors on the set (vision)',
      });
      const report = await this.deps.stageScene({ worldDir, asset, scene, characters: plan.characters, log });
      await writeStaging(sceneDir, report);
      // the floor offset and the ground field follow the actors to their new marks
      const staged = stagedBlocking(report, { asset, scene, characters: plan.characters });
      if (staged)
        await measureGroundAtMarks(worldDir, asset, groundMarks(staged, scene.blocking), { log }).catch((e) =>
          log(`ground not re-measured at the staged marks: ${errMsg(e)}`),
        );
      return summary(report);
    } catch (e) {
      log(`staging skipped: ${errMsg(e)}; the planner's blocking is kept`);
      return '';
    }
  }

  private async worldDone(st: ProjectStatus, idx: number, asset: WorldAsset, note: string) {
    const job = st.scenes[idx];
    if (job && asset.thumbnail)
      job.thumbnailUrl = `/projects/${st.id}/scene-${idx}/world/${asset.thumbnail}`;
    await this.setStage(st.id, idx, 'world', { status: 'done', note });
    void this.log(st.id, `[scene ${idx}] world: done — ${note}`);
  }

  /**
   * Live projects only: copies the world-library world matching the scene slug into the scene,
   * unless the scene already has its own Marble receipt (a submitted job is never abandoned).
   */
  private async libraryWorld(
    st: ProjectStatus,
    scene: ScenePlan,
    outDir: string,
    log: (m: string) => void,
  ): Promise<{ id: string; asset: WorldAsset } | null> {
    if (st.mock || !this.libraryDir) return null;
    if (await exists(join(outDir, RECEIPT_FILE))) return null;
    const world = await findLibraryWorld(this.libraryDir, scene.slug, log);
    if (!world) return null;
    const asset = await copyLibraryWorld(world, outDir);
    const id = asset.worldId ?? world.key;
    log(`reusing library world ${world.key} (${id}) from ${world.dir}: no Marble call`);
    return { id, asset };
  }

  /**
   * The scene's environment photo as a PNG Marble can take: a PNG upload as it is, a JPEG / WebP
   * converted once into scene-<n>/world-reference/<sha>.png. png null (+ note) when it cannot be
   * used; the world is then generated from the text prompt.
   */
  private async worldPhoto(
    id: string,
    scene: ScenePlan,
    log: (m: string) => void,
  ): Promise<{ png: string | null; isPano: boolean; source: string; note?: string }> {
    const ref = scene.worldReference!;
    const base = { isPano: ref.isPano, source: ref.file };
    try {
      const photo = await readPhoto(this.dir(id), ref.file);
      if (photo.kind === 'png') return { ...base, png: photo.path };
      const png = join(this.sceneDir(id, scene.index), 'world-reference', `${photo.sha256.slice(0, 16)}.png`);
      if (await exists(png)) return { ...base, png };
      const how = await photoToPng(photo, png, log);
      if (how) {
        log(`your photo ${photo.file}: ${how} for the Marble upload`);
        return { ...base, png };
      }
      const note = `your ${photo.kind.toUpperCase()} photo could not be converted to PNG for Marble; generated from the text prompt`;
      log(note);
      return { ...base, png: null, note };
    } catch (e) {
      const note = `${errMsg(e)}; generated from the text prompt`;
      log(note);
      return { ...base, png: null, note };
    }
  }

  private async worldRegenQueued(id: string, idx: number): Promise<boolean> {
    const m = await readJson<{ status?: string }>(join(this.sceneDir(id, idx), WORLD_REGEN_FILE)).catch(() => undefined);
    return m?.status === 'queued';
  }

  /** regenerateWorld's background half (see there). */
  private async runWorldRegen(st: ProjectStatus, scene: ScenePlan): Promise<void> {
    const { id } = st;
    const n = scene.index;
    const sceneDir = this.sceneDir(id, n);
    const marker = join(sceneDir, WORLD_REGEN_FILE);
    const log = this.logger(id, `[scene ${n}] regenerate world: `);
    const finish = (status: 'done' | 'failed', note: string) =>
      writeJsonAtomic(marker, { status, note: note.slice(0, 400), finishedAt: new Date().toISOString() });
    this.worldRegens.add(`${id}:${n}`);
    try {
      const photo = scene.worldReference ? await this.worldPhoto(id, scene, log) : null;
      const imagePrompt = photo?.png ? { file: photo.png, isPano: photo.isPano, textPrompt: scene.worldPrompt } : undefined;
      const target = await promptKey({ prompt: scene.worldPrompt, imagePrompt });
      const what = imagePrompt ? 'your photo' : 'this prompt';
      // never pay Marble twice for the same prompt + photo (MOCK worlds are free to redo)
      const earlier = st.mock ? null : await findGeneratedWorld(sceneDir, target);
      if (earlier && resolve(earlier) === resolve(join(sceneDir, 'world'))) {
        const note = `already generated from ${what}: nothing to regenerate`;
        log(note);
        await this.setStage(id, n, 'world', { status: 'done', note });
        await finish('done', note);
        return;
      }
      const regen: RegenSpec = {
        method: 'text',
        prompt: scene.worldPrompt,
        estimatedMinutes: 5,
        estimatedCredits: 1580,
        keeps: ['actors', 'look', 'props', 'moves'],
        drops: [],
      };
      const label = `regenerating the world from ${imagePrompt ? 'your photo' : 'the plan'} · ~5 min`;
      const result = await this.replaceWorld(id, n, label, async (stageLog) => {
        if (earlier)
          return { dir: earlier, note: `the world already generated from ${what} (${basename(earlier)}/) is back: no Marble call` };
        const made = await produceRegenWorld({
          sceneDir,
          name: `${st.title} · ${scene.heading}`,
          regen,
          mock: st.mock || !this.keys.marble,
          // MOCK / dry run: the regenerated stand-in is the set that fits the scene, like a first build
          mockSet: pickMockSet(scene, (await this.plan(id))?.style),
          log: stageLog,
          model: this.model,
          ...(imagePrompt ? { photo: { file: imagePrompt.file, isPano: imagePrompt.isPano, source: photo!.source } } : {}),
          deps: { generateWorld: this.deps.generateWorld },
        });
        return { dir: made.dir, note: made.note + (photo?.note ? ` — ${photo.note}` : '') };
      });
      if (result.ok)
        await dropRegionEdits(editsStoreFor(this), id, n, { prompt: 'regenerate the world from the plan', note: result.note, regen });
      await finish(result.ok ? 'done' : 'failed', result.note);
    } catch (e) {
      log(`FAILED ${errMsg(e)}`);
      await this.setStage(id, n, 'world', { status: 'done', note: `regeneration failed: ${errMsg(e)} (current world kept)` });
      await finish('failed', errMsg(e));
    } finally {
      this.worldRegens.delete(`${id}:${n}`);
    }
  }

  private characterMap(plan: ScreenplayPlan) {
    return new Map(plan.characters.map((c) => [c.id, c]));
  }

  private async actorsStage(
    st: ProjectStatus,
    plan: ScreenplayPlan,
    scene: ScenePlan,
  ): Promise<void> {
    const { id } = st;
    const idx = scene.index;
    const chars = this.characterMap(plan);
    const cast = scene.characterIds.flatMap((c) => chars.get(c) ?? []);
    if (!cast.length)
      return this.setStage(id, idx, 'actors', { status: 'skipped', note: 'no characters' });
    await this.setStage(id, idx, 'actors', {
      status: 'running',
      note: `building ${cast.length} actor(s)`,
    });
    const built = await Promise.all(cast.map((c) => this.actor(st, c, plan.style)));
    await this.syncActors(st, plan);
    const failed = cast.filter((_, k) => !built[k]);
    if (failed.length) {
      const why = failed
        .map((c) => `${c.id}: ${this.actorErrors.get(`${id}:${c.id}`) ?? 'failed'}`)
        .join('; ');
      await this.setStage(id, idx, 'actors', {
        status: 'failed',
        note: `${failed.length}/${cast.length} failed — ${why}`,
      });
    } else {
      const kinds = [...new Set(built.map((a) => a!.kind))].join(', ');
      const fallbacks = built.filter((a) => a!.fallback).length;
      const reused = cast.filter((c) => this.libraryActors.has(`${id}:${c.id}`)).map((c) => c.id);
      await this.setStage(id, idx, 'actors', {
        status: 'done',
        note: [
          `${cast.length} actor(s): ${kinds}`,
          reused.length ? ` — reused library actor: ${reused.join(', ')}` : '',
          fallbacks ? ` — ${fallbacks} fallback (retry to upgrade)` : '',
        ].join(''),
      });
    }
  }

  /** Builds (once per project) or loads the shared actor for a character. */
  private actor(st: ProjectStatus, character: Character, style?: VisualStyle): Promise<ActorAsset | undefined> {
    const key = `${st.id}:${character.id}`;
    const existing = this.actorBuilds.get(key);
    if (existing) return existing;
    const projectDir = this.dir(st.id);
    const actorDir = join(projectDir, 'actors', character.id);
    const cachePath = join(actorDir, 'actor.json');
    const log = this.logger(st.id, `actor ${character.id}: `);
    const p = (async () => {
      const raw = await readJson<{ referenceSha?: string }>(cachePath).catch(() => undefined);
      const cached = ActorAsset.safeParse(raw);
      // actor.json records the photo it was built from: another photo (or none any more) rebuilds
      const sha = await photoSha(projectDir, character);
      const samePhoto = raw?.referenceSha === sha;
      // a running rebuild owns actors/<id>/ and rewrites the manifests itself when it lands
      const rebuilding = st.actors?.find((a) => a.characterId === character.id)?.rebuild?.status === 'running';
      if (cached.success && (rebuilding || (samePhoto && !this.upgradable(st, cached.data, 'modal')))) {
        // an actor.json from before per-character heights (or a re-planned script) follows the plan
        const sized = withHeight(cached.data, character);
        if (sized !== cached.data)
          await writeJsonAtomic(cachePath, { ...sized, ...(raw?.referenceSha ? { referenceSha: raw.referenceSha } : {}) });
        return sized;
      }
      if (cached.success && !samePhoto) log('the reference photo changed since the cached build; rebuilding');
      else if (cached.success) log('cached actor is a fallback and Modal keys are set; rebuilding');
      await mkdir(actorDir, { recursive: true });
      try {
        // a director's photo is this project's person: never the library avatar of the same id
        const found =
          !st.mock && this.actorsLibraryDir && !character.referenceImage
            ? await findLibraryActor(this.actorsLibraryDir, character.id, log)
            : null;
        if (found) {
          const asset = await copyLibraryActor(found, projectDir, heightFor(character));
          await writeJsonAtomic(cachePath, asset);
          this.actorErrors.delete(key);
          this.libraryActors.add(key);
          log(`reused library actor ${found.sequenceDir} (no Modal call)`);
          return asset;
        }
        const built = await this.actorSem.use(() =>
          this.deps.buildActor({ character, projectDir, sceneDir: actorDir, mock: st.mock, log, style }),
        );
        const asset = await normalizeActor(ActorAsset.parse(built), actorDir, projectDir);
        await writeJsonAtomic(cachePath, { ...asset, ...(sha ? { referenceSha: sha } : {}) });
        this.actorErrors.delete(key);
        log(`ready (${asset.kind})${sha && asset.kind === 'splat-sequence' ? ' — built from your photo' : ''}`);
        return asset;
      } catch (e) {
        this.actorErrors.set(key, errMsg(e));
        this.actorBuilds.delete(key); // let a retry rebuild it
        log(`FAILED ${errMsg(e)}`);
        return undefined;
      }
    })();
    this.actorBuilds.set(key, p);
    return p;
  }

  /** ProjectStatus.actors from the plan and each character's actor.json (keeps rebuild records). */
  private async syncActors(st: ProjectStatus, plan: ScreenplayPlan): Promise<void> {
    const prev = new Map((st.actors ?? []).map((a) => [a.characterId, a]));
    const out: ActorBuildStatus[] = [];
    for (const c of plan.characters) {
      const cached = ActorAsset.safeParse(
        await readJson(join(this.dir(st.id), 'actors', c.id, 'actor.json')).catch(() => undefined),
      );
      const old = prev.get(c.id);
      const next = actorBuildStatus(c, cached.success ? cached.data : undefined, old?.rebuild);
      // updated in place: a running rebuild holds its entry and records its outcome there
      if (old) for (const k of Object.keys(old)) delete (old as Record<string, unknown>)[k];
      out.push(old ? Object.assign(old, next) : next);
    }
    st.actors = out;
  }

  private async runRebuild(id: string, characterId: string): Promise<void> {
    const st = await this.load(id);
    let plan = await this.plan(id);
    const entry = st?.actors?.find((a) => a.characterId === characterId);
    let character = plan?.characters.find((c) => c.id === characterId);
    if (!st || !plan || !character || entry?.rebuild?.status !== 'running') return;
    const { detail, startedAt } = entry.rebuild;
    const started = startedAt ? Date.parse(startedAt) : Date.now();
    const name = displayName(character.name);
    const log = this.logger(id, `rebuild ${characterId}: `);
    const note = (status: 'running' | 'done' | 'failed', text: string) => {
      entry.rebuild = { detail, status, note: text.slice(0, 400), ...(startedAt ? { startedAt } : {}) };
      return this.persist(id);
    };
    const projectDir = this.dir(id);
    const actorDir = actorDirFor(projectDir, characterId, detail);
    const markerPath = join(actorDirFor(projectDir, characterId), REBUILD_FILE);
    const marker = await readJson<RebuildMarker>(markerPath).catch(() => undefined);
    const fromPlan = marker?.reason === 'plan' && marker.startedAt === startedAt ? marker : undefined;
    let inputs = buildInputs(character);
    let cost: number | undefined;
    try {
      if (fromPlan && fromPlan.retired === undefined) {
        // an actors stage still building the character finishes first (same directory)
        await note('running', `waiting for the current build of ${name}`);
        await Promise.all(
          plan.scenes
            .filter((sc) => sc.characterIds.includes(characterId))
            .map((sc) => this.chains.get(`${id}:${sc.index}:actors`)),
        );
        fromPlan.retired = (await this.retireActor(st, plan, characterId, log)) ?? '';
        await writeJsonAtomic(markerPath, fromPlan);
        this.actorBuilds.delete(`${id}:${characterId}`);
      }
      // the plan as it is now (the chat may have amended it while this waited)
      plan = (await this.plan(id)) ?? plan;
      character = plan.characters.find((c) => c.id === characterId) ?? character;
      inputs = buildInputs(character);
      const photo = character.referenceImage ? 'from your photo' : '';
      await note(
        'running',
        fromPlan
          ? `rebuilding ${name} ${photo || 'from the plan'} · ~${detail === 'high' ? 5 : 4} min`
          : detail === 'high'
            ? `rebuilding ${name} · ~5 min`
            : `switching ${name} to the standard build`,
      );
      await mkdir(actorDir, { recursive: true });
      const target = character;
      const style = plan.style;
      const raw = await this.actorSem.use(() =>
        this.deps.buildActor({
          character: target,
          projectDir,
          sceneDir: actorDir,
          mock: st.mock,
          detail,
          style,
          log: (m) => {
            log(m);
            const usd = /~\$([0-9.]+) GPU/.exec(m);
            if (usd) cost = Number(usd[1]);
          },
        }),
      );
      const built = await normalizeActor(ActorAsset.parse(raw), actorDir, projectDir);
      // live rebuilds must land a real avatar; MOCK projects only ever have the mannequin
      if (built.kind === 'splat-sequence' ? built.fallback : !st.mock)
        throw new Error(`the ${detail} build came back as a ${built.fallback ? 'fallback ' : ''}${built.kind}`);
      let asset: ActorAsset = built;
      if (built.kind === 'splat-sequence') {
        const { detail: _d, ...plain } = built;
        asset = detail === 'standard' ? plain : { ...plain, detail };
      }
      asset = withHeight(asset, target);
      const referenceSha = await photoSha(projectDir, target);
      await writeJsonAtomic(join(actorDirFor(projectDir, characterId), 'actor.json'), {
        ...asset,
        ...(referenceSha ? { referenceSha } : {}),
      });
      this.actorBuilds.set(`${id}:${characterId}`, Promise.resolve(asset));
      const scenes = await this.pointManifestsAt(st, plan, asset, target);
      // the library holds the screenplay's default people: a photo or an amended plan stays here
      const library =
        fromPlan || target.referenceImage
          ? false
          : await this.refreshLibraryActor(projectDir, asset, log).catch((e) => {
              log(`library copy not refreshed: ${errMsg(e)}`);
              return false;
            });
      entry.detail = detail;
      entry.kind = asset.kind;
      delete entry.fallback;
      const done = [
        `${detail === 'high' ? 'high detail ✓' : 'standard ✓'} in ${fmtDuration(Date.now() - started)}${cost ? ` (~$${cost.toFixed(2)} GPU)` : ''}`,
        photo,
        `${scenes} scene manifest(s) updated`,
        library ? 'library copy refreshed' : '',
        fromPlan?.retired ? `previous build in actors/${characterId}/${fromPlan.retired}/` : '',
      ].filter(Boolean);
      await note('done', done.join(' · '));
      if (fromPlan) await writeJsonAtomic(markerPath, { ...fromPlan, status: 'done' });
      log(`done: ${asset.kind === 'splat-sequence' ? asset.sequenceDir : ''} — ${done.join('; ')}`);
    } catch (e) {
      await note('failed', errMsg(e));
      if (fromPlan) await writeJsonAtomic(markerPath, { ...fromPlan, status: 'failed' }).catch(() => {});
      log(`FAILED ${errMsg(e)} (the current build stays in use)`);
    }
    // the director changed the character while it was being built: once more, from the plan now
    const latest = (await this.plan(id))?.characters.find((c) => c.id === characterId);
    if (latest && buildInputs(latest) !== inputs) {
      log('the character changed in the plan while it was being rebuilt; rebuilding from the current plan');
      await this.rebuildActorFromPlan(id, characterId).catch((e) => log(`not rebuilt again: ${errMsg(e)}`));
    }
  }

  /** The character as the first written manifest showing it has it (what the scene plays now). */
  private async manifestCharacter(id: string, plan: ScreenplayPlan, characterId: string): Promise<Character | undefined> {
    for (const scene of plan.scenes) {
      if (!scene.characterIds.includes(characterId)) continue;
      const m = SceneManifest.safeParse(await readJson(join(this.sceneDir(id, scene.index), 'manifest.json')).catch(() => undefined));
      const c = m.success ? m.data.characters.find((x) => x.id === characterId) : undefined;
      if (c) return c;
    }
    return undefined;
  }

  /**
   * rebuildActorFromPlan: moves actors/<id>/ (all but earlier prev-<k>/ dirs and the rebuild
   * marker) into actors/<id>/prev-<k>/ and points actor.json and every manifest at the moved build,
   * so the scene keeps playing it until the rebuild lands. Returns 'prev-<k>', null when empty.
   */
  private async retireActor(
    st: ProjectStatus,
    plan: ScreenplayPlan,
    characterId: string,
    log: (m: string) => void,
  ): Promise<string | null> {
    const base = join(this.dir(st.id), 'actors', characterId);
    const entries = (await readdir(base).catch(() => [] as string[])).filter(
      (n) => !/^prev-\d+$/.test(n) && n !== REBUILD_FILE,
    );
    if (!entries.length) return null;
    let k = 1;
    while (await exists(join(base, `prev-${k}`))) k++;
    const name = `prev-${k}`;
    await mkdir(join(base, name));
    for (const n of entries) await rename(join(base, n), join(base, name, n));
    const raw = await readJson<{ referenceSha?: string }>(join(base, name, 'actor.json')).catch(() => undefined);
    const cached = ActorAsset.safeParse(raw);
    if (cached.success) {
      const moved = relocateActor(cached.data, `actors/${characterId}/`, `actors/${characterId}/${name}/`);
      await writeJsonAtomic(join(base, 'actor.json'), {
        ...moved,
        ...(raw?.referenceSha ? { referenceSha: raw.referenceSha } : {}),
      });
      await this.pointManifestsAt(st, plan, moved);
    }
    log(`previous build kept in actors/${characterId}/${name}/ (the scenes show it until the new one lands)`);
    return name;
  }

  /**
   * Rewrites every written scene manifest that shows `asset.characterId` to use `asset`, and to
   * carry `character` (the plan's current description / height / photo) when given.
   */
  private async pointManifestsAt(
    st: ProjectStatus,
    plan: ScreenplayPlan,
    asset: ActorAsset,
    character?: Character,
  ): Promise<number> {
    let n = 0;
    for (const scene of plan.scenes) {
      if (!scene.characterIds.includes(asset.characterId)) continue;
      const path = join(this.sceneDir(st.id, scene.index), 'manifest.json');
      const m = SceneManifest.safeParse(await readJson(path).catch(() => undefined));
      if (!m.success) continue;
      const has = m.data.actors.some((a) => a.characterId === asset.characterId);
      const actors = has
        ? m.data.actors.map((a) => (a.characterId === asset.characterId ? asset : a))
        : [...m.data.actors, asset];
      const characters = character
        ? m.data.characters.map((c) => (c.id === character.id ? character : c))
        : m.data.characters;
      await writeJsonAtomic(path, SceneManifest.parse({ ...m.data, actors, characters }));
      n++;
    }
    return n;
  }

  /**
   * An existing actors-library copy of the character (<lib>/<id>/sequence/) becomes the new build,
   * so later projects reuse it; the replaced one is kept as sequence.previous/. Characters without a
   * library copy are left alone (the library is filled by hand, see README).
   */
  private async refreshLibraryActor(projectDir: string, asset: ActorAsset, log: (m: string) => void) {
    if (!this.actorsLibraryDir || asset.kind !== 'splat-sequence') return false;
    const libDir = join(this.actorsLibraryDir, asset.characterId);
    const libSeq = join(libDir, 'sequence');
    const src = resolve(projectDir, asset.sequenceDir);
    if (!(await exists(join(libSeq, 'sequence.json'))) || src === resolve(libSeq)) return false;
    const tmp = join(libDir, `.sequence-${randomBytes(3).toString('hex')}`);
    await cp(src, tmp, { recursive: true, filter: (f) => !/\.(part|tmp)$/.test(f) });
    const previous = join(libDir, 'sequence.previous');
    await rm(previous, { recursive: true, force: true });
    await rename(libSeq, previous);
    await rename(tmp, libSeq);
    log(`library copy ${libSeq} refreshed (previous build kept in sequence.previous/)`);
    return true;
  }

  private async ttsStage(st: ProjectStatus, plan: ScreenplayPlan, scene: ScenePlan): Promise<void> {
    const { id } = st;
    const idx = scene.index;
    if (!scene.dialogue.length)
      return this.setStage(id, idx, 'tts', { status: 'skipped', note: 'no dialogue' });
    const sceneDir = this.sceneDir(id, idx);
    const outDir = join(sceneDir, 'audio');
    const cachePath = join(sceneDir, 'audio.json');
    const projectDir = this.dir(id);
    const cached = new Map(
      (
        LineAudio.array().safeParse(await readJson(cachePath).catch(() => undefined)).data ?? []
      ).map((a) => [a.lineId, a]),
    );
    const todo = scene.dialogue.filter((l) => {
      const c = cached.get(l.id);
      return !c || this.upgradable(st, c, 'tts');
    });
    await this.setStage(id, idx, 'tts', { status: 'running', note: `${todo.length} line(s)` });
    await mkdir(outDir, { recursive: true });
    const chars = this.characterMap(plan);
    const errors: string[] = [];
    const log = this.logger(id, `[scene ${idx}] tts: `);
    await Promise.all(
      todo.map(async (line) => {
        const character = chars.get(line.characterId);
        try {
          if (!character) throw new Error(`unknown character ${line.characterId}`);
          const raw = await this.ttsSem.use(() =>
            this.deps.synthesizeLine({ line, character, outDir, mock: st.mock, log }),
          );
          const audio = LineAudio.parse(raw);
          cached.set(line.id, {
            lineId: line.id,
            url: await toProjectUrl(audio.url, outDir, projectDir),
            durationSeconds: audio.durationSeconds,
            ...(audio.fallback ? { fallback: true } : {}),
          });
        } catch (e) {
          errors.push(`${line.id}: ${errMsg(e)}`);
        }
      }),
    );
    const ordered = scene.dialogue.flatMap((l) => cached.get(l.id) ?? []);
    await writeJsonAtomic(cachePath, ordered);
    if (errors.length) {
      log(`FAILED ${errors.length} line(s): ${errors[0]}`);
      await this.setStage(id, idx, 'tts', {
        status: 'failed',
        note: `${errors.length}/${scene.dialogue.length} line(s) failed — ${errors[0]}`,
      });
    } else {
      const fallbacks = ordered.filter((a) => a.fallback).length;
      await this.setStage(id, idx, 'tts', {
        status: 'done',
        note: `${ordered.length} line(s)${fallbacks ? ` — ${fallbacks} fallback (retry to upgrade)` : ''}`,
      });
    }
  }

  /** Writes the manifest once world/actors/tts have settled and the world exists. */
  private async maybeManifest(id: string, idx: number): Promise<void> {
    const st = await this.load(id);
    const plan = await this.plan(id);
    const job = st?.scenes[idx];
    const scene = plan?.scenes[idx];
    if (!st || !plan || !job || !scene) return;
    const { world, actors, tts } = job.stages;
    if (world.status === 'failed' || world.status === 'skipped') {
      return this.setStage(id, idx, 'manifest', {
        status: 'skipped',
        note: 'world failed; retry the world stage',
      });
    }
    if (!settled(world) || !settled(actors) || !settled(tts)) return;
    try {
      const sceneDir = this.sceneDir(id, idx);
      const projectDir = this.dir(id);
      const rawWorld = WorldAsset.parse(await readJson(join(sceneDir, 'world', ASSET_FILE)));
      const prefix = `scene-${idx}/world/`;
      const worldAsset: WorldAsset = {
        ...rawWorld,
        spz: Object.fromEntries(
          Object.entries(rawWorld.spz).map(([k, v]) => [k, prefix + v]),
        ) as WorldAsset['spz'],
        ...(rawWorld.colliderGlb ? { colliderGlb: prefix + rawWorld.colliderGlb } : {}),
        ...(rawWorld.thumbnail ? { thumbnail: prefix + rawWorld.thumbnail } : {}),
        ...(rawWorld.ground ? { ground: { ...rawWorld.ground, file: prefix + rawWorld.ground.file } } : {}),
      };
      const actorAssets: ActorAsset[] = [];
      const chars = this.characterMap(plan);
      for (const cid of scene.characterIds) {
        const a = ActorAsset.safeParse(
          await readJson(join(projectDir, 'actors', cid, 'actor.json')).catch(() => undefined),
        );
        // the plan is the source of truth for each character's height
        const c = chars.get(cid);
        if (a.success) actorAssets.push(c ? withHeight(a.data, c) : a.data);
      }
      const audio =
        LineAudio.array().safeParse(
          await readJson(join(sceneDir, 'audio.json')).catch(() => undefined),
        ).data ?? [];
      const ids = new Set(scene.characterIds);
      // the staged marks (staging.ts) when they were made for this world and this scene
      const staged = stagedBlocking(await readStaging(sceneDir), {
        asset: rawWorld,
        scene,
        characters: plan.characters,
      });
      const lookSeed = lookSeedFor(scene, styleForPlan(plan));
      // found models that arrived within the scene's budget (late or failed: the procedural body)
      const found = await this.found.attach(scene.dynamics);
      if (found.summary) await this.log(id, `[scene ${idx}] ${found.summary}`);
      const manifest = SceneManifest.parse({
        version: 1,
        projectId: id,
        // the manifest's plan always carries a look (planned or derived) so the laptop's
        // "Scene's look" exists for plans made before looks were planned
        plan: {
          ...(staged ? { ...scene, blocking: staged } : scene),
          dynamics: found.dynamics,
          look: scene.look ?? lookSeed,
        },
        characters: plan.characters.filter((c) => ids.has(c.id)),
        world: worldAsset,
        actors: actorAssets,
        audio,
        startCamera: START_CAMERA,
      });
      await writeJsonAtomic(join(sceneDir, 'manifest.json'), manifest);
      // the scene opens graded with the plan's look; an existing edits.json (the director's) stays
      const seeded = await seedSceneLook(editsStoreFor(this), id, idx, lookSeed).catch(
        (e) => void this.log(id, `[scene ${idx}] look not seeded: ${errMsg(e)}`),
      );
      if (seeded) await this.log(id, `[scene ${idx}] look seeded: ${seeded.look.name}`);
      job.manifestUrl = api.manifest(id, idx);
      const missing = [
        actorAssets.length < ids.size ? `${ids.size - actorAssets.length} actor(s) missing` : '',
        audio.length < scene.dialogue.length
          ? `${scene.dialogue.length - audio.length} line(s) without audio`
          : '',
      ].filter(Boolean);
      await this.setStage(id, idx, 'manifest', {
        status: 'done',
        note: missing.join('; ') || undefined,
      });
      await this.log(
        id,
        `[scene ${idx}] manifest written${missing.length ? ` (${missing.join('; ')})` : ''}`,
      );
    } catch (e) {
      await this.setStage(id, idx, 'manifest', { status: 'failed', note: errMsg(e) });
      await this.log(id, `[scene ${idx}] manifest FAILED ${errMsg(e)}`);
    }
  }
}

/**
 * WP D modules may return paths relative to the dir we gave them, relative to the project, or
 * absolute; manifests need project-root-relative URLs. Web paths ('/assets/…') and http(s) URLs
 * are kept as they are.
 */
export async function toProjectUrl(
  p: string,
  baseDir: string,
  projectDir: string,
): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return p;
  const rel = (abs: string) => relative(projectDir, abs).split(sep).join('/');
  if (isAbsolute(p)) return p.startsWith(projectDir + sep) ? rel(p) : p;
  const fromBase = resolve(baseDir, p);
  if (await exists(fromBase)) return rel(fromBase);
  const fromProject = resolve(projectDir, p);
  if (fromProject.startsWith(projectDir + sep) && (await exists(fromProject)))
    return rel(fromProject);
  return rel(fromBase);
}

async function normalizeActor(
  a: ActorAsset,
  actorDir: string,
  projectDir: string,
): Promise<ActorAsset> {
  return a.kind === 'splat-sequence'
    ? { ...a, sequenceDir: await toProjectUrl(a.sequenceDir, actorDir, projectDir) }
    : { ...a, glb: await toProjectUrl(a.glb, actorDir, projectDir) };
}

// ---------------------------------------------------------------------------
// Default store (env-configured), used by routes.ts and the CLI
// ---------------------------------------------------------------------------

let store: ProjectStore | undefined;
export function defaultStore(o: Partial<StoreOptions> = {}): ProjectStore {
  store ??= new ProjectStore({ dataDir: env.dataDir, mock: env.mock, ...o });
  return store;
}

export const createProject = (input: Parameters<ProjectStore['createProject']>[0]) =>
  defaultStore().createProject(input);
export const getProject = (id: string) => defaultStore().getProject(id);
export const listProjects = () => defaultStore().listProjects();
export const retry = (id: string, sceneIndex: number, stage: StageName) =>
  defaultStore().retry(id, sceneIndex, stage);
export const rebuildActor = (id: string, characterId: string, detail: ActorDetail) =>
  defaultStore().rebuildActor(id, characterId, detail);
export const rebuildActorFromPlan = (id: string, characterId: string) =>
  defaultStore().rebuildActorFromPlan(id, characterId);
export const regenerateWorld = (id: string, sceneIndex: number) =>
  defaultStore().regenerateWorld(id, sceneIndex);
