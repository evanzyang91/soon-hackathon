// (b) Laptop director: Generate → the first ready scene opens by itself and renders the splat
// world; dynamics move on Play; an added shot and a clicked dialogue line give a caption and
// real WebAudio playback. Also records the headless frame rate (software GL) as an annotation.
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, laptopState, pixelStats, watchPage } from './helpers.ts';

test('generate → auto-opened scene renders, dynamics move, a line plays with a caption', async ({
  page,
}) => {
  // every click waits for two animation frames, about a second each in SwiftShader, and the
  // Scene / Shots / Camera modes add a few
  test.setTimeout(120_000);
  const problems = watchPage(page, 'laptop');
  await page.goto('/');
  await expect(page.locator('#health')).toHaveText('MOCK');

  // Generate from the UI; the laptop opens the first ready scene on its own
  await page.getByTestId('screenplay').fill(FIXTURE);
  await page.getByTestId('generate').click();
  await expect
    .poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 })
    .toBe(true);
  let s = await laptopState(page);
  expect(s.error).toBeNull();
  expect(s.placeholder).toBe(false); // the mock SPZ really decoded
  expect(s.sceneIndex).toBe(0);
  expect(s.actors.map((a) => a.id).sort()).toEqual(['maya', 'theo']);
  // the mock world has no collider: blocking is used as written
  expect(s.actors.every((a) => !a.placementCorrected && a.kind === 'mannequin')).toBe(true);
  // its ground field (flat floor at 0) loaded, and every actor stands on the ground at its spot
  expect(s.ground?.cell).toBe(0.25);
  expect(s.actors.every((a) => Math.abs(a.position[1]! - a.groundY) < 1e-6 && Math.abs(a.groundY) < 0.02)).toBe(true);
  // each mannequin stands at its character's height (mock planner: THEO is "tall")
  const tall = Object.fromEntries(s.actors.map((a) => [a.id, a.heightMeters ?? 0]));
  expect(tall.theo).toBeGreaterThan(tall.maya! + 0.05);
  await expect(page.getByTestId('actor-height')).toHaveCount(2);
  // (this project's rows: specs that run earlier, e.g. chat.spec, leave projects in the list)
  await expect(page.locator(`[data-testid=project][data-id="${s.projectId}"] [data-testid=scene-row]`)).toHaveCount(3);
  await expect(page.locator('#hud-title')).toHaveText('EXT. CITY STREET - NIGHT');
  // where the cast and the background props stand at the top of the scene (Reset returns there)
  const opened = { actors: s.actors.map((a) => [a.id, a.position] as const), dynamics: s.dynamics.map((d) => d.position) };

  // the default start camera opens on the Wide master: both actors head to toe in the viewport
  const atStart = await framing(page);
  expect(atStart.camera).not.toEqual([0, 1.6, 0]);
  for (const id of ['theo', 'maya'])
    for (const p of [atStart.actors[id]!.eye, atStart.actors[id]!.feet])
      expect(Math.max(Math.abs(p[0]!), Math.abs(p[1]!))).toBeLessThan(1);
  // the Shots mode's list is seeded with the coverage framed on the actors where they stand
  // (viewer/shots.ts)
  await expect(page.getByTestId('shot-row')).toHaveCount(5);
  expect(
    await page.getByTestId('shot-row').evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.shot)),
  ).toEqual(['Wide master', 'Two-shot', "Over Theo's shoulder on Maya", 'Close-up Theo', 'Close-up Maya']);

  // frames keep coming at 1280x720; report the software-GL frame rate
  const f0 = s.mainFrames;
  const t0 = Date.now();
  await expect.poll(async () => (await laptopState(page)).mainFrames).toBeGreaterThan(f0 + 5);
  s = await laptopState(page);
  const fps = ((s.mainFrames - f0) * 1000) / (Date.now() - t0);
  // (right after load; SwiftShader settles near 1 fps at this size once every splat is drawn)
  test.info().annotations.push({ type: 'laptop fps after load (1280x720, SwiftShader)', description: fps.toFixed(1) });
  console.log(`laptop fps right after load at 1280x720 (headless SwiftShader): ${fps.toFixed(1)}`);

  // the world is on screen: mostly lit pixels, many distinct colours (not a clear colour)
  const px = await pixelStats(page, '#viewport');
  expect(px.nonBlack).toBeGreaterThan(0.6);
  expect(px.distinct).toBeGreaterThan(40);

  // dynamics move once the scene clock runs (Camera mode)
  await page.getByTestId('tab-camera').click();
  await page.getByTestId('play').click();
  const before = (await laptopState(page)).dynamics;
  expect(before.length).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const now = (await laptopState(page)).dynamics;
      return Math.max(
        ...now.map((d, i) => Math.hypot(...d.position.map((v, k) => v - before[i]!.position[k]!))),
      );
    })
    .toBeGreaterThan(0.5);
  expect((await laptopState(page)).playing).toBe(true);

  // add the view as a shot (this click is also the user gesture that unlocks audio): one more
  // shot, and one more camera for the phone
  await page.getByTestId('tab-shots').click();
  await page.getByTestId('add-shot').click();
  await expect(page.getByTestId('shot-row')).toHaveCount(6);
  expect((await laptopState(page)).cameras).toBe(6);

  // click the first line (Scene mode): caption shows it, the speaking actor's voice actually plays
  await page.getByTestId('tab-scene').click();
  await page.getByTestId('line').first().click();
  await expect(page.getByTestId('caption')).toBeVisible();
  await expect(page.getByTestId('caption')).toContainText('You missed the last bus too?');
  await expect(page.getByTestId('caption')).toContainText('THEO');
  // the caption clears when the line ends...
  await expect(page.getByTestId('caption')).toBeHidden({ timeout: 10_000 });
  // ...and THEO's positional voice played through a running AudioContext
  const { voice, speakingLineId } = await laptopState(page);
  expect(speakingLineId).toBeNull();
  expect(voice.context).toBe('running');
  expect(voice.heard).toEqual(['theo']);
  // The analyser level (what drives the mannequin jaw) is reported, not asserted: headless
  // Chromium's audio thread is starved under SwiftShader load and sometimes renders silence.
  test.info().annotations.push({ type: 'voice peak level', description: voice.peak.toFixed(3) });

  // Reset (top bar, left of Play) in the middle of a line: the clock paused at 0:00, nobody
  // speaking, everyone on the mark they opened on, the background props at their path start
  await page.getByTestId('line').first().click();
  await expect(page.getByTestId('caption')).toBeVisible();
  await page.getByTestId('top-reset').click();
  await expect(page.getByTestId('toast')).toHaveText('Scene reset');
  await expect(page.getByTestId('caption')).toBeHidden();
  const reset = await laptopState(page);
  expect([reset.time, reset.playing, reset.speakingLineId]).toEqual([0, false, null]);
  expect(reset.voice.playing).toEqual([]);
  const far = (a: readonly number[], b: readonly number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
  expect(reset.actors.map((a) => a.id)).toEqual(opened.actors.map(([id]) => id));
  reset.actors.forEach((a, i) => expect(far(a.position, opened.actors[i]![1])).toBeLessThan(1e-4));
  reset.dynamics.forEach((d, i) => expect(far(d.position, opened.dynamics[i]!)).toBeLessThan(1e-4));

  // a close-up flies to the actor's face (eyes mid-frame) and puts the phone on it; Duplicate
  // keeps a copy of it as the director's own shot
  await page.getByTestId('tab-shots').click();
  const close = page.locator('[data-testid=shot-row][data-shot="Close-up Maya"]');
  await close.getByTestId('shot-fly').click();
  await expect
    .poll(async () => {
      const eye = (await framing(page)).actors.maya!.eye;
      return Math.max(Math.abs(eye[0]!), Math.abs(eye[1]!));
    }, { timeout: 20_000 })
    .toBeLessThan(0.15);
  expect((await laptopState(page)).activeCameraId).toBe(await close.getAttribute('data-id'));
  await close.getByTestId('shot-duplicate').click();
  await expect(page.getByTestId('shot-row')).toHaveCount(7);
  await expect(page.locator('[data-testid=shot-row][data-shot="Close-up Maya (alt)"]')).toHaveAttribute('data-source', 'director');

  expect(problems).toEqual([]);
});

