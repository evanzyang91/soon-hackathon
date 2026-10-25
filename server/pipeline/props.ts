// Props by prompt (docs/PLAN-v4.md "Props by import or by prompt"): a description becomes a glTF
// binary the laptop places as a `prop-add` scene edit of kind 'model'.
//
//   POST /api/projects/:id/props/generate   body { prompt (≤ 300 chars), sceneIndex } → 202 PropJob
//   GET  /api/projects/:id/props/:jobId     → PropJob
//
// Each job lives in <project>/props/<jobId>/: job.json (shared/schema.ts PropJob, rewritten at every
// step), reference.png and model.glb. At most MAX_PROP_JOBS run per project at once (429 beyond).
//
// Live (keys present, project not MOCK):
//   1. reference image: OpenAI images/generations (the actors' helper, openai-image.ts), the object
//      alone on plain white, 1024×1024 → props/<jobId>/reference.png
//   2. image-to-3D: `python3 worker/run_prop.py --image reference.png --out model.glb` (TripoSR on a
//      Modal L4, worker/modal_prop.py) → props/<jobId>/model.glb, vertex-coloured, Y up, front +Z
//   3. model = { file, heightM (a size hint in the prompt: "a 2 m tall …", else 1 m), source: prompt }
// MOCK or a missing OpenAI / Modal key: fixtures/props/sample.glb after ~2 s, with notes that say so.
// Failures end as status 'failed' with the error (no silent stand-in on a live run). A job still
// pending / running on disk that this process is not running (a restart) reads back as failed.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PropJob, type ProjectStatus, type PropModel } from '../../shared/schema.ts';
import { env } from '../env.ts';
import { IMAGE_MODELS } from './actors.ts';
import { exists, readJson, writeFileAtomic, writeJsonAtomic } from './fsutil.ts';
import { imageCostUsd, openaiImageGenerate } from './openai-image.ts';
import { isProjectId } from './project.ts';

export const PROPS_DIR = 'props';
/** Generations running at once per project. */
export const MAX_PROP_JOBS = 2;
export const MAX_PROMPT_CHARS = 300;
/** Standing height when the prompt gives none (PropModel.heightM absent = 1 m in the viewer too). */
export const DEFAULT_PROP_HEIGHT = 1;
const JOB_ID = /^[a-z0-9]{4,16}-[0-9a-f]{6}$/;
const MAX_BODY = 16 * 1024;
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const RUN_PROP = join(REPO, 'worker', 'run_prop.py');
export const SAMPLE_GLB = join(REPO, 'fixtures', 'props', 'sample.glb');
const IMAGE_QUALITY = () => process.env.PROP_IMAGE_QUALITY ?? 'medium';

export const isPropJobId = (id: string) => JOB_ID.test(id);
export const propJobDir = (projectDir: string, jobId: string) => join(projectDir, PROPS_DIR, jobId);

/** The image prompt: the object alone, as image-to-3D wants it. */
export function propImagePrompt(prompt: string): string {
  const object = prompt.trim().replace(/[.\s]+$/, '');
  return [
    `Product photograph of ${object}.`,
    'The object alone, centred in the frame with margin around it, in full view (nothing cropped),',
    'seen from the front and slightly above, on a plain white seamless background, soft even studio light,',
    'no cast shadow, no other objects, no text, photoreal.',
  ].join(' ');
}

