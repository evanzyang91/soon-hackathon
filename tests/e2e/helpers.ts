// Shared e2e helpers: project creation over the API, page problem collection, canvas pixel stats.
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { Euler, Quaternion } from 'three';
import { ProjectStatus } from '../../shared/schema.ts';

export const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

/** Seconds a MOCK pipeline may take for the 3-scene fixture (it usually needs ~1 s). */
const PIPELINE_TIMEOUT_MS = 30_000;

export const sceneDone = (st: ProjectStatus) =>
  st.parse.status === 'done' &&
  st.scenes.length > 0 &&
  st.scenes.every((s) => s.stages.manifest.status === 'done' && !!s.manifestUrl);

/** POSTs a screenplay (default: the fixture) and waits until every scene has a manifest. */
export async function createReadyProject(
  request: APIRequestContext,
  screenplay = FIXTURE,
): Promise<ProjectStatus> {
  const res = await request.post('/api/projects', { data: { screenplay } });
  expect(res.status()).toBe(202);
  const { id } = ProjectStatus.parse(await res.json());
  let last: ProjectStatus | undefined;
  await expect
    .poll(
      async () => {
        last = ProjectStatus.parse(await (await request.get(`/api/projects/${id}`)).json());
        return sceneDone(last);
      },
      { timeout: PIPELINE_TIMEOUT_MS, intervals: [250, 500] },
    )
    .toBe(true);
  return last!;
}

/**
 * Collects everything that would be a bug in front of a user: uncaught errors, console.error,
 * and failed (4xx/5xx) responses. Assert it is empty at the end of a test.
 */
export function watchPage(page: Page, name: string): string[] {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`${name} pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${name} console.error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`${name} HTTP ${r.status()} ${r.url()}`);
  });
  return problems;
}

export interface PixelStats {
  /** Fraction of pixels whose brightest channel is above 24/255. */
  nonBlack: number;
  /** Distinct colours after quantizing to 4 bits per channel. */
  distinct: number;
}

/**
 * Screenshots an element's box (what the user actually sees) and measures it in Node, so a page
 * whose main thread is busy rendering in software GL is not asked to decode images too.
 */
export async function pixelStats(page: Page, selector: string): Promise<PixelStats> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} is not visible`);
  const png = await page.screenshot({ clip: box, animations: 'allow', caret: 'initial' });
  const { width, height, rgba } = decodePng(png);
  let lit = 0;
  const colours = new Set<number>();
  for (let i = 0; i < width * height * 4; i += 4) {
    const r = rgba[i]!;
    const g = rgba[i + 1]!;
    const b = rgba[i + 2]!;
    if (Math.max(r, g, b) > 24) lit++;
    colours.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  return { nonBlack: lit / (width * height), distinct: colours.size };
}

/** Minimal decoder for the 8-bit, non-interlaced RGB/RGBA PNGs Chromium screenshots produce. */
export function decodePng(buf: Buffer): { width: number; height: number; rgba: Uint8Array } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const [depth, colour, , , interlace] = [data[8], data[9], data[10], data[11], data[12]];
      channels = colour === 6 ? 4 : colour === 2 ? 3 : 0;
      if (depth !== 8 || !channels || interlace) throw new Error('unsupported PNG layout');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels]! : 0;
      const b = y > 0 ? px[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels]! : 0;
      let v = src[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  if (channels === 4) return { width, height, rgba: px };
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < px.length; i += 3, j += 4) {
    rgba[j] = px[i]!;
    rgba[j + 1] = px[i + 1]!;
    rgba[j + 2] = px[i + 2]!;
    rgba[j + 3] = 255;
  }
  return { width, height, rgba };
}

/** Heading (yaw about +Y) of an [x, y, z, w] quaternion, degrees in (-180, 180]. */
export function yawDeg(q: number[]): number {
  const e = new Euler().setFromQuaternion(new Quaternion(q[0], q[1], q[2], q[3]), 'YXZ');
  return (e.y * 180) / Math.PI;
}

/** Smallest absolute difference between two angles in degrees. */
export const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Laptop debug snapshot (web/src/laptop/debug.ts). */
export const laptopState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __previz: { state(): LaptopState } }).__previz.state());

/** Phone debug snapshot (web/src/phone/main.ts, see web/src/phone/README.md). */
export const phoneState = (page: Page) =>
  page.evaluate(() => {
    const p = (window as unknown as { __phone?: Record<string, unknown> }).__phone;
    if (!p) return null;
    // functions do not survive structured cloning; copy the data fields only
    return JSON.parse(JSON.stringify(p)) as PhoneState;
  });

export interface LaptopState {
  sceneLoaded: boolean;
  error: string | null;
  placeholder: boolean;
  projectId: string | null;
  sceneIndex: number | null;
  time: number;
  playing: boolean;
  speakingLineId: string | null;
  cameras: number;
  activeCameraId: string | null;
  linkStatus: string;
  room: string | null;
  phones: number;
  lastPose: { phoneId?: string; q: number[]; aspect?: number } | null;
  gizmo: { visible: boolean; position: number[]; quaternion: number[] };
  roomScan: { area: number; points: number; drawn: boolean } | null;
  pip: { visible: boolean; label: string; frames: number };
  mainFrames: number;
  lastStillAt: number;
  ground: { cols: number; rows: number; cell: number } | null;
  actors: { id: string; kind: string; position: number[]; groundY: number; heightMeters: number | null; placementCorrected: boolean }[];
  dynamics: { id: string; position: number[]; phase: string }[];
  voice: { context: string; playing: string[]; level: number; heard: string[]; peak: number };
}

export interface PhoneState {
  conn: string;
  peers: { laptop: boolean; phones: number };
  posesSent: number;
  lastPose: { q: number[]; fovDeg: number } | null;
  orientationEvents: number;
  scene: { manifestUrl: string; speakingLineId: string | null; activeCameraId: string | null } | null;
  viewMode: 'webgl' | 'viewfinder';
  viewStatus: string;
  renderLevel: number;
  framesRendered: number;
  yawOffset: number;
  anchor: { name: string; key: string; yaw: number; position: number[] };
  cameraPosition: number[];
  poseSource: 'external' | 'sensors';
  externalPoses: number;
  wall: null | 'clear' | 'near' | 'outside';
}
