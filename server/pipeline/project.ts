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
//   scene-<n>/manifest.json SceneManifest, written once world/actors/tts have all settled
//
// A new Marble world is scale-calibrated right after download (calibrate.ts: collider references +
// Claude vision with 1.70 m mannequins) and the result lands in world-asset.json as
// scaleCalibration, also in the world-library copy so reuse carries it. CALIBRATE=0 or
// `calibrate: false` turns it off; a failure never fails the world stage.
//
// Actor rebuilds (rebuildActor, POST /api/projects/:id/actors/:characterId/rebuild) run one
// character in the background at a detail level, recorded in ProjectStatus.actors[].rebuild; the
// current build stays in the manifests until the new one is ready, then every scene manifest
// showing the character is rewritten to it. A failure changes nothing but the note.
//
// Per scene, world / actors / tts run concurrently (Marble jobs capped at 3 across the server);
// manifest follows. A failed stage is recorded with a note; the manifest is still written when the
// world succeeded. Asset URLs inside manifests are relative to the project root
// (/projects/<id>/), matching shared/api.ts.
import { randomBytes } from 'node:crypto';
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
} from '../../shared/schema.ts';
import { env, keyPresence } from '../env.ts';
import { resolveSceneMotion } from './motion.ts';
import { copyLibraryActor, findLibraryActor } from './actor-library.ts';
import { actorDirFor, buildActor } from './actors.ts';
import {
  calibrateWorld,
  previousCalibration,
  redecide,
  withGround,
  writeCalibration,
  type CalibrateOptions,
  type CalibrationReport,
} from './calibrate.ts';
import { parseFountain } from './fountain.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { slugify } from './geometry.ts';
import { ASSET_FILE, generateWorld, RECEIPT_FILE, type GenerateWorldOptions } from './marble.ts';
import { parseScreenplay } from './screenplay.ts';
import { synthesizeLine } from './tts.ts';
import { copyLibraryWorld, findLibraryWorld } from './world-library.ts';

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