const UNIT_METRES: [RegExp, number][] = [
  [/^(m|metres?|meters?)$/, 1],
  [/^(cm|centimet(re|er)s?)$/, 0.01],
  [/^(mm|millimet(re|er)s?)$/, 0.001],
  [/^(ft|feet|foot|')$/, 0.3048],
  [/^(in|inch|inches|")$/, 0.0254],
];

/**
 * A standing height from the prompt ("a 2 m tall barrel", "6-foot statue", "a 50 cm vase"), in
 * metres, or undefined. A length followed by wide / long / deep / across is not a height.
 */
export function heightHint(prompt: string): number | undefined {
  const re = /(\d+(?:[.,]\d+)?)\s*-?\s*(m|metres?|meters?|cm|centimet(?:re|er)s?|mm|millimet(?:re|er)s?|ft|feet|foot|'|in|inch|inches|")(?![a-z])(\s+(?:tall|high|wide|long|deep|across|in\s+diameter))?/gi;
  for (const m of prompt.matchAll(re)) {
    if (m[3] && !/tall|high/i.test(m[3])) continue;
    const unit = m[2]!.toLowerCase();
    // "in" only counts as inches when it is spelt as a measure ("12 in tall"), not "2 in the ..."
    if (unit === 'in' && !m[3]) continue;
    const k = UNIT_METRES.find(([u]) => u.test(unit))?.[1];
    const v = Number(m[1]!.replace(',', '.'));
    if (!k || !(v > 0)) continue;
    return Math.min(100, Math.max(0.05, Math.round(v * k * 1000) / 1000));
  }
  return undefined;
}

export class PropsError extends Error {
  constructor(
    readonly status: 400 | 404 | 405 | 413 | 429,
    message: string,
  ) {
    super(message);
  }
}

/** What the jobs need from the project store (server/pipeline/project.ts ProjectStore). */
export interface PropHost {
  projectDir(id: string): string;
  getProject(id: string): Promise<ProjectStatus | undefined>;
  logEvent(id: string, message: string): Promise<void>;
}

export interface PropWorkerResult {
  ok: boolean;
  code: number;
  result?: Record<string, unknown> & { error?: string };
}

export interface PropDeps {
  /** Server-wide MOCK (a project created under MOCK is offline too). */
  mock: boolean;
  keys: { openai: boolean; modal: boolean };
  generateImage(prompt: string, log: (m: string) => void): Promise<{ png: Buffer; model: string; costUsd: number }>;
  /** worker/run_prop.py with `args`; `onLine` sees its output lines (progress notes). */
  runWorker(args: string[], onLine: (line: string) => void): Promise<PropWorkerResult>;
  sampleGlb: string;
  /** How long the MOCK "generation" takes (default 2 s). */
  mockDelayMs: number;
}

const defaultDeps = (): PropDeps => ({
  mock: env.mock,
  keys: {
    openai: !!env.keys.openai,
    modal: (!!env.keys.modalTokenId && !!env.keys.modalTokenSecret) || !!process.env.MODAL_PROFILE,
  },
  generateImage: async (prompt, log) => {
    const quality = IMAGE_QUALITY();
    const r = await openaiImageGenerate({
      prompt,
      models: process.env.PROP_IMAGE_MODEL ? [process.env.PROP_IMAGE_MODEL] : IMAGE_MODELS,
      size: '1024x1024',
      quality,
      log,
      what: 'prop reference image',
    });
    return { png: r.png, model: r.model, costUsd: imageCostUsd(r, quality) };
  },
  runWorker: (args, onLine) => runPropCli(args, onLine, Number(process.env.PROP_TIMEOUT_MS ?? 15 * 60_000)),
  sampleGlb: SAMPLE_GLB,
  mockDelayMs: Number(process.env.PROP_MOCK_DELAY_MS ?? 2000),
});

async function pythonBin(): Promise<string> {
  const pinned = process.env.PROP_PYTHON ?? process.env.ACTOR_PYTHON;
  if (pinned) return pinned;
  const venv = join(REPO, 'worker', '.venv', 'bin', 'python');
  return (await exists(venv)) ? venv : 'python3';
}

/** Runs worker/run_prop.py; the last `RESULT {json}` line is the outcome. */
async function runPropCli(args: string[], onLine: (line: string) => void, timeoutMs: number): Promise<PropWorkerResult> {
  const python = await pythonBin();
  return new Promise((resolve) => {
    const child = spawn(python, [RUN_PROP, ...args], {
      cwd: REPO,
      env: {
        ...process.env,
        MODAL_TOKEN_ID: env.keys.modalTokenId,
        MODAL_TOKEN_SECRET: env.keys.modalTokenSecret,
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let result: PropWorkerResult['result'];
    let tail = '';
    const onData = (chunk: Buffer) => {
      tail += chunk.toString();
      const lines = tail.split('\n');
      tail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('RESULT ')) {
          try {
            result = JSON.parse(line.slice(7));
          } catch {
            /* keep the last parseable one */
          }
        } else if (line.trim()) onLine(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      onLine(`[prop] local wait timed out after ${Math.round(timeoutMs / 1000)}s`);
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, result: { error: `${python}: ${err.message}` } });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (tail.startsWith('RESULT ')) onData(Buffer.from('\n'));
      resolve({ ok: code === 0 && !!result?.ok, code: code ?? -1, result });
    });
  });
}

const GenerateBody = z.object({
  prompt: z.string(),
  sceneIndex: z.number().int().nonnegative(),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const newJobId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

export class PropJobs {
  private readonly jobs = new Map<string, PropJob>();
  private readonly running = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly deps: PropDeps;

  constructor(
    private readonly host: PropHost,
    deps: Partial<PropDeps> = {},
  ) {
    this.deps = { ...defaultDeps(), ...deps };
  }

  /** Validates the request, stores the job (pending) and starts it; resolves with the job. */
  async create(projectId: string, body: unknown): Promise<PropJob> {
    const parsed = GenerateBody.safeParse(body);
    if (!parsed.success)
      throw new PropsError(400, parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    const prompt = parsed.data.prompt.replace(/\s+/g, ' ').trim();
    if (!prompt) throw new PropsError(400, 'prompt: describe the object ("a weathered wooden barrel")');
    if (prompt.length > MAX_PROMPT_CHARS) throw new PropsError(400, `prompt: at most ${MAX_PROMPT_CHARS} characters`);
    const st = isProjectId(projectId) ? await this.host.getProject(projectId) : undefined;
    if (!st) throw new PropsError(404, 'no such project');
    const { sceneIndex } = parsed.data;
    if (!st.scenes.some((s) => s.sceneIndex === sceneIndex)) throw new PropsError(400, `sceneIndex: the project has no scene ${sceneIndex}`);
    const busy = [...this.running].filter((k) => k.startsWith(`${projectId}/`)).length;
    if (busy >= MAX_PROP_JOBS)
      throw new PropsError(429, `${busy} props are already being generated for this project; wait for one to finish`);
    const job: PropJob = PropJob.parse({
      id: newJobId(),
      projectId,
      sceneIndex,
      prompt,
      status: 'pending',
      note: 'queued',
      startedAt: new Date().toISOString(),
    });
    const key = `${projectId}/${job.id}`;
    this.running.add(key);
    this.jobs.set(key, job);
    await mkdir(propJobDir(this.host.projectDir(projectId), job.id), { recursive: true });
    await this.persist(projectId, job);
    const offline = this.deps.mock || st.mock ? 'MOCK' : !this.deps.keys.openai ? 'no OpenAI key' : !this.deps.keys.modal ? 'no Modal key' : null;
    await this.host.logEvent(projectId, `prop ${job.id}: generating "${prompt}"${offline ? ` (${offline}: the sample model)` : ''}`);
    void this.run(projectId, job.id, offline).finally(() => this.running.delete(key));
    return structuredClone(job);
  }

  /** The job as stored; a pending / running job no process is working on reads back as failed. */
  async get(projectId: string, jobId: string): Promise<PropJob | undefined> {
    if (!isProjectId(projectId) || !isPropJobId(jobId)) return undefined;
    const key = `${projectId}/${jobId}`;
    const cached = this.jobs.get(key);
    if (cached) return structuredClone(cached);
    const raw = await readJson(join(propJobDir(this.host.projectDir(projectId), jobId), 'job.json')).catch(() => undefined);
    const parsed = PropJob.safeParse(raw);
    if (!parsed.success) return undefined;
    const job = parsed.data;
    if ((job.status === 'pending' || job.status === 'running') && !this.running.has(key)) {
      const failed: PropJob = {
        ...job,
        status: 'failed',
        error: 'interrupted: the server restarted while this prop was being generated; try again',
        finishedAt: job.finishedAt ?? new Date().toISOString(),
      };
      this.jobs.set(key, failed);
      await this.persist(projectId, failed);
      return structuredClone(failed);
    }
    this.jobs.set(key, job);
    return structuredClone(job);
  }

  /** Resolves when this process has no job running (tests, CLI). */
  async idle(): Promise<void> {
    while (this.running.size) await sleep(50);
    await Promise.all(this.writes.values());
  }

  private async update(projectId: string, jobId: string, patch: Partial<PropJob>): Promise<PropJob> {
    const key = `${projectId}/${jobId}`;
    const next = PropJob.parse({ ...this.jobs.get(key)!, ...patch });
    this.jobs.set(key, next);
    await this.persist(projectId, next);
    return next;
  }

  /** Serialised atomic writes of job.json (the latest state wins). */
  private persist(projectId: string, job: PropJob): Promise<void> {
    const key = `${projectId}/${job.id}`;
    const path = join(propJobDir(this.host.projectDir(projectId), job.id), 'job.json');
    const prev = this.writes.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => writeJsonAtomic(path, this.jobs.get(key) ?? job));
    this.writes.set(key, next);
    void next.finally(() => this.writes.get(key) === next && this.writes.delete(key)).catch(() => undefined);
    return next;
  }

  private async run(projectId: string, jobId: string, offline: string | null): Promise<void> {
    const dir = propJobDir(this.host.projectDir(projectId), jobId);
    const rel = `${PROPS_DIR}/${jobId}`;
    const job = this.jobs.get(`${projectId}/${jobId}`)!;
    const log = (m: string) => void this.host.logEvent(projectId, `prop ${jobId}: ${m}`).catch(() => undefined);
    const model = (): PropModel => ({
      file: `${rel}/model.glb`,
      heightM: heightHint(job.prompt) ?? DEFAULT_PROP_HEIGHT,
      source: job.prompt.slice(0, 200),
    });
    const t0 = Date.now();
    let cost = 0;
    try {
      if (offline) {
        const why = offline === 'MOCK' ? 'mock' : offline;
        await this.update(projectId, jobId, { status: 'running', note: `${why}: sample model (no image, no Modal call)` });
        await sleep(this.deps.mockDelayMs);
        await copyFile(this.deps.sampleGlb, join(dir, 'model.glb'));
        const size = (await stat(join(dir, 'model.glb'))).size;
        await this.update(projectId, jobId, {
          status: 'done',
          note: `${why}: sample model`,
          model: model(),
          costUsd: 0,
          finishedAt: new Date().toISOString(),
        });
        log(`done (${why}: the sample model, ${size} bytes)`);
        return;
      }
      // 1. the object, alone, on white
      await this.update(projectId, jobId, { status: 'running', note: 'drawing the reference image' });
      const image = await this.deps.generateImage(propImagePrompt(job.prompt), log);
      cost += image.costUsd;
      await writeFileAtomic(join(dir, 'reference.png'), image.png);
      await this.update(projectId, jobId, {
        note: 'meshing on Modal (TripoSR on an L4; a cold start adds a minute or two)',
        image: `${rel}/reference.png`,
        costUsd: round4(cost),
      });
      // 2. image-to-3D on Modal; "[prop] <stage>" lines become the job's note
      let lastNote = 0;
      const outcome = await this.deps.runWorker(
        ['--image', join(dir, 'reference.png'), '--out', join(dir, 'model.glb'), '--report', join(dir, 'modal-run.json')],
        (line) => {
          // the wrapper's own lines and the container's (streamed through, maybe prefixed)
          const stage = /\[prop\]\s*(.+)$/.exec(line.trim())?.[1];
          if (!stage) return;
          log(`modal: ${stage.slice(0, 200)}`);
          if (Date.now() - lastNote < 300) return;
          lastNote = Date.now();
          void this.update(projectId, jobId, { note: `meshing on Modal: ${stage.slice(0, 120)}` }).catch(() => undefined);
        },
      );
      const gpu = Number(outcome.result?.estimatedComputeUSD);
      if (Number.isFinite(gpu)) cost += gpu;
      if (!outcome.ok) throw new Error(String(outcome.result?.error ?? `worker exited ${outcome.code}`).slice(0, 400));
      const glb = await readFile(join(dir, 'model.glb'));
      if (glb.toString('latin1', 0, 4) !== 'glTF') throw new Error('the worker reported success but model.glb is not a glTF binary');
      const faces = Number(outcome.result?.faces);
      await this.update(projectId, jobId, {
        status: 'done',
        note: `ready${Number.isFinite(faces) ? `: ${Math.round(faces / 1000)}k triangles` : ''}, ${(glb.length / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)} s`,
        model: model(),
        costUsd: round4(cost),
        finishedAt: new Date().toISOString(),
      });
      log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s (~$${cost.toFixed(3)}: image ${image.model} + GPU)`);
    } catch (e) {
      const error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      log(`failed: ${error}`);
      await this.update(projectId, jobId, {
        status: 'failed',
        note: 'failed',
        error,
        ...(cost ? { costUsd: round4(cost) } : {}),
        finishedAt: new Date().toISOString(),
      }).catch(() => undefined);
    }
  }
}

// ---- HTTP -----------------------------------------------------------------------------------------

/** ['api','projects',id,'props','generate' | jobId] → route, else null. */
export function propsRoute(parts: string[]): { projectId: string; jobId: string | null } | null {
  if (parts.length !== 5 || parts[0] !== 'api' || parts[1] !== 'projects' || parts[3] !== 'props') return null;
  const projectId = decodeURIComponent(parts[2]!);
  return parts[4] === 'generate' ? { projectId, jobId: null } : { projectId, jobId: decodeURIComponent(parts[4]!) };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? NaN) > MAX_BODY) {
    req.resume();
    throw new PropsError(413, `body over ${MAX_BODY} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      req.resume();
      throw new PropsError(413, `body over ${MAX_BODY} bytes`);
    }
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new PropsError(400, 'JSON body required');
  try {
    return JSON.parse(text);
  } catch {
    throw new PropsError(400, 'body is not valid JSON');
  }
}

export async function handlePropsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  jobs: PropJobs,
): Promise<boolean> {
  const route = propsRoute(parts);
  if (!route) return false;
  const method = req.method ?? 'GET';
  try {
    if (route.jobId === null) {
      if (method !== 'POST') {
        req.resume();
        send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return true;
      }
      const job = await jobs.create(route.projectId, await readBody(req));
      send(res, 202, job, { location: `/api/projects/${route.projectId}/props/${job.id}` });
      return true;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      req.resume();
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
      return true;
    }
    const job = await jobs.get(route.projectId, route.jobId);
    if (!job) send(res, 404, { error: 'no such prop job' });
    else send(res, 200, job);
    return true;
  } catch (e) {
    if (e instanceof PropsError) {
      send(res, e.status, { error: e.message });
      return true;
    }
    throw e;
  }
}

const stores = new WeakMap<object, PropJobs>();
/** One PropJobs per project store (tests bring their own). */
export function propJobsFor(host: PropHost): PropJobs {
  let j = stores.get(host);
  if (!j) stores.set(host, (j = new PropJobs(host)));
  return j;
}
