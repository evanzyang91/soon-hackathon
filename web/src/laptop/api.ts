import { api } from '@shared/api';
import type { ActorDetail, ProjectStatus } from '@shared/schema';

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
