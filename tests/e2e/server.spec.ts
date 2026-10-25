// (e) Server endpoints the devices depend on: the iOS certificate download, health, and a room
// whose phone URL a phone on the LAN can actually open.
import { networkInterfaces } from 'node:os';
import { expect, test } from '@playwright/test';

const lanIPv4 = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a!.address);

test('/cert.pem serves the dev certificate for iOS', async ({ request }) => {
  const res = await request.get('/cert.pem');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('application/x-x509-ca-cert');
  expect(res.headers()['content-disposition']).toContain('.pem');
  expect(await res.text()).toMatch(/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/);
});

test('/api/health reports MOCK mode and key presence (never values)', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.ok()).toBe(true);
  const body = (await res.json()) as { ok: boolean; mock: boolean; keys: Record<string, unknown> };
  expect(body.ok).toBe(true);
  expect(body.mock).toBe(true);
  expect(Object.keys(body.keys).sort()).toEqual(['anthropic', 'higgsfield', 'marble', 'modal', 'tts']);
  for (const v of Object.values(body.keys)) expect(typeof v).toBe('boolean');
});

test('/api/rooms/new hands out a fresh room with a phone URL that is not localhost', async ({
  request,
}) => {
  const a = (await (await request.get('/api/rooms/new')).json()) as { room: string; phoneUrl: string };
  const b = (await (await request.get('/api/rooms/new')).json()) as { room: string; phoneUrl: string };
  expect(a.room).toMatch(/^[A-Z0-9]{4}$/);
  expect(b.room).not.toBe(a.room);
  const url = new URL(a.phoneUrl);
  expect(url.protocol).toBe('https:');
  expect(url.pathname).toBe('/phone.html');
  expect(url.searchParams.get('room')).toBe(a.room);
  const lan = lanIPv4();
  test.skip(lan.length === 0, 'this machine has no LAN IPv4 address to hand to a phone');
  expect(['localhost', '127.0.0.1', '::1', '[::1]']).not.toContain(url.hostname);
  expect(lan).toContain(url.hostname);
});
