// (f) phone.html?pose=external, the page the native ARKit app (ios/) shows in its web view. The
// app owns the relay and the pose: the page must render whatever it is handed through
// window.__previzPose / __previzMessage, post `ready` to the native handler, and never open the
// relay socket itself (ios/README.md, "Web side contract").
import { expect, test } from '@playwright/test';
import type { PhonePose, RoomScan, SceneState } from '../../shared/protocol.ts';
import { focalLabel } from '../../web/src/phone/fov.ts';
import { createReadyProject, phoneState, watchPage } from './helpers.ts';

test('pose=external renders native poses, posts ready, never opens the relay', async ({
  page,
  request,
}) => {
  const project = await createReadyProject(request);
  // A stand-in for WKWebView's script message handler plus a record of relay sockets.
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const posted: unknown[] = [];
    const relaySockets: string[] = [];
    w.__posted = posted;
    w.__relaySockets = relaySockets;
    w.__previzNativeHost = { platform: 'ios', source: 'arkit', bridge: 1 };
    w.webkit = { messageHandlers: { previz: { postMessage: (m: unknown) => posted.push(m) } } };
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url), location.href).pathname === '/ws') relaySockets.push(String(url));
      }
    };
  });

  await page.setViewportSize({ width: 844, height: 390 });
  const problems = watchPage(page, 'phone');
  await page.goto('/phone.html?room=ABCD&pose=external&voice=0&sim=0&governor=0');

  // starts at once: no start gate, page controls hidden, ready posted to native
  await expect
    .poll(() => page.evaluate(() => (window as any).__posted))
    .toEqual([{ type: 'ready' }]);
  await expect(page.locator('#start')).toBeHidden();
  for (const id of ['#joystick', '#controls', '#top-right', '#top-left']) {
    await expect(page.locator(id)).toBeHidden();
  }
  expect((await phoneState(page))?.poseSource).toBe('external');

  const scene: SceneState = {
    type: 'scene',
    projectId: project.id,
    sceneIndex: 1,
    manifestUrl: `/projects/${project.id}/scene-1/manifest.json`,
    time: 0,
    playing: false,
    cameras: [],
    activeCameraId: null,
    speakingLineId: null,
  };
  await page.evaluate((s) => window.__previzMessage!(s), scene);
  await expect
    .poll(async () => (await phoneState(page))?.scene?.manifestUrl)
    .toBe(scene.manifestUrl);

  const pose = (offset: [number, number, number], fovDeg: number): PhonePose => ({
    type: 'pose',
    source: 'arkit',
    t: 0,
    q: [0, 0.7071068, 0, 0.7071068], // 90° yaw
    nudge: [0, 0, 0],
    offset,
    fovDeg,
    recording: false,
  });
  await page.evaluate((p) => window.__previzPose!(p), pose([1, 0, -0.5], 40));
  await expect
    .poll(
      async () => {
        const p = await phoneState(page);
        return p ? { mode: p.viewMode, status: p.viewStatus, drawn: p.framesRendered > 2 } : null;
      },
      { timeout: 30_000 },
    )
    .toEqual({ mode: 'webgl', status: 'ready', drawn: true });

  // position = anchor + offset + nudge; the lens is the pose's (outside the browser's 24–90 clamp)
  const at = async () => {
    const p = (await phoneState(page))!;
    return p.cameraPosition.map((v: number, i: number) => +(v - p.anchor.position[i]!).toFixed(3));
  };
  await expect.poll(at).toEqual([1, 0, -0.5]);
  await page.evaluate((p) => window.__previzPose!(p), pose([-2, 0.25, 1], 15));
  await expect.poll(at).toEqual([-2, 0.25, 1]);
  await expect(page.locator('#lens')).toHaveText(focalLabel(15)); // the pose's fov, unclamped
  expect((await phoneState(page))!.externalPoses).toBe(2);

  // the recording flag in the pose drives the rec badge
  await page.evaluate((p) => window.__previzPose!({ ...p, recording: true }), pose([0, 0, 0], 40));
  await expect(page.locator('#rec-badge')).toBeVisible();

  // the app forwards its room scan: walking near a real wall, then out of the room, warns
  const room: RoomScan = {
    type: 'room',
    source: 'lidar',
    outline: [
      [-2, -3],
      [2, -3],
      [2, 1],
      [-2, 1],
    ],
    floorY: -1.4,
    ceiling: 2.5,
    area: 16,
  };
  await page.evaluate((r) => window.__previzMessage!(r), room);
  await page.evaluate((p) => window.__previzPose!(p), pose([0, 0, -1], 40));
  await expect.poll(async () => (await phoneState(page))?.wall).toBe('clear');
  await expect(page.locator('#wall')).toHaveText('Room scanned');
  await page.evaluate((p) => window.__previzPose!(p), pose([1.7, 0, -1], 40));
  await expect(page.locator('#wall')).toHaveText('Wall 0.3 m');
  await expect(page.locator('body')).toHaveAttribute('data-wall', 'near');
  await page.evaluate((p) => window.__previzPose!(p), pose([2.5, 0, -1], 40));
  await expect(page.locator('#wall')).toContainText('Outside the scanned room');

  expect(await page.evaluate(() => (window as any).__relaySockets)).toEqual([]);
  expect((await phoneState(page))?.posesSent).toBe(0);
  expect(problems).toEqual([]);
});
