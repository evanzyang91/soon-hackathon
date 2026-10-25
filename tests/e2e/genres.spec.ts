// Genres (docs/PLAN-v3.md §6): the fantasy fixture through the MOCK pipeline comes out as a
// fantasy — the plan's style and a look per scene, the forest and hall mock sets, a seeded
// edits.json, a dragon among the dynamics — and the laptop opens scene 0 already graded with it.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { defaultLook, SceneEdits } from '../../shared/look.ts';
import { LOOK_PRESET_LABELS } from '../../shared/look-presets.ts';
import { SceneManifest, ScreenplayPlan, type ProjectStatus } from '../../shared/schema.ts';
import { createReadyProject, decodePng, laptopState, pixelStats, watchPage } from './helpers.ts';

const FANTASY = readFileSync(
  new URL('../../fixtures/genres/fantasy.fountain', import.meta.url),
  'utf8',
);

test.describe.configure({ mode: 'serial' });

let project: ProjectStatus;
let seededName = '';

test('fantasy screenplay → fantasy style, a look per scene, forest / hall sets, seeded edits, a dragon', async ({
  request,
}) => {
  project = await createReadyProject(request, FANTASY);
  const plan = ScreenplayPlan.parse(
    await (await request.get(`/projects/${project.id}/plan.json`)).json(),
  );
  expect(plan.style?.genre).toContain('fantasy');
  expect(plan.scenes).toHaveLength(2);
  for (const s of plan.scenes) expect(s.look?.preset, s.heading).toBeTruthy();

  const manifest = async (n: number) =>
    SceneManifest.parse(await (await request.get(project.scenes[n]!.manifestUrl!)).json());
  const [m0, m1] = [await manifest(0), await manifest(1)];
  expect(m0.world.caption).toBe('mock set: forest');
  expect(m1.world.caption).toBe('mock set: hall');
  expect(m0.plan.dynamics.map((d) => d.kind)).toContain('dragon');

  // the manifest stage wrote the scene's first grade: revision 1, named after the plan's preset
  const edits = SceneEdits.parse(
    await (await request.get(`/api/projects/${project.id}/scenes/0/edits`)).json(),
  );
  expect(edits.revision).toBe(1);
  expect(edits.look.name.startsWith(LOOK_PRESET_LABELS[plan.scenes[0]!.look!.preset])).toBe(true);
  seededName = edits.look.name;
});

/** Mean absolute RGB difference (0..1) between two screenshots of the viewport. */
async function viewportPng(page: Page) {
  const box = (await page.locator('#viewport').boundingBox())!;
  return decodePng(await page.screenshot({ clip: box, animations: 'allow', caret: 'initial' }));
}
const meanAbs = (a: Uint8Array, b: Uint8Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let c = 0; c < 3; c++) s += Math.abs(a[i + c]! - b[i + c]!);
  return s / ((a.length / 4) * 3 * 255);
};
/** Waits until the viewport has drawn `n` more frames (SwiftShader: about one a second). */
async function frames(page: Page, n: number) {
  const f0 = (await laptopState(page)).mainFrames;
  await expect
    .poll(async () => (await laptopState(page)).mainFrames, { timeout: 30_000 })
    .toBeGreaterThan(f0 + n);
}

test('the laptop opens scene 0 graded with the seeded look', async ({ page }) => {
  test.skip(!project, 'needs the project from the first test');
  test.setTimeout(120_000);
  const problems = watchPage(page, 'laptop');
  await page.goto(`/?project=${project.id}&scene=0`);
  await expect
    .poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 })
    .toBe(true);
  expect((await laptopState(page)).placeholder).toBe(false);
  await expect(page.locator('#hud-title')).toHaveText('EXT. ANCIENT FOREST CLEARING - DAWN');
  // the top bar names the look the scene opened with (loaded from edits.json, nothing clicked)
  await expect(page.getByTestId('look-badge')).toHaveText(`look: ${seededName}`);

  // the frame is graded: the same view with a neutral look is clearly different, well past the
  // frame-to-frame noise (film grain, idle mannequins)
  await frames(page, 2);
  const graded = await viewportPng(page);
  await frames(page, 1);
  const noise = meanAbs(graded.rgba, (await viewportPng(page)).rgba);
  await page.evaluate((look) => {
    const p = (
      window as unknown as {
        __previz: { director: { runtime: { look: { setLook(l: unknown): void } } } };
      }
    ).__previz;
    p.director.runtime.look.setLook(look);
  }, defaultLook());
  await expect(page.getByTestId('look-badge')).toBeHidden(); // "Default" has no badge
  await frames(page, 2);
  const neutral = await viewportPng(page);
  const delta = meanAbs(graded.rgba, neutral.rgba);
  const report = `${(delta * 100).toFixed(1)} % (frame noise ${(noise * 100).toFixed(2)} %)`;
  test.info().annotations.push({ type: 'graded vs neutral frame (mean abs)', description: report });
  console.log(`scene 0 "${seededName}" vs a neutral look: ${report}`);
  expect(delta).toBeGreaterThan(Math.max(0.03, noise * 4));
  const px = await pixelStats(page, '#viewport');
  expect(px.nonBlack).toBeGreaterThan(0.5);
  expect(px.distinct).toBeGreaterThan(40);
  expect(problems).toEqual([]);
});
