// Browser side of GET / PUT /api/projects/:id/scenes/:n/edits (server/pipeline/edits.ts).
import { api } from '@shared/api';
import { SceneEdits } from '@shared/look';

export async function fetchEdits(projectId: string, sceneIndex: number, signal?: AbortSignal): Promise<SceneEdits> {
  const res = await fetch(api.edits(projectId, sceneIndex), { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`edits: HTTP ${res.status}`);
  return SceneEdits.parse(await res.json());
}

export type PutResult = { ok: true; doc: SceneEdits } | { ok: false; conflict: SceneEdits };

/** Saves `doc` (its revision must be the stored one). A 409 resolves with the stored document. */
export async function putEdits(projectId: string, sceneIndex: number, doc: SceneEdits): Promise<PutResult> {
  const res = await fetch(api.edits(projectId, sceneIndex), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(doc),
  });
  if (res.status === 409) {
    const body = (await res.json()) as { current?: unknown };
    return { ok: false, conflict: SceneEdits.parse(body.current) };
  }
  if (!res.ok) throw new Error(`edits save: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { ok: true, doc: SceneEdits.parse(await res.json()) };
}
