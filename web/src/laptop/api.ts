import { api } from '@shared/api';
import type { Attachment, ChatRequest, ProjectChat } from '@shared/chat';
import type { ActorDetail, ProjectStatus, ScreenplayPlan } from '@shared/schema';

export interface Health {
  ok: boolean;
  mock: boolean;
  keys: Record<string, boolean>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.url.replace(location.origin, '')}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export const getHealth = () => fetch(api.health).then((r) => json<Health>(r));

export const listProjects = () => fetch(api.projects).then((r) => json<ProjectStatus[]>(r));

export const createProject = (screenplay: string, title?: string) =>
  fetch(api.projects, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title ? { title, screenplay } : { screenplay }),
  }).then((r) => json<ProjectStatus>(r));

export const retryStage = (id: string, sceneIndex: number, stage: string) =>
  fetch(api.retry(id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sceneIndex, stage }),
  }).then((r) => json<ProjectStatus>(r));

/** Rebuild one character at a detail level (202 → ProjectStatus); the error text on 4xx. */
export const rebuildActor = async (id: string, characterId: string, detail: ActorDetail) => {
  const res = await fetch(api.rebuildActor(id, characterId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ detail }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as ProjectStatus;
};

/** Fresh room code, or the LAN phone URL for a code kept from a previous load. */
export const newRoom = (keep?: string) =>
  fetch(keep ? `${api.newRoom}?room=${encodeURIComponent(keep)}` : api.newRoom).then((r) =>
    json<{ room: string; phoneUrl: string }>(r),
  );

// ---- project chat (shared/chat.ts; chat-client.ts wraps these with image preparation) -----------

/** POST chat / chat/confirm answer (shared/api.ts "ChatResponse"). */
export interface ChatResponse {
  chat: ProjectChat;
  status: ProjectStatus;
}

/** JSON or a readable error: the server's `error` text when it sent one, plus the HTTP status. */
async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('The server is not reachable.');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    const why = body?.error ?? (res.status === 404 ? 'not found' : res.statusText || 'request failed');
    throw new Error(`${why} (HTTP ${res.status})`);
  }
  return (await res.json()) as T;
}

const postJson = <T>(url: string, body: unknown) =>
  call<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** draft: only the parse stage runs until /generate (the chat-first flow). */
export const createDraftProject = (screenplay: string, title?: string, attachments?: string[]) =>
  postJson<ProjectStatus>(api.projects, {
    screenplay,
    draft: true,
    ...(title ? { title } : {}),
    ...(attachments?.length ? { attachments } : {}),
  });

/** plan.json sits in the project root with every other built asset (/projects/:id/**). */
export const getPlan = (id: string) => call<ScreenplayPlan>(api.upload(id, 'plan.json'));

/** Raw image upload (PNG / JPEG / WebP body, ≤ 12 MB) → Attachment (201). */
export const uploadAttachment = (id: string, body: Blob, name: string) =>
  call<Attachment>(`${api.uploads(id)}?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': body.type || 'image/png' },
    body,
  });

export const getChat = (id: string) => call<ProjectChat>(api.chat(id));
export const sendChat = (id: string, req: ChatRequest) => postJson<ChatResponse>(api.chat(id), req);
export const confirmChatAction = (id: string, messageId: string, actionId: string) =>
  postJson<ChatResponse>(api.chatConfirm(id), { messageId, actionId });
export const generateProject = (id: string) => postJson<ProjectStatus>(api.generate(id), {});
