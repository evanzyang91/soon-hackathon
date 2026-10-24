// (c) Two browser contexts: the laptop director and a simulated phone (`?sim=1`, synthetic
// deviceorientation). Pose reaches the laptop gizmo + PiP; the laptop's dialogue reaches the phone
// caption; commands flow both ways through the relay.
//
// The phone runs with `&3d=0`: pose streaming, captions and commands never depend on its 3D view
// (web/src/phone/README.md), and two pages sharing SwiftShader starve each other's main thread
// for seconds at a time. The phone's WebGL rendering is covered by phone-render.spec.ts.
import { expect, test } from '@playwright/test';
import {
  angleDiff,
  createReadyProject,
  laptopState,
  phoneState,
  watchPage,
  yawDeg,
} from './helpers.ts';

const orient = (alpha: number, beta = 90, gamma = 0) => ({ alpha, beta, gamma });

test('phone pairs, steers the laptop gizmo + PiP, and both sides talk through the relay', async ({
  browser,
  request,
}) => {
  // two pages share SwiftShader; switching between the laptop's modes adds clicks at ~1 fps
  test.setTimeout(120_000);
  const project = await createReadyProject(request);

  // laptop: a smaller viewport keeps SwiftShader fast enough for two live pages
  const laptopCtx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 640, height: 400 },
  });
  const laptop = await laptopCtx.newPage();
  const laptopProblems = watchPage(laptop, 'laptop');
  await laptop.goto(`/?project=${project.id}&scene=0`);
  await expect
    .poll(async () => {
      const s = await laptopState(laptop);
      return s.sceneLoaded && s.linkStatus === 'open' && !!s.room;
    })
    .toBe(true);
  const room = (await laptopState(laptop)).room!;
  await expect(laptop.getByTestId('phone-status')).toContainText(`Room ${room}`);

  // phone: landscape phone-sized page in its own context, desktop simulator mode
  const phoneCtx = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 844, height: 390 },
  });
  // every caption / toast the phone shows, so a short line cannot slip between two polls
  await phoneCtx.addInitScript(() => {
    const log: Record<string, string[]> = { caption: [], toast: [] };
    (window as unknown as { __shown: typeof log }).__shown = log;
    document.addEventListener('DOMContentLoaded', () => {
      for (const id of ['caption', 'toast']) {
        const el = document.getElementById(id)!;
        new MutationObserver(() => {
          if (!el.hidden && el.textContent) log[id]!.push(el.textContent);
        }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
      }
    });
  });
  const shown = (id: 'caption' | 'toast') =>
    phone.evaluate((k) => (window as unknown as { __shown: Record<string, string[]> }).__shown[k]!, id);
  const phone = await phoneCtx.newPage();
  const phoneProblems = watchPage(phone, 'phone');
  await phone.goto(`/phone.html?room=${room}&sim=1&3d=0`);
  await expect(phone.locator('#room-input')).toHaveValue(room);
  await phone.locator('#start-button').click();
  await expect.poll(async () => (await phoneState(phone))?.conn).toBe('open');
  await expect.poll(async () => (await phoneState(phone))?.peers.laptop).toBe(true);
  await expect.poll(async () => (await laptopState(laptop)).phones).toBe(1);
  await expect(laptop.getByTestId('phone-status')).toContainText('1 phone connected');
  // the phone got the laptop's scene
  await expect
    .poll(async () => (await phoneState(phone))?.scene?.manifestUrl)
    .toBe(`/projects/${project.id}/scene-0/manifest.json`);

  // -- orientation → laptop gizmo -------------------------------------------------------------
  const dispatch = (o: ReturnType<typeof orient>) =>
    phone.evaluate((e) => {
      window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', e));
    }, o);
  // first sample: upright landscape-held portrait reading, becomes the anchor heading (yaw 0)
  await dispatch(orient(0));
  await expect.poll(async () => (await phoneState(phone))?.orientationEvents).toBe(1);
  // turn the phone 60° to the left
  await dispatch(orient(60));
  await expect
    .poll(async () => {
      const q = (await phoneState(phone))?.lastPose?.q;
      return q ? Math.round(yawDeg(q)) : null;
    })
    .toBe(60);
  await expect
    .poll(async () => {
      const s = await laptopState(laptop);
      return s.gizmo.visible && angleDiff(yawDeg(s.gizmo.quaternion), 60) < 1;
    })
    .toBe(true);
  let s = await laptopState(laptop);
  expect(s.lastPose?.phoneId).toMatch(/^p\d+@/); // relay-stamped
  expect(s.gizmo.position).toEqual([0, 1.6, 0]); // attached to the start camera, no sway
  expect(s.lastPose?.aspect).toBeCloseTo(844 / 390, 2);

  // -- PiP renders the phone's view, frame count increasing -----------------------------------
  await expect.poll(async () => (await laptopState(laptop)).pip.label).toBe('PHONE');
  const pip0 = (await laptopState(laptop)).pip.frames;
  await expect.poll(async () => (await laptopState(laptop)).pip.frames).toBeGreaterThan(pip0 + 3);
  await expect(laptop.locator('#pip-frame')).toBeVisible();

  // -- laptop plays a line (Scene mode) → phone caption ----------------------------------------
  await laptop.getByTestId('tab-scene').click();
  await laptop.getByTestId('line').nth(1).click();
  await expect
    .poll(() => shown('caption'))
    .toContain("MAYA: I let it go. I wasn't ready to go home.");
  // the caption goes away with the line
  await expect(phone.locator('#caption')).toBeHidden({ timeout: 10_000 });

  // -- laptop recenter (Camera mode) → phone: its current heading becomes the anchor heading ----
  await laptop.getByTestId('tab-camera').click();
  await laptop.getByTestId('recenter').click();
  await expect.poll(() => shown('toast')).toContain('Director recentered you');
  await expect
    .poll(async () => {
      const q = (await phoneState(phone))?.lastPose?.q;
      return q ? Math.round(yawDeg(q)) : null;
    })
    .toBe(0);
  await expect
    .poll(async () => angleDiff(yawDeg((await laptopState(laptop)).gizmo.quaternion), 0) < 1)
    .toBe(true);

  // -- phone camera popover → laptop switches the active shot ---------------------------------
  // (the scene's shot list is seeded with 5 coverage shots; two added shots follow them, and the
  // last one added is the phone's)
  await laptop.getByTestId('tab-shots').click();
  await expect(laptop.getByTestId('shot-row')).toHaveCount(5);
  await laptop.getByTestId('add-shot').click();
  await laptop.getByTestId('add-shot').click();
  await expect(laptop.getByTestId('shot-row')).toHaveCount(7);
  s = await laptopState(laptop);
  const ids = await laptop.getByTestId('shot-row').evaluateAll((rows) =>
    rows.map((r) => (r as HTMLElement).dataset.id),
  );
  expect(s.cameras).toBe(7);
  expect(s.activeCameraId).toBe(ids[6]);
  await expect.poll(async () => (await phoneState(phone))?.scene?.activeCameraId).toBe(ids[6]);
  // the popover lists the 7 shots, the phone's marked; picking 1B puts the phone on it
  await phone.locator('#cam').click();
  await expect(phone.getByTestId('cam-shot')).toHaveCount(7);
  await expect(phone.getByTestId('cam-shot').nth(6)).toHaveAttribute('aria-checked', 'true');
  await phone.getByTestId('cam-shot').nth(1).click();
  await expect(phone.locator('#cam-menu')).toBeHidden();
  await expect.poll(async () => (await laptopState(laptop)).activeCameraId).toBe(ids[1]);
  // ...and the phone follows: it re-anchors to the new shot
  await expect.poll(async () => (await phoneState(phone))?.anchor.key).toContain(ids[1]!);
  await expect(phone.locator('#cam-name')).toHaveText(/^1B · /);

  // -- phone "Add shot from here" → a new shot on the laptop's list, and the phone is on it -----
  // (on 1B and not walked, the phone sees from 1B's spot)
  const at = (await phoneState(phone))!.anchor.position;
  await phone.locator('#cam').click();
  await phone.getByTestId('cam-add').click();
  await expect(laptop.getByTestId('shot-row')).toHaveCount(8);
  const added = await laptop.getByTestId('shot-row').nth(7).getAttribute('data-id');
  await expect.poll(async () => (await laptopState(laptop)).activeCameraId).toBe(added);
  await expect(phone.locator('#cam-name')).toHaveText(/^1H\b/);
  // the new shot is where the phone was looking from: re-anchored on it, the view stays put
  await expect.poll(async () => (await phoneState(phone))?.anchor.key).toContain(added!);
  const now = (await phoneState(phone))!.anchor.position;
  expect(Math.max(...now.map((v, i) => Math.abs(v - at[i]!)))).toBeLessThan(0.01);

  // -- phone shutter → laptop takes a still (last: in SwiftShader the PNG encode hogs the page) -
  // (the PNG download itself is only timed by idle-time encoding, which a SwiftShader render
  // loop starves for many seconds; the still is taken synchronously when the command lands)
  expect((await laptopState(laptop)).lastStillAt).toBe(0);
  await phone.locator('#shutter').click();
  await expect.poll(async () => (await laptopState(laptop)).lastStillAt).toBeGreaterThan(0);

  expect(laptopProblems).toEqual([]);
  expect(phoneProblems).toEqual([]);
  await phoneCtx.close();
  await laptopCtx.close();
});
