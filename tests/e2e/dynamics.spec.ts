// Dynamic scenes: a screenplay whose action has a dinosaur lumbering past and an airplane flying low
// overhead gets a creature and an airplane in the scene's background action (MOCK planner,
// server/pipeline/dynamics.ts) that move on the scene clock, and the laptop draws their bodies
// (web/src/viewer/props-more.ts). Then the project chat adds a helicopter hovering over the street
// (a `dynamics` plan patch): the manifest gains it and the open scene shows it without a reload.
import { expect, test, type Page } from '@playwright/test';
import { api } from '../../shared/api.ts';
import type { ChatResponse } from '../../shared/chat.ts';
import { SceneManifest, type DynamicElement } from '../../shared/schema.ts';
import { createReadyProject, laptopState, watchPage } from './helpers.ts';

const SCRIPT = `Title: Rush Hour

EXT. MAIN STREET - DAY

Maya and Theo wait at the corner. A dinosaur lumbers past. An airplane flies low overhead.

MAYA
Did you see that?

THEO
See what?
`;

const pathLength = (d: DynamicElement) =>
  d.path.slice(1).reduce((n, p, i) => n + Math.hypot(...p.map((v, k) => v - d.path[i]![k]!)), 0);

/** The bodies the open scene drew: prop kind, creature species and mesh count per element. */
const bodies = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __previz: { director: { runtime: { dynamics: { items: { element: { id: string }; object: import('three').Object3D }[] } } | null } } }).__previz.director;
    return (d.runtime?.dynamics.items ?? []).map((i) => {
      let meshes = 0;
      i.object.traverse((o) => void ((o as { isMesh?: boolean }).isMesh && meshes++));
      return { id: i.element.id, name: i.object.name, species: (i.object.userData.species ?? null) as string | null, meshes };
    });
  });

const setClock = (page: Page, t: number) =>
  page.evaluate((t) => (window as unknown as { __previz: { director: { runtime: { setTime(t: number): void } } } }).__previz.director.runtime.setTime(t), t);

test('a dinosaur walks by and an airplane flies over; the chat adds a hovering helicopter', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = await createReadyProject(request, SCRIPT);
  const manifestUrl = project.scenes[0]!.manifestUrl!;
  const read = async () => SceneManifest.parse(await (await request.get(manifestUrl)).json());

  // the planner kept both: a creature on the ground behind the actors, an airplane 20-40 m up
  const dyn = (await read()).plan.dynamics;
  const dino = dyn.find((d) => d.kind === 'creature')!;
  const plane = dyn.find((d) => d.kind === 'airplane')!;
  expect(dino.label).toMatch(/dinosaur/i);
  expect(plane.label).toMatch(/airplane/i);
  for (const d of [dino, plane]) {
    expect(d.speed, d.id).toBeGreaterThan(0);
    expect(pathLength(d), d.id).toBeGreaterThan(20);
  }
  expect(dino.path.every((p) => p[1] === 0 && p[2] <= -6)).toBe(true);
  for (const p of plane.path) expect(p[1]).toBeGreaterThanOrEqual(20);

  // the laptop opens the scene and draws their bodies (not the plain marker)
  const problems = watchPage(page, 'laptop');
  await page.goto(`/?project=${project.id}&scene=0`);
  await expect(page.locator('#health')).toHaveText('MOCK');
  await expect.poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 }).toBe(true);
  const drawn = await bodies(page);
  const dinoBody = drawn.find((b) => b.id === dino.id)!;
  const planeBody = drawn.find((b) => b.id === plane.id)!;
  expect(dinoBody).toMatchObject({ name: 'prop:creature', species: 'dinosaur' });
  expect(planeBody.name).toBe('prop:airplane');
  for (const b of [dinoBody, planeBody]) expect(b.meshes, b.id).toBeGreaterThan(20);

  // they move on the scene clock: 3 s in, the dinosaur ~9 m on, the airplane ~75 m
  const at = async (t: number) => {
    await setClock(page, t);
    const s = await laptopState(page);
    return new Map(s.dynamics.map((d) => [d.id, d.position]));
  };
  const t0 = await at(0);
  const t3 = await at(3);
  const moved = (id: string) => Math.hypot(...t3.get(id)!.map((v, k) => v - t0.get(id)![k]!));
  expect(moved(dino.id)).toBeGreaterThan(8);
  expect(moved(dino.id)).toBeLessThan(10);
  expect(moved(plane.id)).toBeGreaterThan(60);
  expect(t3.get(plane.id)![1]).toBeGreaterThan(20);
  expect(Math.abs(t3.get(dino.id)![1]!)).toBeLessThan(1e-6);

  // the project chat adds a helicopter; the manifest is rewritten from the plan, nothing else
  await page.evaluate(() => ((window as unknown as { __previz: { director: { runtime: { __probe?: number } } } }).__previz.director.runtime.__probe = 1));
  const before = await read();
  const res = await request.post(api.chat(project.id), { data: { text: 'add a helicopter hovering over the street in scene 1' } });
  expect(res.ok()).toBe(true);
  const { chat } = (await res.json()) as ChatResponse;
  const action = chat.messages.at(-1)!.actions!.find((a) => a.type === 'plan-patch')!;
  expect(action).toMatchObject({ target: 'scene:0', field: 'dynamics', status: 'applied', effect: 'updates the background action' });
  let heli: DynamicElement | undefined;
  await expect
    .poll(async () => (heli = (await read()).plan.dynamics.find((d) => d.kind === 'helicopter')) !== undefined, { timeout: 15_000 })
    .toBe(true);
  expect(heli!.label).toMatch(/helicopter hovering/i);
  expect(heli!.speed).toBe(0);
  expect(heli!.path[0]![1]).toBeGreaterThanOrEqual(10);
  expect(heli!.path[0]![1]).toBeLessThanOrEqual(20);
  const after = await read();
  expect(after.world).toEqual(before.world);
  expect(after.actors).toEqual(before.actors);
  expect(after.audio).toEqual(before.audio);
  expect(after.plan.dynamics.map((d) => d.id)).toEqual([...before.plan.dynamics.map((d) => d.id), heli!.id]);

  // the open scene picks it up live (projects poll → refreshDynamics): same runtime, a helicopter body
  await expect
    .poll(async () => (await laptopState(page)).dynamics.map((d) => d.id), { timeout: 20_000 })
    .toContain(heli!.id);
  expect(await page.evaluate(() => (window as unknown as { __previz: { director: { runtime: { __probe?: number } } } }).__previz.director.runtime.__probe)).toBe(1);
  const heliBody = (await bodies(page)).find((b) => b.id === heli!.id)!;
  expect(heliBody.name).toBe('prop:helicopter');
  expect(heliBody.meshes).toBeGreaterThan(20);
  const hovering = (await laptopState(page)).dynamics.find((d) => d.id === heli!.id)!;
  expect(hovering.position[1]).toBeGreaterThanOrEqual(10);
  expect(problems).toEqual([]);
});