/** The laptop camera's position and where each actor's eyes and feet land in its frame (NDC). */
async function framing(page: Page) {
  return page.evaluate(() => {
    type V = { x: number; y: number; z: number; project(c: unknown): V };
    const d = (
      window as unknown as {
        __previz: {
          director: {
            camera: { position: V & { toArray(): number[] }; updateMatrixWorld(): void };
            runtime: {
              actors: Map<string, { object: { position: V; userData: { heightMeters?: number } } }>;
            };
          };
        };
      }
    ).__previz.director;
    const cam = d.camera;
    cam.updateMatrixWorld();
    const Vec = cam.position.constructor as new (x: number, y: number, z: number) => V;
    const at = (x: number, y: number, z: number) => {
      const v = new Vec(x, y, z).project(cam);
      return [v.x, v.y];
    };
    const actors: Record<string, { eye: number[]; feet: number[] }> = {};
    for (const [id, a] of d.runtime.actors) {
      const p = a.object.position;
      const tall = a.object.userData.heightMeters ?? 1.7;
      actors[id] = { eye: at(p.x, p.y + 0.93 * tall, p.z), feet: at(p.x, p.y, p.z) };
    }
    return { camera: cam.position.toArray().map((v) => Math.round(v * 1000) / 1000), actors };
  });
}
