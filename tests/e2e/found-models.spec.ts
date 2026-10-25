// Found models (docs/PLAN-v4.md "Found models"): a background prop of a procedural kind that
// carries `model` draws that model instead of its primitive once it loads, moves along its path
// with it, and keeps the primitive when the model cannot be used. MOCK, no network: the bundled
// barrel (fixtures/props/sample.glb) plays the found model of a car (rigid kinds take a static
// mesh); a creature pointing at a file that does not exist, and one whose model has no animation
// clips, stay procedural. Scene › Background shows the model's source and licence and switches
// the car to its primitive and back.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SceneEdits } from '../../shared/look.ts';
import type { DynamicElement } from '../../shared/schema.ts';
import { createReadyProject, laptopState, watchPage, type LaptopState } from './helpers.ts';

const SAMPLE = new URL('../../fixtures/props/sample.glb', import.meta.url).pathname;
const MISSING = 'uploads/0123456789abcdef.glb';

/** A prop's entry in the debug state; a found model adds what is drawn and why (web/src/laptop/debug.ts). */
type Found = LaptopState['dynamics'][number] & { body?: string; clip?: string; reason?: string; loadMs?: number };
const found = async (page: Page, id: string) => (await laptopState(page)).dynamics.find((d) => d.id === id) as Found | undefined;

const setClock = (page: Page, t: number) =>
  page.evaluate((t) => (window as unknown as { __previz: { director: { runtime: { setTime(t: number): void } } } }).__previz.director.runtime.setTime(t), t);

/** Meshes drawn (visible all the way up) under the prop with this id. */
const visibleMeshes = (page: Page, id: string) =>
  page.evaluate((id) => {
    type O = import('three').Object3D;
    const d = (window as unknown as { __previz: { director: { runtime: { scene: O } } } }).__previz.director;
    let root: O | null = null;
    d.runtime.scene.traverse((o) => {
      if (!root && o.userData.dynamicId === id) root = o;
    });
    let n = 0;
    (root as O | null)?.traverseVisible((o) => void ((o as { isMesh?: boolean }).isMesh && n++));
    return n;
  }, id);

test('a found model replaces the primitive, moves along the path, and the primitive stays when the model cannot be used', async ({ page, request }) => {
  test.setTimeout(120_000);
  const project = await createReadyProject(request);
  const id = project.id;
  const upload = (await (
    await request.post(`/api/projects/${id}/uploads?name=sample.glb`, { headers: { 'content-type': 'model/gltf-binary' }, data: readFileSync(SAMPLE) })
  ).json()) as { file: string };
  expect(upload.file).toMatch(/^uploads\/[0-9a-f]{16}\.glb$/);

  const element = (over: Partial<DynamicElement> & Pick<DynamicElement, 'id' | 'kind' | 'label' | 'model'>): DynamicElement => ({
    path: [
      [-4, 0, -3],
      [4, 0, -3],
    ],
    speed: 2,
    loop: true,
    pauseSeconds: 0,
    scale: 1,
    ...over,
  });
  const car = element({
    id: 'found-car',
    kind: 'car',
    label: 'a car drives past',
    model: { file: upload.file, license: 'CC0-1.0', attribution: 'Barrel by the fixtures' },
  });
  const missing = element({
    id: 'found-missing',
    kind: 'creature',
    label: 'a dinosaur lumbers past',
    path: [
      [-4, 0, -6],
      [4, 0, -6],
    ],
    model: { file: MISSING, animated: true },
  });
  const still = element({
    id: 'found-still',
    kind: 'creature',
    label: 'a bear lumbers past',
    path: [
      [-4, 0, -9],
      [4, 0, -9],
    ],
    model: { file: upload.file },
  });
  // an imported prop (kind 'model') shares the loader and is drawn as before
  const imported = element({ id: 'imported', kind: 'model', label: 'sample', path: [[2, 0, 1]], speed: 0, model: { file: upload.file, source: 'sample.glb' } });
  const current = SceneEdits.parse(await (await request.get(`/api/projects/${id}/scenes/0/edits`)).json());
  const put = await request.put(`/api/projects/${id}/scenes/0/edits`, {
    data: {
      ...current,
      edits: [...current.edits, ...[car, missing, still, imported].map((e) => ({ kind: 'prop-add', id: `add-${e.id}`, element: e, enabled: true }))],
    },
  });
  expect(put.status()).toBe(200);

  const problems = watchPage(page, 'laptop');
  await page.goto(`/?project=${id}&scene=0`);
  await expect.poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 }).toBe(true);

  // the car draws its found model; the creatures keep their procedural bodies, saying why
  await expect.poll(async () => (await found(page, car.id))?.model, { timeout: 20_000 }).toBe('ready');
  expect(await found(page, car.id)).toMatchObject({ body: 'model', kind: 'car', added: true });
  await expect.poll(async () => (await found(page, missing.id))?.model, { timeout: 20_000 }).toBe('failed');
  expect(await found(page, missing.id)).toMatchObject({ body: 'procedural' });
  await expect.poll(async () => (await found(page, still.id))?.model, { timeout: 20_000 }).toBe('skipped');
  expect((await found(page, still.id))?.reason).toMatch(/no animation clips/);
  await expect.poll(async () => (await found(page, imported.id))?.model, { timeout: 20_000 }).toBe('ready');
  // the primitive is drawn (a creature has dozens of parts), the car is the barrel's few meshes
  expect(await visibleMeshes(page, missing.id)).toBeGreaterThan(20);
  expect(await visibleMeshes(page, still.id)).toBeGreaterThan(20);
  const carMeshes = await visibleMeshes(page, car.id);
  expect(carMeshes).toBeGreaterThan(0);
  expect(carMeshes).toBeLessThan(10);

  // it moves along its path on the scene clock: 2 m/s, 2 s apart → ~4 m along +x
  await setClock(page, 0.5);
  await expect.poll(async () => (await found(page, car.id))?.position[0], { timeout: 10_000 }).toBeCloseTo(-3, 0);
  const a = (await found(page, car.id))!.position;
  await setClock(page, 2.5);
  await expect.poll(async () => (await found(page, car.id))?.position[0], { timeout: 10_000 }).toBeCloseTo(1, 0);
  const b = (await found(page, car.id))!.position;
  expect(Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!)).toBeCloseTo(4, 0);
  expect(Math.abs(b[2]! + 3)).toBeLessThan(0.05);

  // Scene › Background (and Tools › Objects): the source and licence, and the choice of body
  const background = page.getByTestId('background');
  const line = background.locator(`[data-testid="found-model-line"][data-id="${car.id}"]`);
  await expect(line).toContainText('Barrel by the fixtures · CC0-1.0');
  await expect(background.locator(`[data-testid="found-model-line"][data-id="${missing.id}"]`)).toContainText('Found model not used');
  await expect(page.getByTestId('tools-drawer').locator(`[data-testid="found-model-line"][data-id="${car.id}"]`)).toContainText('CC0-1.0');
  await line.getByTestId('found-use-primitive').click();
  await expect.poll(async () => (await found(page, car.id))?.body).toBe('procedural');
  expect(await visibleMeshes(page, car.id)).toBeGreaterThan(10); // the procedural car: body, cabin, wheels…
  await line.getByTestId('found-use-model').click();
  await expect.poll(async () => (await found(page, car.id))?.body).toBe('model');

  // only the missing file's 404 is expected
  expect(problems.filter((p) => !p.includes(MISSING.split('/')[1]!) && !/Failed to load resource/.test(p))).toEqual([]);
});
