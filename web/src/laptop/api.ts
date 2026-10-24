import { api } from '@shared/api';
import type { ProjectStatus } from '@shared/schema';

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

export const newRoom = () =>
  fetch(api.newRoom).then((r) => json<{ room: string; phoneUrl: string }>(r));
