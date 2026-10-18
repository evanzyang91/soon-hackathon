// Project store + in-process pipeline. Everything lives on disk under <dataDir>/<id>/ and every
// stage is idempotent, so a restart (or a retry) resumes from what is already there:
//
//   project.json            ProjectStatus (what the laptop polls)
//   input.json              { title? } as submitted
//   screenplay.fountain     the submitted text
//   plan.json               ScreenplayPlan (parse stage, once per project)
//   log.txt                 human-readable pipeline log
//   actors/<characterId>/   one actor per character, shared by every scene (actor.json caches it)
//   scene-<n>/world/        Marble outputs + marble-receipt.json + world-asset.json
//   scene-<n>/audio/        one file per dialogue line; scene-<n>/audio.json caches LineAudio[]
//   scene-<n>/manifest.json SceneManifest, written once world/actors/tts have all settled
//
// Per scene, world / actors / tts run concurrently (Marble jobs capped at 3 across the server);
// manifest follows. A failed stage is recorded with a note; the manifest is still written when the
// world succeeded. Asset URLs inside manifests are relative to the project root
// (/projects/<id>/), matching shared/api.ts.
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { api } from '../../shared/api.ts';
import {
  ActorAsset,
  LineAudio,
  ProjectStatus,
  SceneManifest,
  ScreenplayPlan,
  WorldAsset,
  type Character,
  type DialogueLine,
  type ScenePlan,
} from '../../shared/schema.ts';
import { env } from '../env.ts';
import { buildActor } from './actors.ts';
import { parseFountain } from './fountain.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { slugify } from './geometry.ts';
import { ASSET_FILE, generateWorld, type GenerateWorldOptions } from './marble.ts';
import { parseScreenplay } from './screenplay.ts';
import { synthesizeLine } from './tts.ts';

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
  buildActor: (opts: {
    character: Character;
    projectDir: string;
    sceneDir: string;
    mock: boolean;
    log: (m: string) => void;
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
  /** Key presence (never values). Missing keys fall back to offline stages. Defaults to env. */
  keys?: { anthropic: boolean; marble: boolean };
  deps?: Partial<PipelineDeps>;
  maxWorldJobs?: number;
  maxActorJobs?: number;
  maxTtsJobs?: number;
  /** Mirror project log lines to the console (default true). */
  echo?: boolean;
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

function initJob(scene: ScenePlan): SceneJob {
  return {
    sceneIndex: scene.index,
    slug: scene.slug,
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
  private readonly keys: { anthropic: boolean; marble: boolean };
  private readonly deps: PipelineDeps;
  private readonly echo: boolean;
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
    this.keys = o.keys ?? { anthropic: !!env.keys.anthropic, marble: !!env.keys.marble };
    this.deps = {
      parseScreenplay: o.deps?.parseScreenplay ?? parseScreenplay,
      generateWorld: o.deps?.generateWorld ?? generateWorld,
      buildActor: o.deps?.buildActor ?? buildActor,
      synthesizeLine: o.deps?.synthesizeLine ?? synthesizeLine,
    };
    this.echo = o.echo ?? true;
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
        if (redo) await rm(join(this.dir(id), 'actors', cid, 'actor.json'), { force: true });
        if (redo || !(await exists(join(this.dir(id), 'actors', cid, 'actor.json'))))
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

  /** Picks up unfinished work after a restart (call once at startup). */
  async resumeAll(): Promise<string[]> {
    const resumed: string[] = [];
    for (const st of await this.listProjects()) {
      const live = this.statuses.get(st.id)!;
      const unfinished =
        !settled(live.parse) ||
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
      const note =
        asset.provider === 'marble'
          ? `marble world ${asset.worldId ?? ''}`.trim()
          : offline && !st.mock
            ? 'mock world (WLT_API_KEY not set)'
            : 'mock world';
      await this.setStage(id, idx, 'world', { status: 'done', note });
      sceneLog(`done — ${note}`);
    } catch (e) {
      await this.setStage(id, idx, 'world', { status: 'failed', note: errMsg(e) });
      sceneLog(`FAILED ${errMsg(e)}`);
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
    const built = await Promise.all(cast.map((c) => this.actor(st, c)));
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
      await this.setStage(id, idx, 'actors', {
        status: 'done',
        note: `${cast.length} actor(s): ${kinds}`,
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
      if (cached.success) return cached.data;
      await mkdir(actorDir, { recursive: true });
      try {
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
    const todo = scene.dialogue.filter((l) => !cached.has(l.id));
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
      await this.setStage(id, idx, 'tts', { status: 'done', note: `${ordered.length} line(s)` });
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
      const manifest = SceneManifest.parse({
        version: 1,
        projectId: id,
        plan: scene,
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
export function defaultStore(): ProjectStore {
  store ??= new ProjectStore({ dataDir: env.dataDir, mock: env.mock });
  return store;
}

export const createProject = (input: { title?: string; screenplay: string }) =>
  defaultStore().createProject(input);
export const getProject = (id: string) => defaultStore().getProject(id);
export const listProjects = () => defaultStore().listProjects();
export const retry = (id: string, sceneIndex: number, stage: StageName) =>
  defaultStore().retry(id, sceneIndex, stage);
