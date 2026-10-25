// POST /api/projects/:id/scenes/:n/reprompt  and  POST /api/projects/:id/scenes/:n/regen
// (shared/api.ts). Registered from server/pipeline/routes.ts.
//
// reprompt: plans the prompt (planner.ts). Cheap scopes (look / transform / prop / splat-region
//   with a 3D target) are appended to scene-<n>/edits.json right away (EditsStore.update: revision
//   bump + a history entry with the prompt); world-regen and clarify come back unapplied, and so
//   do region ops still waiting for a target. Response: { plan, edits, targets?, applied, notes }.
//   Vision boxes are on the plan (needsTarget[].box + confidence); `targets` repeats them flat.
// regen: runs the world stage again for the scene from the confirmed plan.regen (regen.ts) in the
//   background → 202 ProjectStatus. When the new world is in place, region edits are dropped from
//   edits.json with a note in its history (look, actors, props, moves are kept). Idempotent per
//   (method, prompt): a repeated request while it runs, or after it finished, starts nothing.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { EditPlan, RegionShape, type SceneEdits } from '../../../shared/look.ts';
import { Quat, ScreenplayPlan, Vec3 } from '../../../shared/schema.ts';
import { env } from '../../env.ts';
import { editsStoreFor, EditsNotFound } from '../edits.ts';
import { readJson } from '../fsutil.ts';
import { pickMockSet } from '../mock-set.ts';
import { PipelineError, isProjectId, type ProjectStore } from '../project.ts';
import { appendOps } from '../../../web/src/viewer/edits/model.ts';
import { loadSceneContext } from './context.ts';
import { planEdit, type PlanInput } from './planner.ts';
import { dropRegionEdits, markRegenDone, produceRegenWorld, regenKey, regenStatus, type ProduceOptions } from './regen.ts';

const MAX_BODY = 1024 * 1024;

const RepromptBody = z.object({
  prompt: z.string().trim().min(1, 'prompt is required').max(1000),
  selection: z
    .object({
      point: Vec3.optional(),
      region: z.object({ center: Vec3, size: Vec3, shape: RegionShape }).optional(),
    })
    .optional(),
  view: z
    .object({
      image: z.string().max(420_000, 'view image over 300 KB'),
      position: Vec3,
      quaternion: Quat,
      fovDeg: z.number().min(5).max(150),
      aspect: z.number().positive(),
    })
    .optional(),
});
const RegenBody = z.object({ plan: EditPlan.shape.regen.unwrap() });

