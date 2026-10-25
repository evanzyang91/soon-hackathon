// Shots mode (docs/PLAN-v4.md "Coverage"): the first time a scene opens its shot list is seeded
// with coverage framed on the cast; C adds the view as a shot whose frame is grabbed and stored as
// a JPEG; the list survives a reload (scene-0/shots.json); the CSV export lists every shot.
import { expect, test } from '@playwright/test';
import { ShotList } from '../../shared/shots.ts';
import { createReadyProject, laptopState, watchPage } from './helpers.ts';

test('coverage is seeded, C adds a shot with a frame, the list persists and exports', async ({ page, request }) => {
  const project = await createReadyProject(request);
  const problems = watchPage(page, 'laptop');
  const loaded = () =>
    expect.poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 30_000 }).toBe(true);
  await page.goto(`/?project=${project.id}&scene=0`);
  await loaded();
  await page.getByTestId('tab-shots').click();
  const rows = page.getByTestId('shot-row');
  // the fixture's scene 0 has two actors: wide, two-shot, over-the-shoulder, a close-up each
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toHaveAttribute('data-shot', 'Wide master');
  await expect(rows.first().getByTestId('shot-number')).toHaveText('1A');
  await expect(rows.first()).toHaveAttribute('data-source', 'suggested');

  // C: the view becomes shot 1F, selected (frame guide + label), its frame stored as a JPEG
  await page.keyboard.press('c');
  await expect(rows).toHaveCount(6);
  const added = rows.nth(5);
  await expect(added).toHaveAttribute('data-shot', 'Shot 1F');
  await expect(page.getByTestId('shot-label')).toHaveText(/^1F · Shot 1F · \d+ mm$/);
  const frame = added.getByTestId('shot-frame');
  await expect(frame).toHaveAttribute('src', /\/scene-0\/shots\/[^/]+\.jpg/, { timeout: 30_000 });
  const img = await request.get((await frame.getAttribute('src'))!);
  expect(img.headers()['content-type']).toBe('image/jpeg');
  expect((await img.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

  // reload: the list comes back from the server, frame and all
  await page.reload();
  await loaded();
  await page.getByTestId('tab-shots').click();
  await expect(rows).toHaveCount(6);
  await expect(rows.nth(5).getByTestId('shot-frame')).toBeVisible();
  const list = ShotList.parse(await (await request.get(`/api/projects/${project.id}/scenes/0/shots`)).json());
  expect(list.revision).toBeGreaterThanOrEqual(2);
  expect(list.shots.map((s) => s.source)).toEqual([...Array(5).fill('suggested'), 'director']);
  expect(list.shots[5]!.frame).toBe(`scene-0/shots/${list.shots[5]!.id}.jpg`);

  // Export › Shot list (CSV): a header and one row per shot
  await expect(page.getByTestId('export-csv')).toHaveAttribute('href', `/api/projects/${project.id}/shotlist.csv`);
  const csv = await request.get(`/api/projects/${project.id}/shotlist.csv`);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const lines = (await csv.text()).replace(/^﻿/, '').trim().split('\r\n');
  expect(lines[0]).toBe('scene,number,name,lens_mm,height_m,note,lines,frame_url');
  expect(lines).toHaveLength(7);
  expect(lines[1]).toMatch(/^1,1A,Wide master,\d+,/);
  expect(lines[6]).toMatch(/^1,1F,Shot 1F,\d+,.*\/scene-0\/shots\/.+\.jpg$/);
  expect(problems).toEqual([]);
});
