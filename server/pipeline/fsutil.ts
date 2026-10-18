// Durable little file helpers: atomic JSON writes (tmp + fsync + rename) so a crash never leaves a
// half-written receipt/status/manifest, and tolerant reads for resumable state.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Creates `path` only if it does not exist yet; false when someone else already did. */
export async function writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return true;
}

export async function readJson<T = unknown>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  return JSON.parse(text) as T;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Host + path of a URL for logs; never the query string (presigned URLs carry credentials). */
export function safeEndpoint(url: string): string {
  try {
    const u = new URL(url);
    const host = /^[A-Za-z0-9.-]{1,253}$/.test(u.hostname) ? u.hostname : 'unknown-host';
    const path = /^\/[A-Za-z0-9._~/:-]{0,512}$/.test(u.pathname) ? u.pathname : '/';
    return `${host}${path}`;
  } catch {
    return 'invalid-url';
  }
}
