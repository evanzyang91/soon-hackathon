// (d) The phone renders the scene in WebGL on its own page. A Node WebSocket client plays the
// laptop (hello + SceneState) so only the phone page uses the GPU; `?governor=0` keeps rendering
// at full quality even though SwiftShader is slow.
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';
import type { SceneState } from '../../shared/protocol.ts';
import { createReadyProject, phoneState, pixelStats, watchPage } from './helpers.ts';

test('phone renders the scene (non-black, distinct colours) with ?governor=0', async ({
  page,
  request,
  baseURL,
}) => {
  const project = await createReadyProject(request);
  const { room } = (await (await request.get('/api/rooms/new')).json()) as { room: string };

  // a headless "laptop" on the relay
  const ws = new WebSocket(`${baseURL!.replace(/^https/, 'wss')}/ws`, { rejectUnauthorized: false });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
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
  ws.send(JSON.stringify({ type: 'hello', role: 'laptop', room }));
  ws.send(JSON.stringify(scene));

  try {
    await page.setViewportSize({ width: 844, height: 390 });
    const problems = watchPage(page, 'phone');
    await page.goto(`/phone.html?room=${room}&sim=1&autostart=1&governor=0`);
    await expect.poll(async () => (await phoneState(page))?.conn).toBe('open');
    await expect
      .poll(async () => (await phoneState(page))?.scene?.manifestUrl)
      .toBe(scene.manifestUrl);
    await expect
      .poll(
        async () => {
          const p = await phoneState(page);
          return p ? { mode: p.viewMode, status: p.viewStatus, drawn: p.framesRendered > 2 } : null;
        },
        { timeout: 30_000 },
      )
      .toEqual({ mode: 'webgl', status: 'ready', drawn: true });
    expect((await phoneState(page))?.renderLevel).toBe(0); // governor off: full quality
    await expect(page.locator('body')).toHaveAttribute('data-view', 'webgl');
    await expect(page.locator('#gl')).toBeVisible();

    const px = await pixelStats(page, '#gl');
    expect(px.nonBlack).toBeGreaterThan(0.6);
    expect(px.distinct).toBeGreaterThan(40);
    expect(problems).toEqual([]);
  } finally {
    ws.close();
  }
});
