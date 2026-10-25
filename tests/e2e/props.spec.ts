// Props by import or by prompt (docs/PLAN-v4.md): a .glb uploaded through the API (sniffed,
// stored by hash, served as model/gltf-binary) and added through Scene › Background › Add prop ›
// Import; then Generate from a description ("a barrel", MOCK: the bundled sample after ~2 s) → the
// job row → a second prop placed. Both are prop-add edits of kind 'model' in edits.json, standing
// on the ground in front of the camera, undoable; the phone (sim) loads both models and renders
// (the laptop page is closed first and a Node WebSocket client plays the laptop, as in
// phone-render.spec, so only one page draws in software GL at a time).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { WebSocket } from 'ws';
import type { SceneState } from '../../shared/protocol.ts';
import { SceneEdits } from '../../shared/look.ts';
import { PropJob } from '../../shared/schema.ts';
import { createReadyProject, laptopState, phoneState, watchPage } from './helpers.ts';

const SAMPLE = new URL('../../fixtures/props/sample.glb', import.meta.url).pathname;

const addedModels = async (page: Page) =>
  (await laptopState(page)).dynamics.filter((d) => d.added && d.kind === 'model');

test('import a .glb and generate a prop from a description; both land in edits.json and on the phone', async ({
  page,
  request,
  context,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const project = await createReadyProject(request);
  const id = project.id;

  // ---- the API: a glTF binary is sniffed, stored by its hash and served with its MIME type
  const glb = readFileSync(SAMPLE);
  const res = await request.post(`/api/projects/${id}/uploads?name=sample.glb`, {
    headers: { 'content-type': 'model/gltf-binary' },
    data: glb,
  });
  expect(res.status()).toBe(201);
  const upload = (await res.json()) as { kind: string; file: string; bytes: number; name: string };
  expect(upload).toMatchObject({ kind: 'model', bytes: glb.length, name: 'sample.glb' });
  expect(upload.file).toMatch(/^uploads\/[0-9a-f]{16}\.glb$/);
  const served = await request.get(`/projects/${id}/${upload.file}`);
  expect(served.headers()['content-type']).toBe('model/gltf-binary');
  expect((await served.body()).length).toBe(glb.length);
  // not a glTF binary → refused with the reason
  const bad = await request.post(`/api/projects/${id}/uploads?name=x.glb`, {
    headers: { 'content-type': 'model/gltf-binary' },
    data: Buffer.from('this is not a model'),
  });
  expect(bad.status()).toBe(415);
  expect(((await bad.json()) as { error: string }).error).toMatch(/glTF/);

  // ---- the laptop: Scene › Background › Add prop › Import a 3D model (.glb)
  const problems = watchPage(page, 'laptop');
  await page.goto(`/?project=${id}&scene=0`);
  await expect
    .poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 })
    .toBe(true);
  const rows = page.getByTestId('background-row');
  const before = await rows.count();
  await page.getByTestId('add-prop').click();
  await expect(page.getByTestId('add-prop-menu')).toBeVisible();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByTestId('add-prop-import').click(),
  ]);
  await chooser.setFiles(SAMPLE);
  await expect(rows).toHaveCount(before + 1);
  await expect(rows.last()).toContainText('sample');
  await expect
    .poll(async () => (await addedModels(page)).map((d) => d.model), { timeout: 20_000 })
    .toEqual(['ready']);
  // on the ground, 2 m in front of the camera
  const imported = (await addedModels(page))[0]!;
  expect(Math.abs(imported.position[1]!)).toBeLessThan(0.05); // the mock set's flat ground
  const cam = await page.evaluate(() => {
    const d = (
      window as unknown as {
        __previz: { director: { mainCamera(): { position: { x: number; z: number } } } };
      }
    ).__previz.director;
    const p = d.mainCamera().position;
    return [p.x, p.z];
  });
  expect(Math.hypot(imported.position[0]! - cam[0]!, imported.position[2]! - cam[1]!)).toBeCloseTo(
    2,
    0,
  );

  // ---- Generate from a description… (MOCK: the bundled sample after ~2 s)
  await page.getByTestId('add-prop').click();
  await page.getByTestId('add-prop-generate').click();
  await page.getByTestId('prop-prompt').fill('a barrel');
  await page.getByTestId('prop-generate-go').click();
  const jobRow = page.getByTestId('prop-job-row');
  await expect(jobRow).toContainText('Generating: a barrel');
  await expect(jobRow).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('toast')).toContainText('Placed: a barrel');
  await expect(rows).toHaveCount(before + 2);
  await expect
    .poll(async () => (await addedModels(page)).map((d) => d.model), { timeout: 20_000 })
    .toEqual(['ready', 'ready']);

  // edits.json holds both (so the phone gets them); the generated one points at its job's model
  let edits: SceneEdits | null = null;
  await expect
    .poll(async () => {
      edits = SceneEdits.parse(
        await (await request.get(`/api/projects/${id}/scenes/0/edits`)).json(),
      );
      return edits.edits.filter((e) => e.kind === 'prop-add').length;
    })
    .toBe(2);
  const adds = edits!.edits.flatMap((e) => (e.kind === 'prop-add' ? [e.element] : []));
  expect(adds.map((e) => [e.kind, e.speed, e.path.length])).toEqual([
    ['model', 0, 1],
    ['model', 0, 1],
  ]);
  expect(adds[0]!.model).toMatchObject({ file: upload.file, source: 'sample.glb' });
  expect(adds[1]!.model).toMatchObject({ heightM: 1, source: 'a barrel' });
  const jobId = /^props\/([^/]+)\/model\.glb$/.exec(adds[1]!.model!.file)?.[1];
  expect(jobId).toBeTruthy();
  const job = PropJob.parse(await (await request.get(`/api/projects/${id}/props/${jobId}`)).json());
  expect(job).toMatchObject({ status: 'done', prompt: 'a barrel', sceneIndex: 0, costUsd: 0 });
  expect(job.note).toMatch(/mock/i);
  // a bad request is refused with the reason
  const noPrompt = await request.post(`/api/projects/${id}/props/generate`, {
    data: { prompt: ' ', sceneIndex: 0 },
  });
  expect(noPrompt.status()).toBe(400);

  // undo takes the generated prop away again, redo brings it back
  await page.locator('#stage canvas').first().hover();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await addedModels(page)).length).toBe(1);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(async () => (await addedModels(page)).length).toBe(2);
  await expect
    .poll(
      async () =>
        SceneEdits.parse(
          await (await request.get(`/api/projects/${id}/scenes/0/edits`)).json(),
        ).edits.filter((e) => e.kind === 'prop-add').length,
    )
    .toBe(2);
  expect(problems).toEqual([]);
  await page.close();

  // ---- the phone draws both models (it loads them from edits.json) and renders without errors
  const { room } = (await (await request.get('/api/rooms/new')).json()) as { room: string };
  const ws = new WebSocket(`${baseURL!.replace(/^https/, 'wss')}/ws`, {
    rejectUnauthorized: false,
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const scene: SceneState = {
    type: 'scene',
    projectId: id,
    sceneIndex: 0,
    manifestUrl: `/projects/${id}/scene-0/manifest.json`,
    time: 0,
    playing: false,
    cameras: [],
    activeCameraId: null,
    speakingLineId: null,
  };
  ws.send(JSON.stringify({ type: 'hello', role: 'laptop', room }));
  ws.send(JSON.stringify(scene));
  const phone = await context.newPage();
  try {
    await phone.setViewportSize({ width: 844, height: 390 });
    const phoneProblems = watchPage(phone, 'phone');
    const fetched = new Set<string>();
    phone.on('response', (r) => {
      if (r.ok() && /\.glb$/.test(new URL(r.url()).pathname))
        fetched.add(new URL(r.url()).pathname);
    });
    await phone.goto(`/phone.html?room=${room}&sim=1&autostart=1&governor=0`);
    await expect
      .poll(
        async () => {
          const p = await phoneState(phone);
          return p ? { mode: p.viewMode, status: p.viewStatus, drawn: p.framesRendered > 2 } : null;
        },
        { timeout: 45_000 },
      )
      .toEqual({ mode: 'webgl', status: 'ready', drawn: true });
    await expect
      .poll(
        () => [...fetched].filter((p) => p.includes('/uploads/') || p.includes('/props/')).sort(),
        { timeout: 20_000 },
      )
      .toEqual(
        [`/projects/${id}/${adds[1]!.model!.file}`, `/projects/${id}/${upload.file}`].sort(),
      );
    expect(phoneProblems).toEqual([]);
  } finally {
    ws.close();
    await phone.close();
  }
});
