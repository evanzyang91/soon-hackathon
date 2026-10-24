// (b) Laptop director: Generate → the first ready scene opens by itself and renders the splat
// world; dynamics move on Play; a dropped camera and a clicked dialogue line give a caption and
// real WebAudio playback. Also records the headless frame rate (software GL) as an annotation.
import { expect, test } from '@playwright/test';
import { FIXTURE, laptopState, pixelStats, watchPage } from './helpers.ts';

test('generate → auto-opened scene renders, dynamics move, a line plays with a caption', async ({
  page,
}) => {
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
  // each mannequin stands at its character's height (mock planner: THEO is "tall")
  const tall = Object.fromEntries(s.actors.map((a) => [a.id, a.heightMeters ?? 0]));
  expect(tall.theo).toBeGreaterThan(tall.maya! + 0.05);
  await expect(page.getByTestId('actor-height')).toHaveCount(2);
  await expect(page.getByTestId('scene-row')).toHaveCount(3);
  await expect(page.locator('#hud-title')).toHaveText('EXT. CITY STREET - NIGHT');

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

  // dynamics move once the scene clock runs
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

  // drop a camera (this click is also the user gesture that unlocks audio)
  await page.getByTestId('drop-camera').click();
  await expect(page.getByTestId('camera-row')).toHaveCount(1);
  expect((await laptopState(page)).cameras).toBe(1);

  // click the first line: caption shows it, the speaking actor's voice actually plays
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

  expect(problems).toEqual([]);
});
