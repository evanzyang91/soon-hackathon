// (c) Project chat on the real MOCK server: Send the screenplay → the plan card (3 scenes, the
// cast) → amend in words ("make Theo taller") → a reference photo for Maya through the attachment
// target picker → Generate on the plan card → the scenes build and the first ready scene opens.
// Needs the chat routes (shared/api.ts: uploads, chat, generate); CHAT_E2E=1 turns it on.
import { expect, test, type Page } from '@playwright/test';
import { FIXTURE, laptopState, watchPage } from './helpers.ts';

test.skip(
  !process.env.CHAT_E2E,
  'needs the project chat routes on the server; run with CHAT_E2E=1',
);

/** A small portrait PNG drawn in the page (the upload path decodes and re-encodes it). */
async function portrait(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 300;
    c.height = 400;
    const g = c.getContext('2d')!;
    g.fillStyle = '#6d7f9c';
    g.fillRect(0, 0, 300, 400);
    g.fillStyle = '#e0b48c';
    g.beginPath();
    g.arc(150, 110, 45, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#f2c230';
    g.fillRect(95, 165, 110, 150);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}

test('chat: plan → "make Theo taller" → photo for Maya → Generate → the first scene opens', async ({
  page,
}) => {
  const problems = watchPage(page, 'chat');
  await page.goto('/');
  await expect(page.locator('#health')).toHaveText('MOCK');
  // no scene open: the chat fills the viewport
  await expect(page.locator('#chat-home [data-testid=chat-hero]')).toBeVisible();

  // Send: a draft project, the plan card
  await page.getByTestId('screenplay').fill(FIXTURE);
  await page.getByTestId('chat-send').click();
  const card = page.getByTestId('plan-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('plan-scene')).toHaveCount(3);
  await expect(card.getByTestId('plan-character')).toHaveText([/Theo/, /Maya/]);
  await expect(page.getByTestId('chat-title')).toHaveText('The Last Bus');
  await expect(page.getByTestId('plan-generate')).toBeVisible();

  // amend in words: 10 cm taller than planned (the MOCK planner's "tall" Theo is 1.80 m; 1.70 when unset)
  const theoHeight = card.locator('[data-character=theo] [data-testid=plan-height]');
  const planned = parseFloat((await theoHeight.textContent()) ?? '');
  const taller = `${(Math.round((planned + 0.1) * 100) / 100).toFixed(2)} m`;
  await page.getByTestId('screenplay').fill('make Theo taller');
  await page.getByTestId('screenplay').press('Enter');
  const patch = page.locator('[data-testid=action-card][data-type=plan-patch]').last();
  await expect(patch).toBeVisible({ timeout: 20_000 });
  await expect(patch).toHaveAttribute('data-status', 'applied');
  await expect(patch).toContainText(taller);
  await expect(theoHeight).toHaveText(taller);

  // a reference photo, targeted at Maya with the picker
  await page
    .getByTestId('chat-file')
    .setInputFiles({ name: 'maya.png', mimeType: 'image/png', buffer: await portrait(page) });
  await page.getByTestId('attach-target').click();
  await page.locator('[data-testid=attach-target-option][data-value="character:maya"]').click();
  await expect(page.getByTestId('attach-target')).toContainText('Maya');
  await page.getByTestId('screenplay').fill('here is Maya in costume');
  await page.getByTestId('chat-send').click();
  const ref = page.locator('[data-testid=action-card][data-type=character-reference]');
  await expect(ref).toBeVisible({ timeout: 20_000 });
  await expect(ref).toHaveAttribute('data-status', 'applied');
  await expect(page.locator('[data-testid=msg-user] img.msg-thumb')).toHaveCount(1);
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0);

  // Generate on the plan card: the MOCK pipeline builds and the first ready scene opens
  await page.getByTestId('plan-generate').click();
  await expect
    .poll(async () => (await laptopState(page)).sceneLoaded, { timeout: 45_000 })
    .toBe(true);
  const s = await laptopState(page);
  expect(s.error).toBeNull();
  expect(s.sceneIndex).toBe(0);
  expect(s.actors.map((a) => a.id).sort()).toEqual(['maya', 'theo']);
  await expect(page.locator('#hud-title')).toHaveText('EXT. CITY STREET - NIGHT');
  // the same thread docks in the drawer next to the open scene; the draft's Generate is gone
  await expect(page.locator('#left [data-testid=chat] [data-testid=plan-card]')).toBeVisible();
  await expect(page.getByTestId('plan-generate')).toHaveCount(0);
  await expect(
    page.locator(`[data-testid=project][data-id="${s.projectId}"] [data-testid=scene-row]`),
  ).toHaveCount(3);

  expect(problems).toEqual([]);
});
