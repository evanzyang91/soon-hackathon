// /api/projects routes (shared/api.ts). index.ts calls handlePipelineRequest for every /api/*
// path; we return false for anything that is not ours so it can 404.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ActorDetail, StageName } from '../../shared/schema.ts';
import { PipelineError, defaultStore, isProjectId, type ProjectStore } from './project.ts';
import { editsRoute, editsStoreFor, handleEditsRequest } from './edits.ts';
import { handleShotsRequest, shotsRoute, shotsStoreFor } from './shots.ts';
import { handleRepromptRequest, repromptRoute } from './reprompt/routes.ts';
import { chatRoute, handleChatRequest, type ChatRouteOptions } from './chat/routes.ts';
import { handlePropsRequest, propJobsFor, propsRoute } from './props.ts';
import { handleModelUpload, isModelUpload } from './prop-upload.ts';

export const MAX_BODY_BYTES = 1024 * 1024;

const CreateBody = z.object({
  title: z.string().max(200).optional(),
  screenplay: z.string().min(1, 'screenplay is required'),
  /** Chat-first project: parse only, the rest waits for POST /generate. */
  draft: z.boolean().optional(),
});
const RetryBody = z.object({
  sceneIndex: z.number().int().nonnegative().default(0),
  stage: StageName,
});
const RebuildBody = z.object({ detail: ActorDetail });
const CHARACTER_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(json);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (declared > MAX_BODY_BYTES) {
    req.resume();
    throw new HttpError(413, `body over ${MAX_BODY_BYTES} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      throw new HttpError(413, `body over ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new HttpError(400, 'JSON body required');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
  return r.data;
}

/** Builds a handler bound to a store (tests use their own; the server uses the env default). */
export function createPipelineHandler(
  getStore: () => ProjectStore,
  opts: { resume?: boolean; chat?: ChatRouteOptions } = {},
) {
  let resumed: Promise<unknown> | undefined;
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    // ['api', 'projects', id?, 'retry'?] or ['api', 'projects', id, 'actors', characterId, 'rebuild']
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1);
    if (parts[0] !== 'api' || parts[1] !== 'projects') return false;
    // GET / PUT /api/projects/:id/scenes/:n/edits (look + scene edits, server/pipeline/edits.ts)
    if (editsRoute(parts)) return handleEditsRequest(req, res, parts, editsStoreFor(getStore()));
    // GET / PUT …/scenes/:n/shots, PUT …/shots/:shotId/frame, GET …/shotlist.csv (server/pipeline/shots.ts)
    if (shotsRoute(parts)) return handleShotsRequest(req, res, parts, shotsStoreFor(getStore()));
    // POST /api/projects/:id/scenes/:n/reprompt | regen (scoped re-prompting, server/pipeline/reprompt/)
    if (repromptRoute(parts)) return handleRepromptRequest(req, res, parts, getStore());
    // POST …/props/generate, GET …/props/:jobId (props by prompt, server/pipeline/props.ts)
    if (propsRoute(parts)) return handlePropsRequest(req, res, parts, propJobsFor(getStore()));
    // POST …/uploads with a .glb (a prop's model, server/pipeline/prop-upload.ts); images go on to chat/
    if (isModelUpload(parts, req, url)) return handleModelUpload(req, res, parts, url, getStore());
    // uploads, chat, chat/confirm, generate (project chat, server/pipeline/chat/)
    if (chatRoute(parts)) return handleChatRequest(req, res, parts, url, getStore(), opts.chat);
    const rebuild = parts.length === 6 && parts[3] === 'actors' && parts[5] === 'rebuild';
    if (parts.length > 4 && !rebuild) return false;
    if (parts.length === 4 && parts[3] !== 'retry') return false;
    const store = getStore();
    // First request after boot picks up pipelines interrupted by a restart.
    if (opts.resume)
      resumed ??= store.resumeAll().catch((e) => console.error('pipeline resume failed:', e));
    const method = req.method ?? 'GET';
    const id = parts[2] ? decodeURIComponent(parts[2]) : undefined;
    try {
      if (!id) {
        if (method === 'POST') {
          const body = validate(CreateBody, await readJsonBody(req));
          const status = await store.createProject(body);
          send(res, 202, status, { location: `/api/projects/${status.id}` });
          return true;
        }
        if (method === 'GET' || method === 'HEAD') {
          send(res, 200, await store.listProjects());
          return true;
        }
        send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
        return true;
      }
      if (!isProjectId(id)) throw new HttpError(404, 'no such project');
      if (parts.length === 3) {
        if (method !== 'GET' && method !== 'HEAD') {
          send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
          return true;
        }
        const st = await store.getProject(id);
        if (!st) throw new HttpError(404, 'no such project');
        send(res, 200, st);
        return true;
      }
      if (method !== 'POST') {
        send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
        return true;
      }
      if (rebuild) {
        const characterId = decodeURIComponent(parts[4]!);
        if (!CHARACTER_ID.test(characterId)) throw new HttpError(404, 'no such character');
        const body = validate(RebuildBody, await readJsonBody(req));
        send(res, 202, await store.rebuildActor(id, characterId, body.detail));
        return true;
      }
      const body = validate(RetryBody, await readJsonBody(req));
      send(res, 200, await store.retry(id, body.sceneIndex, body.stage));
      return true;
    } catch (e) {
      if (e instanceof HttpError || e instanceof PipelineError) {
        send(res, e.status, { error: e.message });
        return true;
      }
      throw e;
    }
  };
}

export const handlePipelineRequest = createPipelineHandler(defaultStore, { resume: true });

/**
 * Optional: call once at boot so interrupted pipelines (e.g. a Marble job mid-poll) resume
 * immediately instead of on the first /api/projects request. Safe to call more than once.
 */
export const resumePipelines = () => defaultStore().resumeAll();
