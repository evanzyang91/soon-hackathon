import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../../shared/api.ts';
import { EditPlan, SceneEdits } from '../../../shared/look.ts';
import { ProjectStatus, SceneManifest } from '../../../shared/schema.ts';
import { ProjectStore } from '../project.ts';
import { createPipelineHandler } from '../routes.ts';
import { regensIdle } from './routes.ts';

const FIXTURE = readFileSync(new URL('../../../fixtures/screenplay.fountain', import.meta.url), 'utf8');

let server: Server;
let base: string;
let store: ProjectStore;
let id: string;

beforeAll(async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'previz-reprompt-'));
  store = new ProjectStore({ dataDir, mock: true, keys: { anthropic: false, marble: false }, echo: false });
  const handle = createPipelineHandler(() => store);
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (await handle(req, res, url)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const res = await post(api.projects, { title: 'Reprompt test', screenplay: FIXTURE });
  id = ProjectStatus.parse(await res.json()).id;
  await store.idle();
});

afterAll(async () => {
  await regensIdle();
  await store.idle();
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface RepromptResponse {
  plan: EditPlan;
  edits: SceneEdits;
  targets?: unknown[];
  applied: string[];
}
const reprompt = async (body: object, n = 0) => {
  const res = await post(api.reprompt(id, n), body);
  return { status: res.status, body: (await res.json()) as RepromptResponse & { error?: string } };
};

describe('POST reprompt (mock planner)', () => {
  it('a look prompt is applied at once: edits.json gets the op, a history entry and a new revision', async () => {
    // the manifest stage seeded the plan's look (revision 1, look-seed.ts) before any prompt
    const seeded = SceneEdits.parse(JSON.parse(await readFile(join(store.projectDir(id), 'scene-0/edits.json'), 'utf8')));
    expect(seeded.revision).toBe(1);
    const { status, body } = await reprompt({ prompt: 'warmer and more contrast' });
    expect(status).toBe(200);
    expect(body.plan.scope).toBe('look');
    expect(body.applied).toHaveLength(1);
    const saved = SceneEdits.parse(body.edits);
    expect(saved.revision).toBe(2);
    expect(saved.edits.map((e) => e.kind)).toEqual(['look']);
    expect(saved.history.at(-1)).toMatchObject({ prompt: 'warmer and more contrast', appliedOpIds: body.applied });
    const onDisk = SceneEdits.parse(JSON.parse(await readFile(join(store.projectDir(id), 'scene-0/edits.json'), 'utf8')));
    expect(onDisk.revision).toBe(2);
  });

  it('transform of an actor from the screenplay', async () => {
    const { body } = await reprompt({ prompt: 'move Theo a metre closer to Maya' });
    expect(body.plan.scope).toBe('transform');
    expect(body.edits.edits.at(-1)).toMatchObject({ kind: 'transform', target: { type: 'actor', id: 'theo' } });
  });

  it('a region without a selection is returned unapplied with needsTarget', async () => {
    const before = (await reprompt({ prompt: 'warmer' })).body.edits.revision;
    const { body } = await reprompt({ prompt: "make the bus shelter's ad panel blue" });
    expect(body.plan.scope).toBe('splat-region');
    expect(body.plan.needsTarget).toHaveLength(1);
    expect(body.applied).toEqual([]);
    expect(body.edits.revision).toBe(before);
  });

  it('a region with a selection is applied', async () => {
    const region = { center: [-1.5, 1.4, -4], size: [0.6, 0.6, 0.6], shape: 'sphere' };
    const { body } = await reprompt({ prompt: 'make it red', selection: { region } });
    expect(body.applied).toHaveLength(1);
    expect(body.edits.edits.at(-1)).toMatchObject({ kind: 'splat-region', center: region.center, color: { mode: 'hue' } });
  });

  it('world-regen and clarify come back unapplied', async () => {
    const regen = await reprompt({ prompt: 'make it snow' });
    expect(regen.body.plan.scope).toBe('world-regen');
    expect(regen.body.plan.regen?.method).toBe('text'); // mock world: no panorama
    expect(regen.body.applied).toEqual([]);
    const clarify = await reprompt({ prompt: 'the thing on the left' });
    expect(clarify.body.plan.scope).toBe('clarify');
  });

  it('validates the body, the project and the scene', async () => {
    expect((await reprompt({ prompt: '' })).status).toBe(400);
    expect((await reprompt({ prompt: 'x', view: { image: 'x'.repeat(500_000), position: [0, 0, 0], quaternion: [0, 0, 0, 1], fovDeg: 50, aspect: 1 } })).status).toBe(400);
    expect((await reprompt({ prompt: 'warmer' }, 9)).status).toBe(404);
    expect((await post(api.reprompt('nope-000000', 0), { prompt: 'warmer' })).status).toBe(404);
    expect((await fetch(base + api.reprompt(id, 0))).status).toBe(405);
  });
});

describe('POST regen (mock)', () => {
  it('replaces the world, rewrites the manifest, keeps look/actors/props, drops region edits with a note; idempotent', async () => {
    const sceneDir = join(store.projectDir(id), 'scene-1');
    // a look edit and a region edit on scene 1 before the regen
    await reprompt({ prompt: 'warmer' }, 1);
    await reprompt({ prompt: 'make it blue', selection: { region: { center: [0, 1, -3], size: [0.5, 0.5, 0.5], shape: 'sphere' } } }, 1);
    const manifestBefore = SceneManifest.parse(JSON.parse(await readFile(join(sceneDir, 'manifest.json'), 'utf8')));
    const regen = { method: 'pano-inpaint', prompt: 'make it snow', estimatedMinutes: 5, estimatedCredits: 1580, keeps: ['actors', 'look', 'props'], drops: ['1 region edit'] };
    const res = await post(api.regen(id, 1), { plan: regen });
    expect(res.status).toBe(202);
    const st = ProjectStatus.parse(await res.json());
    expect(st.scenes[1]!.stages.world.status).toBe('running');
    // a second request while it runs starts nothing
    expect((await post(api.regen(id, 1), { plan: regen })).status).toBe(202);
    await regensIdle();
    await store.idle();
    const after = (await store.getProject(id))!;
    expect(after.scenes[1]!.stages.world).toMatchObject({ status: 'done' });
    expect(after.scenes[1]!.stages.manifest.status).toBe('done');
    const dirs = await readdir(sceneDir);
    expect(dirs).toContain('world.prev-1');
    const manifest = SceneManifest.parse(JSON.parse(await readFile(join(sceneDir, 'manifest.json'), 'utf8')));
    expect(manifest.actors).toEqual(manifestBefore.actors);
    const edits = SceneEdits.parse(JSON.parse(await readFile(join(sceneDir, 'edits.json'), 'utf8')));
    expect(edits.edits.map((e) => e.kind)).toEqual(['look']);
    const note = edits.history.at(-1)!;
    expect(note.plan.scope).toBe('world-regen');
    expect(note.plan.summary).toMatch(/Dropped 1 region edit/);
    const receipt = JSON.parse(await readFile(join(sceneDir, 'regen', (await readdir(join(sceneDir, 'regen')))[0]!, 'regen.json'), 'utf8'));
    expect(receipt.status).toBe('done');
    // done: a repeat changes nothing
    const rev = edits.revision;
    expect((await post(api.regen(id, 1), { plan: regen })).status).toBe(202);
    await regensIdle();
    expect(SceneEdits.parse(JSON.parse(await readFile(join(sceneDir, 'edits.json'), 'utf8'))).revision).toBe(rev);
  });

  it('rejects a malformed regen plan', async () => {
    expect((await post(api.regen(id, 0), { plan: { method: 'paint' } })).status).toBe(400);
  });
});