export interface PipelineDeps {
  parseScreenplay: (
    text: string,
    opts: { mock: boolean; log: (m: string) => void; title?: string },
  ) => Promise<ScreenplayPlan>;
  generateWorld: (opts: GenerateWorldOptions) => Promise<WorldAsset>;
  calibrateWorld: (worldDir: string, opts: CalibrateOptions) => Promise<CalibrationReport>;
  buildActor: (opts: {
    character: Character;
    projectDir: string;
    sceneDir: string;
    mock: boolean;
    log: (m: string) => void;
    /** 'high' (rebuilds only): LHM-1B + fine-tune into actors/<id>/high/; throws on failure. */
    detail?: ActorDetail;
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
  /** Scale-calibrate new Marble worlds after download (default env CALIBRATE, on). */
  calibrate?: boolean;
  /** Include the Claude-vision half when the Anthropic key is set (default env CALIBRATE_VISION). */
  calibrateVision?: boolean;
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
  private readonly worldSem: Semaphore;
  private readonly actorSem: Semaphore;
  private readonly ttsSem: Semaphore;

  private readonly statuses = new Map<string, ProjectStatus>();
  private readonly plans = new Map<string, ScreenplayPlan>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queued = new Set<string>();
  private readonly actorBuilds = new Map<string, Promise<ActorAsset | undefined>>();
  private readonly actorErrors = new Map<string, string>();
  private readonly worldRetryFailed = new Set<string>();
  private active = 0;
  private idleWaiters: (() => void)[] = [];

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
      buildActor: o.deps?.buildActor ?? buildActor,
      synthesizeLine: o.deps?.synthesizeLine ?? synthesizeLine,
    };
    this.echo = o.echo ?? true;
    this.calibrate = o.calibrate ?? env.calibrate;
    this.calibrateVision = o.calibrateVision ?? env.calibrateVision;
    this.worldSem = new Semaphore(o.maxWorldJobs ?? 3);
    this.actorSem = new Semaphore(o.maxActorJobs ?? 2);
    this.ttsSem = new Semaphore(o.maxTtsJobs ?? 4);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async createProject(input: { title?: string; screenplay: string }): Promise<ProjectStatus> {
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
    };
    this.statuses.set(id, status);
    await this.persist(id);
    await this.log(
      id,
      `project created (${screenplay.length} chars, ${this.mock ? 'MOCK' : 'live'})`,
    );
    this.enqueue(id, () => this.runParse(id));
    return structuredClone(status);
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
    const log = this.logger(id, `[scene ${sceneIndex}] regen: `);
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
      await this.worldDone(st, sceneIndex, cal.asset, made.note + cal.note);
      result = { ok: true, note: made.note + cal.note };
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
        st.scenes = plan.scenes.map(initJob);
        const note = `${plan.scenes.length} scene(s), ${plan.characters.length} character(s)${offline && !st.mock ? ' (offline parser: ANTHROPIC_API_KEY not set)' : ''}`;
        st.parse = { status: 'done', note };
        await this.persist(id);
        await this.log(id, `parse: done — ${note}`);
      } catch (e) {
        st.parse = { status: 'failed', note: errMsg(e) };
        await this.persist(id);
        await this.log(id, `parse: FAILED ${errMsg(e)}`);
        return;
      }
    }
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
    await this.setStage(id, idx, 'world', { status: 'running', note: 'queued' });
    try {
      const reused = await this.libraryWorld(st, scene, outDir, sceneLog);
      if (reused) {
        const cal = await this.calibrateStep(st, scene, outDir, reused.asset, sceneLog);
        await this.worldDone(st, idx, cal.asset, `reused library world ${reused.id}${cal.note}`);
        return;
      }
      const asset = await this.worldSem.use(async () => {
        await this.setStage(id, idx, 'world', {
          status: 'running',
          note: offline ? 'copying mock world' : 'generating with Marble (~5 min)',
        });
        return this.deps.generateWorld({
          prompt: scene.worldPrompt,
          name: `${st.title} · ${scene.heading}`,
          outDir,
          model: this.model,
          mock: offline,
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
      const note =
        asset.provider === 'marble'
          ? `marble world ${asset.worldId ?? ''}`.trim()
          : st.mock
            ? 'mock world'
            : offline
              ? 'mock world (WLT_API_KEY not set)'
              : 'mock world (MARBLE_DRY_RUN: request logged, not submitted)';
      await this.worldDone(st, idx, cal.asset, note + cal.note);
    } catch (e) {
      await this.setStage(id, idx, 'world', { status: 'failed', note: errMsg(e) });
      sceneLog(`FAILED ${errMsg(e)}`);
    }
  }

  /**
   * Live Marble worlds only: measures the scale once (an existing scaleCalibration, e.g. carried
   * by a library copy, or a previous scale-calibration.json for the same world id is reused) and
   * writes it into world-asset.json and the library copy. Never throws.
   */
  private async calibrateStep(
    st: ProjectStatus,
    scene: ScenePlan,
    outDir: string,
    asset: WorldAsset,
    log: (m: string) => void,
  ): Promise<{ asset: WorldAsset; note: string }> {
    if (!this.calibrate || st.mock || asset.provider !== 'marble') return { asset, note: '' };
    const marks = scene.blocking.map((b) => [b.position[0], b.position[2]] as const);
    if (asset.scaleCalibration) {
      // carried by a library copy: re-decided from its stored report (no Claude call), with the
      // visible ground measured where this scene's actors stand (local, ~2 s)
      try {
        const prev = await previousCalibration(outDir, asset.worldId);
        if (!prev) return { asset, note: '' };
        const report = await withGround(redecide(prev), outDir, marks);
        if (asset.scaleCalibration.headline && asset.floorOffsetMeters === report.floorOffsetMeters)
          return { asset, note: '' };
        return { asset: await writeCalibration(outDir, report, { log }), note: '' };
      } catch (e) {
        log(`floor offset not measured: ${errMsg(e)}`);
        return { asset, note: '' };
      }
    }
    try {
      let report = await previousCalibration(outDir, asset.worldId);
      if (report) report = await withGround(report, outDir, marks);
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
      const next = await writeCalibration(outDir, report, { libraryDir: this.libraryDir, log });
      const c = report.calibration;
      log(`scale calibration: ×${c.factor} (${c.confidence}, ${c.method}): ${c.evidence}`);
      return { asset: next, note: `; scale ×${c.factor.toFixed(2)} (${c.confidence})` };
    } catch (e) {
      log(`scale calibration failed: ${errMsg(e)}; Marble scale kept`);
      return { asset, note: '' };
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
    const built = await Promise.all(cast.map((c) => this.actor(st, c)));
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
  private actor(st: ProjectStatus, character: Character): Promise<ActorAsset | undefined> {
    const key = `${st.id}:${character.id}`;
    const existing = this.actorBuilds.get(key);
    if (existing) return existing;
    const projectDir = this.dir(st.id);
    const actorDir = join(projectDir, 'actors', character.id);
    const cachePath = join(actorDir, 'actor.json');
    const log = this.logger(st.id, `actor ${character.id}: `);
    const p = (async () => {
      const cached = ActorAsset.safeParse(await readJson(cachePath).catch(() => undefined));
      if (cached.success && !this.upgradable(st, cached.data, 'modal')) return cached.data;
      if (cached.success) log('cached actor is a fallback and Modal keys are set; rebuilding');
      await mkdir(actorDir, { recursive: true });
      try {
        const found =
          !st.mock && this.actorsLibraryDir
            ? await findLibraryActor(this.actorsLibraryDir, character.id, log)
            : null;
        if (found) {
          const asset = await copyLibraryActor(found, projectDir);
          await writeJsonAtomic(cachePath, asset);
          this.actorErrors.delete(key);
          this.libraryActors.add(key);
          log(`reused library actor ${found.sequenceDir} (no Modal call)`);
          return asset;
        }
        const raw = await this.actorSem.use(() =>
          this.deps.buildActor({ character, projectDir, sceneDir: actorDir, mock: st.mock, log }),
        );
        const asset = await normalizeActor(ActorAsset.parse(raw), actorDir, projectDir);
        await writeJsonAtomic(cachePath, asset);
        this.actorErrors.delete(key);
        log(`ready (${asset.kind})`);
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
      out.push(actorBuildStatus(c, cached.success ? cached.data : undefined, prev.get(c.id)?.rebuild));
    }
    st.actors = out;
  }

  private async runRebuild(id: string, characterId: string): Promise<void> {
    const st = await this.load(id);
    const plan = await this.plan(id);
    const entry = st?.actors?.find((a) => a.characterId === characterId);
    const character = plan?.characters.find((c) => c.id === characterId);
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
    await note(
      'running',
      detail === 'high' ? `rebuilding ${name} · ~5 min` : `switching ${name} to the standard build`,
    );
    let cost: number | undefined;
    try {
      await mkdir(actorDir, { recursive: true });
      const raw = await this.actorSem.use(() =>
        this.deps.buildActor({
          character,
          projectDir,
          sceneDir: actorDir,
          mock: false,
          detail,
          log: (m) => {
            log(m);
            const usd = /~\$([0-9.]+) GPU/.exec(m);
            if (usd) cost = Number(usd[1]);
          },
        }),
      );
      const built = await normalizeActor(ActorAsset.parse(raw), actorDir, projectDir);
      if (built.kind !== 'splat-sequence' || built.fallback)
        throw new Error(`the ${detail} build came back as a ${built.fallback ? 'fallback ' : ''}${built.kind}`);
      const { detail: _d, ...plain } = built;
      const asset: ActorAsset = detail === 'standard' ? plain : { ...plain, detail };
      await writeJsonAtomic(join(actorDirFor(projectDir, characterId), 'actor.json'), asset);
      this.actorBuilds.set(`${id}:${characterId}`, Promise.resolve(asset));
      const scenes = await this.pointManifestsAt(st, plan, asset);
      const library = await this.refreshLibraryActor(projectDir, asset, log).catch((e) => {
        log(`library copy not refreshed: ${errMsg(e)}`);
        return false;
      });
      entry.detail = detail;
      entry.kind = asset.kind;
      delete entry.fallback;
      const done = [
        `${detail === 'high' ? 'high detail ✓' : 'standard ✓'} in ${fmtDuration(Date.now() - started)}${cost ? ` (~$${cost.toFixed(2)} GPU)` : ''}`,
        `${scenes} scene manifest(s) updated`,
        library ? 'library copy refreshed' : '',
      ].filter(Boolean);
      await note('done', done.join(' · '));
      log(`done: ${asset.kind === 'splat-sequence' ? asset.sequenceDir : ''} — ${done.join('; ')}`);
    } catch (e) {
      await note('failed', errMsg(e));
      log(`FAILED ${errMsg(e)} (the current build stays in use)`);
    }
  }

  /** Rewrites every written scene manifest that shows `asset.characterId` to use `asset`. */
  private async pointManifestsAt(st: ProjectStatus, plan: ScreenplayPlan, asset: ActorAsset): Promise<number> {
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
      await writeJsonAtomic(path, SceneManifest.parse({ ...m.data, actors }));
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
      };
      const actorAssets: ActorAsset[] = [];
      for (const cid of scene.characterIds) {
        const a = ActorAsset.safeParse(
          await readJson(join(projectDir, 'actors', cid, 'actor.json')).catch(() => undefined),
        );
        if (a.success) actorAssets.push(a.data);
      }
      const audio =
        LineAudio.array().safeParse(
          await readJson(join(sceneDir, 'audio.json')).catch(() => undefined),
        ).data ?? [];
      const ids = new Set(scene.characterIds);
      // beat gestures → clips (generated on Modal with MOTION_GEN=1, else the shared clips)
      const motion = await resolveSceneMotion(scene, {
        sceneDir,
        sceneRel: `scene-${idx}`,
        cacheDir: env.motionCacheDir,
        generate: env.motionGen && !this.mock && !!this.keys.modal,
        log: (m) => void this.log(id, `[scene ${idx}] ${m}`),
      });
      const manifest = SceneManifest.parse({
        version: 1,
        projectId: id,
        plan: motion.scene,
        ...(motion.motion ? { motion: motion.motion } : {}),
        characters: plan.characters.filter((c) => ids.has(c.id)),
        world: worldAsset,
        actors: actorAssets,
        audio,
        startCamera: START_CAMERA,
      });
      await writeJsonAtomic(join(sceneDir, 'manifest.json'), manifest);
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

export const createProject = (input: { title?: string; screenplay: string }) =>
  defaultStore().createProject(input);
export const getProject = (id: string) => defaultStore().getProject(id);
export const listProjects = () => defaultStore().listProjects();
export const retry = (id: string, sceneIndex: number, stage: StageName) =>
  defaultStore().retry(id, sceneIndex, stage);
export const rebuildActor = (id: string, characterId: string, detail: ActorDetail) =>
  defaultStore().rebuildActor(id, characterId, detail);