/** ['api','projects',id,'scenes',n,'reprompt'|'regen'] → route, else null. */
export function repromptRoute(parts: string[]): { projectId: string; sceneIndex: number; action: 'reprompt' | 'regen' } | null {
  if (parts.length !== 6 || parts[0] !== 'api' || parts[1] !== 'projects' || parts[3] !== 'scenes') return null;
  if (!/^\d{1,4}$/.test(parts[4] ?? '')) return null;
  const action = parts[5];
  if (action !== 'reprompt' && action !== 'regen') return null;
  return { projectId: decodeURIComponent(parts[2]!), sceneIndex: Number(parts[4]), action };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers['content-length'] ?? NaN) > MAX_BODY) {
    req.resume();
    throw new HttpError(413, `body over ${MAX_BODY} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      req.resume();
      throw new HttpError(413, `body over ${MAX_BODY} bytes`);
    }
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return r.data;
}

export interface RepromptOptions {
  /** Planner test seams (call / locateCall / mock / idPrefix). */
  planner?: Partial<Pick<PlanInput, 'call' | 'locateCall' | 'mock' | 'idPrefix'>>;
  /** Regen test seams. */
  regen?: Partial<Pick<ProduceOptions, 'deps' | 'dryRun' | 'mock'>>;
}

const running = new Map<string, Promise<unknown>>();

export async function handleRepromptRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  store: ProjectStore,
  opts: RepromptOptions = {},
): Promise<boolean> {
  const route = repromptRoute(parts);
  if (!route) return false;
  try {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      throw new HttpError(405, 'method not allowed');
    }
    const { projectId: id, sceneIndex: n } = route;
    if (!isProjectId(id)) throw new HttpError(404, 'no such project');
    const st = await store.getProject(id);
    if (!st) throw new HttpError(404, 'no such project');
    const planJson = ScreenplayPlan.safeParse(await readJson(join(store.projectDir(id), 'plan.json')).catch(() => undefined));
    const scene = planJson.success ? planJson.data.scenes[n] : undefined;
    if (!planJson.success || !scene) throw new HttpError(404, `no scene ${n} in ${id}`);
    const editsStore = editsStoreFor(store);
    const sceneDir = join(store.projectDir(id), `scene-${n}`);
    const log = (m: string) => console.log(`[${id}] [scene ${n}] reprompt: ${m}`);

    if (route.action === 'reprompt') {
      const body = validate(RepromptBody, await readBody(req));
      const edits = await editsStore.read(id, n);
      const ctx = await loadSceneContext({ projectId: id, sceneIndex: n, sceneDir, plan: scene, edits });
      const mock = opts.planner?.mock ?? (st.mock || env.mock || !env.keys.anthropic);
      log(`"${body.prompt.slice(0, 120)}"${body.selection ? ' (with selection)' : ''}${body.view ? ' (with view)' : ''}`);
      const r = await planEdit({
        prompt: body.prompt,
        scene: ctx,
        selection: body.selection,
        view: body.view,
        mock,
        log,
        ...opts.planner,
      });
      const waiting = new Set(r.plan.needsTarget.map((t) => t.opId));
      const apply =
        r.plan.scope === 'world-regen' || r.plan.scope === 'clarify' ? [] : r.plan.ops.filter((op) => !waiting.has(op.id));
      let saved: SceneEdits = edits;
      if (apply.length) {
        saved = await editsStore.update(id, n, (cur) => appendOps(cur, apply, { prompt: body.prompt, plan: r.plan }));
      }
      log(`${r.source} plan: ${r.plan.scope} — ${r.plan.summary} (applied ${apply.length}, waiting ${waiting.size}, ~$${r.usage.costUsd.toFixed(4)})`);
      send(res, 200, {
        plan: r.plan,
        edits: saved,
        ...(r.targets.length ? { targets: r.targets } : {}),
        applied: apply.map((op) => op.id),
        notes: r.notes,
        source: r.source,
      });
      return true;
    }

    // ---- regen
    const { plan: regen } = validate(RegenBody, await readBody(req));
    const key = `${id}:${n}:${regenKey(regen)}`;
    const done = await regenStatus(sceneDir, regen);
    if (running.has(key) || done?.status === 'done') {
      send(res, 202, await store.getProject(id));
      return true;
    }
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const mock = opts.regen?.mock ?? st.mock;
    const label = `regenerating the world (${regen.method === 'pano-inpaint' ? 'edited panorama' : 'new prompt'}): ${regen.prompt.slice(0, 80)} · ~${regen.estimatedMinutes} min`;
    const job = store
      .replaceWorld(id, n, label, async (stageLog) => {
        started();
        return produceRegenWorld({
          sceneDir,
          name: `${st.title} · ${scene.heading} (regen)`,
          regen,
          mock,
          // MOCK / dry run: the stand-in set follows the new prompt ("turn the kitchen into a cave")
          mockSet: pickMockSet({ ...scene, worldPrompt: regen.prompt }, planJson.success ? planJson.data.style : undefined),
          log: stageLog,
          ...opts.regen,
        });
      })
      .then(async (result) => {
        if (!result.ok) return;
        await dropRegionEdits(editsStore, id, n, { prompt: `regenerate: ${regen.prompt.slice(0, 200)}`, note: result.note, regen });
        await markRegenDone(sceneDir, regenKey(regen), result.note);
      })
      .catch((e) => console.error(`[${id}] regen failed:`, e))
      .finally(() => running.delete(key));
    running.set(key, job);
    await Promise.race([startedP, new Promise((r) => setTimeout(r, 300))]);
    send(res, 202, await store.getProject(id));
    return true;
  } catch (e) {
    if (e instanceof HttpError || e instanceof PipelineError || e instanceof EditsNotFound) {
      const status = e instanceof HttpError || e instanceof PipelineError ? e.status : 404;
      send(res, status, { error: e.message });
      return true;
    }
    throw e;
  }
}

/** Resolves when every regen started by this process has finished (tests). */
export async function regensIdle(): Promise<void> {
  while (running.size) await Promise.allSettled([...running.values()]);
}
