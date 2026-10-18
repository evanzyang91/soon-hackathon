// Self-signed TLS for the dev server. iOS only exposes DeviceOrientation/Motion on secure origins,
// so the phone must load the page over HTTPS from the laptop's LAN IP.
//
// Certs are persisted in ./certs/ (gitignored) so the phone only has to accept the certificate
// once. They are regenerated when the LAN IP set changes (new Wi-Fi) or they near expiry.
// Drop your own key.pem + cert.pem (e.g. from mkcert) into ./certs/ without a meta.json and they
// are used as-is.
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'selfsigned';

export interface Certs {
  key: string;
  cert: string;
}

interface CertMeta {
  generatedBy: 'previz-stage';
  dns: string[];
  ips: string[];
  notAfter: string;
}

const DEFAULT_DIR = fileURLToPath(new URL('../certs/', import.meta.url));
/** iOS rejects server certs valid for more than 825 days; one year is plenty for a dev cert. */
const VALID_DAYS = 365;
/** Regenerate when fewer than this many days remain. */
const RENEW_DAYS = 14;

/** Non-internal IPv4 addresses of this machine (what a phone on the same Wi-Fi can reach). */
export function lanAddresses(): string[] {
  const out = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      // Node 18.0–18.3 reported family as the number 4.
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal) out.add(a.address);
    }
  }
  return [...out];
}

/** Hostnames and IPs the certificate must cover right now. */
export function wantedNames(): { dns: string[]; ips: string[] } {
  const dns = new Set(['localhost']);
  const host = hostname();
  if (host) {
    dns.add(host);
    if (!host.includes('.')) dns.add(`${host}.local`);
  }
  return { dns: [...dns], ips: ['127.0.0.1', '::1', ...lanAddresses()] };
}

function covers(meta: CertMeta, want: { dns: string[]; ips: string[] }): boolean {
  return (
    want.dns.every((d) => meta.dns.includes(d)) && want.ips.every((ip) => meta.ips.includes(ip))
  );
}

function fresh(meta: CertMeta, now: Date): boolean {
  return new Date(meta.notAfter).getTime() - now.getTime() > RENEW_DAYS * 86_400_000;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function generateCerts(want: { dns: string[]; ips: string[] }, now: Date) {
  const notAfter = new Date(now.getTime() + VALID_DAYS * 86_400_000);
  const pems = await generate([{ name: 'commonName', value: 'Previz Stage (dev)' }], {
    keyType: 'rsa',
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate: new Date(now.getTime() - 60_000),
    notAfterDate: notAfter,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
      {
        name: 'subjectAltName',
        altNames: [
          ...want.dns.map((value) => ({ type: 2 as const, value })),
          ...want.ips.map((ip) => ({ type: 7 as const, ip })),
        ],
      },
    ],
  });
  const meta: CertMeta = { generatedBy: 'previz-stage', ...want, notAfter: notAfter.toISOString() };
  return { key: pems.private, cert: pems.cert, meta };
}

/**
 * Load the persisted dev certificate, (re)generating it when missing, expiring, or when it does
 * not cover every current LAN IPv4.
 */
export async function loadOrCreateCerts(dir: string = DEFAULT_DIR): Promise<Certs> {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const metaPath = join(dir, 'meta.json');
  const [key, cert, metaRaw] = await Promise.all([
    readOptional(keyPath),
    readOptional(certPath),
    readOptional(metaPath),
  ]);
  const want = wantedNames();
  const now = new Date();

  if (key && cert) {
    if (metaRaw === null) return { key, cert }; // user-provided (e.g. mkcert): trust as-is
    try {
      const meta = JSON.parse(metaRaw) as CertMeta;
      if (meta.generatedBy === 'previz-stage' && covers(meta, want) && fresh(meta, now)) {
        new X509Certificate(cert); // throws if the file is corrupt
        return { key, cert };
      }
    } catch {
      // fall through and regenerate
    }
  }

  const made = await generateCerts(want, now);
  await mkdir(dir, { recursive: true });
  await writeFile(keyPath, made.key, { mode: 0o600 });
  await writeFile(certPath, made.cert);
  await writeFile(metaPath, JSON.stringify(made.meta, null, 2));
  console.log(`[https] generated self-signed cert for ${[...want.dns, ...want.ips].join(', ')}`);
  return { key: made.key, cert: made.cert };
}
