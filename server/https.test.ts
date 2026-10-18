import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lanAddresses, loadOrCreateCerts } from './https.ts';

const dirs: string[] = [];
const tempDir = async () => {
  const d = await mkdtemp(join(tmpdir(), 'previz-certs-'));
  dirs.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe('lanAddresses', () => {
  it('returns unique non-loopback IPv4 strings', () => {
    const ips = lanAddresses();
    expect(new Set(ips).size).toBe(ips.length);
    for (const ip of ips) {
      expect(ip).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(ip.startsWith('127.')).toBe(false);
    }
  });
});

describe('loadOrCreateCerts', () => {
  it('creates a cert with SANs for localhost, 127.0.0.1 and every LAN IPv4, then reuses it', async () => {
    const dir = await tempDir();
    const first = await loadOrCreateCerts(dir);
    const x = new X509Certificate(first.cert);
    const san = x.subjectAltName ?? '';
    expect(san).toContain('DNS:localhost');
    expect(san).toContain('IP Address:127.0.0.1');
    for (const ip of lanAddresses()) expect(san).toContain(`IP Address:${ip}`);
    expect(x.checkPrivateKey((await import('node:crypto')).createPrivateKey(first.key))).toBe(true);
    // iOS: ≤ 825 days validity, serverAuth EKU.
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / 86_400_000;
    expect(days).toBeLessThanOrEqual(825);
    expect(x.keyUsage ?? []).toContain('1.3.6.1.5.5.7.3.1');

    const second = await loadOrCreateCerts(dir);
    expect(second.cert).toBe(first.cert);
  }, 30_000);

  it('regenerates when the stored cert does not cover the current IPs', async () => {
    const dir = await tempDir();
    const first = await loadOrCreateCerts(dir);
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ ...meta, ips: ['127.0.0.1'] }));
    const again = await loadOrCreateCerts(dir);
    expect(again.cert).not.toBe(first.cert);
  }, 30_000);

  it('uses user-provided certs (no meta.json) untouched', async () => {
    const dir = await tempDir();
    const made = await loadOrCreateCerts(dir);
    await rm(join(dir, 'meta.json'));
    const mine = await loadOrCreateCerts(dir);
    expect(mine).toEqual(made);
  }, 30_000);
});
