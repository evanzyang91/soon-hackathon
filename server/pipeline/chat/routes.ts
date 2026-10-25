// Project chat routes (shared/api.ts), registered from server/pipeline/routes.ts:
//
//   POST /api/projects/:id/uploads?name=   raw PNG / JPEG / WebP ≤ 12 MB → 201 Attachment, or a
//                                          model/gltf-binary .glb ≤ 25 MB → 201 { id, kind: 'model', file }
//   GET  /api/projects/:id/chat            → ProjectChat (empty thread when nothing was said)
//   POST /api/projects/:id/chat            ChatRequest → ChatResponse { chat, status }
//   POST /api/projects/:id/chat/confirm    ChatConfirmRequest (decline?: true → skipped) → ChatResponse
//   POST /api/projects/:id/generate        → 202 ProjectStatus (no-op unless a draft)
//
// chat and confirm answer once the turn is stored; background work they start (a re-plan, a world
// regeneration) is waited for up to `waitMs` (MOCK work finishes inside it) and otherwise shows up
// through ProjectStatus.chatRevision. Errors are JSON { error } with the status they carry.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { ChatConfirmRequest, ChatRequest, type ChatResponse } from '../../../shared/chat.ts';
import { isProjectId } from '../project.ts';
import { confirmAction, type ChatHost } from './apply.ts';
import type { ChatPlannerCall } from './planner.ts';
import { chatTurn } from './service.ts';
import { MAX_MODEL_UPLOAD_BYTES, saveModelUpload, saveUpload, uploadLimit } from './uploads.ts';

const MAX_JSON = 1024 * 1024;

type ChatRouteName = 'uploads' | 'chat' | 'confirm' | 'generate';

/** ['api','projects',id,'uploads'|'chat'|'generate'] or [...,'chat','confirm'] → route, else null. */
export function chatRoute(parts: string[]): { projectId: string; name: ChatRouteName } | null {
  if (parts[0] !== 'api' || parts[1] !== 'projects' || !parts[2]) return null;
  const projectId = decodeURIComponent(parts[2]);
  if (
    parts.length === 4 &&
    (parts[3] === 'uploads' || parts[3] === 'chat' || parts[3] === 'generate')
  )
    return { projectId, name: parts[3] };
  if (parts.length === 5 && parts[3] === 'chat' && parts[4] === 'confirm')
    return { projectId, name: 'confirm' };
  return null;
}

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

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? NaN) > max) {
    req.resume();
    throw new HttpError(413, `body over ${max} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) {
      req.resume();
      throw new HttpError(413, `body over ${max} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const text = (await readRaw(req, MAX_JSON)).toString('utf8');
  if (!text.trim()) throw new HttpError(400, 'JSON body required');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
  const r = schema.safeParse(data);
  if (!r.success)
    throw new HttpError(
      400,
      r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  return r.data;
}

export interface ChatRouteOptions {
  /** Planner seams (tests): the offline planner, or a fake Claude call. */
  planner?: { mock?: boolean; call?: ChatPlannerCall };
  dryRun?: boolean;
  /** How long chat / confirm wait for the work they started before answering (default 3 s). */
  waitMs?: number;
  /** Poll interval while a confirmed world regeneration runs (default 500 ms). */
  watchIntervalMs?: number;
}

const settleWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([
    p.then(() => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), ms).unref?.()),
  ]);

export async function handleChatRequest(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  host: ChatHost,
  opts: ChatRouteOptions = {},
): Promise<boolean> {
  const route = chatRoute(parts);
  if (!route) return false;
  const method = req.method ?? 'GET';
  const id = route.projectId;
  const waitMs = opts.waitMs ?? 3000;
  try {
    const allowed = route.name === 'chat' ? ['GET', 'HEAD', 'POST'] : ['POST'];
    if (!allowed.includes(method)) {
      req.resume();
      send(res, 405, { error: 'method not allowed' }, { allow: allowed.join(', ') });
      return true;
    }
    if (!isProjectId(id) || !(await host.getProject(id))) {
      req.resume();
      throw new HttpError(404, 'no such project');
    }

    if (route.name === 'uploads') {
      const contentType = req.headers['content-type'];
      const bytes = await readRaw(req, uploadLimit(contentType));
      if (uploadLimit(contentType) === MAX_MODEL_UPLOAD_BYTES) {
        // a prop's glTF binary (Scene › Background › Add prop › Import)
        const { upload, created } = await saveModelUpload(host.projectDir(id), bytes, {
          name: url.searchParams.get('name') ?? undefined,
        });
        if (created)
          await host.logEvent(id, `upload: ${upload.file} (3D model, ${upload.bytes} bytes${upload.name ? `, "${upload.name}"` : ''})`);
        send(res, 201, upload, { location: `/projects/${id}/${upload.file}` });
        return true;
      }
      const { attachment, created } = await saveUpload(host.projectDir(id), bytes, {
        contentType: req.headers['content-type'],
        name: url.searchParams.get('name') ?? undefined,
      });
      if (created)
        await host.logEvent(
          id,
          `upload: ${attachment.file} (${attachment.width}×${attachment.height}, ${attachment.bytes} bytes${attachment.name ? `, "${attachment.name}"` : ''})`,
        );
      send(res, 201, attachment, { location: `/projects/${id}/${attachment.file}` });
      return true;
    }
    if (route.name === 'generate') {
      req.resume();
      send(res, 202, await host.generate(id));
      return true;
    }
    if (route.name === 'chat' && method !== 'POST') {
      send(res, 200, await host.chat.read(id));
      return true;
    }

    let settled: Promise<unknown>;
    if (route.name === 'chat') {
      const body = await readJson(req, ChatRequest);
      const turn = await chatTurn(host, id, body, { ...opts.planner, dryRun: opts.dryRun });
      settled = turn.settled;
    } else {
      const body = await readJson(req, ChatConfirmRequest);
      settled = (
        await confirmAction(host, id, body.messageId, body.actionId, {
          decline: body.decline,
          waitIntervalMs: opts.watchIntervalMs,
        })
      ).settled;
    }
    await settleWithin(settled, waitMs);
    const out: ChatResponse = {
      chat: await host.chat.read(id),
      status: (await host.getProject(id))!,
    };
    send(res, 200, out);
    return true;
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      send(res, status, { error: (e as Error).message });
      return true;
    }
    throw e;
  }
}
