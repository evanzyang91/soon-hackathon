// World Labs Marble text → world client with durable receipts.
//
// Every remote step is bracketed by a durable receipt in <outDir>/marble-receipt.json so a crash
// or restart never pays for a second generation:
//   no receipt / 'rejected'   → claim the receipt exclusively, POST worlds:generate
//   'submitting' (no op id)   → the POST may or may not have reached Marble: refuse to resubmit
//   'submitted'  (op id)      → poll the recorded operation, never resubmit
//   'failed'                  → provider reported an error; resubmitted only with retryFailed
//   'generated'  (world id)   → GET the world and download its assets (no generation)
//   'complete'                → assets on disk, verified by size + sha256: no network at all
// MARBLE_DRY_RUN=1 (or opts.dryRun) stops before the POST: it logs the exact request body, writes
// it to <outDir>/marble-dry-run.json, and returns the mock world (provider 'mock') so the rest of
// a live pipeline continues without spending credits.
// Downloads are atomic (tmp + rename), SPZs must be gzip with an NGSP header, and URLs in the
// returned WorldAsset are filenames relative to outDir.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { WorldAsset } from '../../shared/schema.ts';
import { env } from '../env.ts';
import { exists, readJson, safeEndpoint, writeJsonAtomic, writeJsonExclusive } from './fsutil.ts';
import { MOCK_WORLD_DIR, writeMockWorld } from './mock-world.ts';
import { readSpzHeader } from './spz.ts';

export const MARBLE_MODELS = ['marble-1.1', 'marble-1.0-draft', 'marble-1.1-plus'] as const;
export type MarbleModel = (typeof MARBLE_MODELS)[number];
export const RECEIPT_FILE = 'marble-receipt.json';
export const DRY_RUN_FILE = 'marble-dry-run.json';
export const ASSET_FILE = 'world-asset.json';
export const WORLD_FILE = 'marble-world.json';
const BASE_URL = 'https://api.worldlabs.ai';

export interface MarbleDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  apiKey?: string;
  baseUrl?: string;
  /** Default 10 s. */
  pollIntervalMs?: number;
  /** Give up polling after this long (the receipt keeps the op id; a rerun resumes). Default 30 min. */
  timeoutMs?: number;
}

export interface GenerateWorldOptions {
  prompt: string;
  /** Marble display name. */
  name: string;
  outDir: string;
  model?: string;
  mock: boolean;
  log: (m: string) => void;
  /** Explicit user retry: resubmit if the provider reported the previous generation as failed. */
  retryFailed?: boolean;
  /** Log the generate request instead of sending it and return the mock world. Default: env. */
  dryRun?: boolean;
  /**
   * Generate from an image instead of the text prompt (scoped re-prompt regeneration: the world's
   * own panorama, edited): the PNG is uploaded as a Marble media asset and sent as the image
   * prompt; `prompt` then only names the change (it keys the receipt).
   */
  imagePrompt?: ImagePrompt;
  /**
   * Generate from a video (the director's scanned room, recorded by the ARKit app): uploaded as a
   * Marble media asset (≤ 100 MB) and sent as the video prompt; `prompt` keys the receipt.
   */
  videoPrompt?: VideoPrompt;
  deps?: MarbleDeps;
}

export interface VideoPrompt {
  /** Local .mp4 / .mov file. */
  file: string;
  /** Optional text alongside the video (omitted: Marble captions it). */
  textPrompt?: string;
}

/** Marble's limit for a video prompt. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

export interface ImagePrompt {
  /** Local PNG file. */
  file: string;
  /** true for an equirectangular 360° panorama. */
  isPano: boolean;
  /** Optional text alongside the image (omitted: Marble captions the image itself). */
  textPrompt?: string;
}

/** `POST /marble/v1/media-assets:prepare_upload` body for a PNG (or a video: mp4 / mov). */
export function prepareUploadBody(fileName: string) {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return ['mp4', 'mov', 'webm'].includes(ext)
    ? { file_name: fileName, kind: 'video', extension: ext }
    : { file_name: fileName, kind: 'image', extension: 'png' };
}

/** The exact `POST /marble/v1/worlds:generate` body for an uploaded video prompt. */
export function videoRequestBody(o: { name: string; model?: string; mediaAssetId: string; textPrompt?: string }) {
  return {
    display_name: o.name.slice(0, 100),
    model: marbleModel(o.model),
    world_prompt: {
      type: 'video',
      video_prompt: { source: 'media_asset', media_asset_id: o.mediaAssetId },
      ...(o.textPrompt ? { text_prompt: o.textPrompt, disable_recaption: true } : {}),
    },
    permission: { public: false },
  };
}

/** The exact `POST /marble/v1/worlds:generate` body for an uploaded image prompt. */
export function imageRequestBody(o: { name: string; model?: string; mediaAssetId: string; isPano: boolean; textPrompt?: string }) {
  return {
    display_name: o.name.slice(0, 100),
    model: marbleModel(o.model),
    world_prompt: {
      type: 'image',
      image_prompt: { source: 'media_asset', media_asset_id: o.mediaAssetId },
      is_pano: o.isPano,
      ...(o.textPrompt ? { text_prompt: o.textPrompt, disable_recaption: true } : {}),
    },
    permission: { public: false },
  };
}

type ReceiptStatus = 'submitting' | 'rejected' | 'submitted' | 'failed' | 'generated' | 'complete';
export interface MarbleReceipt {
  schema: 'previz.marble-receipt/1';
  status: ReceiptStatus;
  name: string;
  model: string;
  promptSha256: string;
  operation_id?: string;
  world_id?: string;
  /** Media asset of an image prompt (re-prompt regeneration from an edited panorama). */
  media_asset_id?: string;
  error?: string;
  progress?: string;
  files?: Record<string, { bytes: number; sha256: string }>;
  /** Earlier attempts that ended 'rejected'/'failed' and were superseded. */
  history?: { status: ReceiptStatus; operation_id?: string; error?: string; updatedAt: string }[];
  createdAt: string;
  updatedAt: string;
}

export class MarbleError extends Error {
  constructor(
    message: string,
    readonly kind: 'http' | 'network' | 'uncertain' | 'failed' | 'timeout' | 'invalid' = 'invalid',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MarbleError';
  }
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
// Definitely-not-sent network failures (no connection was ever made).
const PRE_CONNECT = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

export function marbleModel(m: string | undefined): MarbleModel {
  return (MARBLE_MODELS as readonly string[]).includes(m ?? '') ? (m as MarbleModel) : 'marble-1.1';
}

/** The exact `POST /marble/v1/worlds:generate` body for a text prompt. */
export function generateRequestBody(o: { name: string; prompt: string; model?: string }) {
  return {
    display_name: o.name.slice(0, 100),
    model: marbleModel(o.model),
    world_prompt: { type: 'text', text_prompt: o.prompt, disable_recaption: true },
    permission: { public: false },
  };
}

export async function generateWorld(opts: GenerateWorldOptions): Promise<WorldAsset> {
  await mkdir(opts.outDir, { recursive: true });
  if (opts.mock) return mockWorld(opts.outDir, opts.log);
  if (opts.dryRun ?? env.marbleDryRun) {
    const base = opts.deps?.baseUrl ?? BASE_URL;
    const url = `${base}/marble/v1/worlds:generate`;
    if (opts.videoPrompt) {
      const vid = opts.videoPrompt;
      const bytes = (await stat(vid.file)).size;
      const upload = { method: 'POST', url: `${base}/marble/v1/media-assets:prepare_upload`, body: prepareUploadBody(basename(vid.file)) };
      const body = videoRequestBody({ ...opts, ...vid, mediaAssetId: '<dry-run: not uploaded>' });
      await writeJsonAtomic(join(opts.outDir, DRY_RUN_FILE), {
        upload: { ...upload, then: `PUT <upload_url> ${bytes} bytes (${vid.file})` },
        generate: { method: 'POST', url, body },
      });
      opts.log(`marble: DRY RUN (MARBLE_DRY_RUN=1), not uploaded: ${bytes} byte video; not submitted: POST ${url} ${JSON.stringify(body)}`);
      return mockWorld(opts.outDir, opts.log);
    }
    if (opts.imagePrompt) {
      const img = opts.imagePrompt;
      const bytes = (await stat(img.file)).size;
      const upload = { method: 'POST', url: `${base}/marble/v1/media-assets:prepare_upload`, body: prepareUploadBody(basename(img.file)) };
      const body = imageRequestBody({ ...opts, ...img, mediaAssetId: '<dry-run: not uploaded>' });
      await writeJsonAtomic(join(opts.outDir, DRY_RUN_FILE), {
        upload: { ...upload, then: `PUT <upload_url> image/png ${bytes} bytes (${img.file})` },
        generate: { method: 'POST', url, body },
      });
      opts.log(`marble: DRY RUN (MARBLE_DRY_RUN=1), not uploaded: POST ${upload.url} ${JSON.stringify(upload.body)} + PUT ${bytes} bytes`);
      opts.log(`marble: DRY RUN (MARBLE_DRY_RUN=1), not submitted: POST ${url} ${JSON.stringify(body)}`);
      return mockWorld(opts.outDir, opts.log);
    }
    const body = generateRequestBody(opts);
    await writeJsonAtomic(join(opts.outDir, DRY_RUN_FILE), { method: 'POST', url, body });
    opts.log(`marble: DRY RUN (MARBLE_DRY_RUN=1), not submitted: POST ${url} ${JSON.stringify(body)}`);
    return mockWorld(opts.outDir, opts.log);
  }
  return new MarbleRun(opts).run();
}

async function mockWorld(outDir: string, log: (m: string) => void): Promise<WorldAsset> {
  const src = join(MOCK_WORLD_DIR, 'world.spz');
  if (!(await exists(src))) {
    log('mock world fixture missing; regenerating fixtures/mock-world');
    await writeMockWorld();
  }
  await copyFile(src, join(outDir, 'world.spz'));
  const asset: WorldAsset = {
    provider: 'mock',
    spz: { k500: 'world.spz' },
    metricScaleFactor: 1,
    groundPlaneOffset: 0,
    opencvFrame: true, // the fixture is stored in Marble's OpenCV frame, like a real world
  };
  if (await exists(join(MOCK_WORLD_DIR, 'thumbnail.png'))) {
    await copyFile(join(MOCK_WORLD_DIR, 'thumbnail.png'), join(outDir, 'thumbnail.png'));
    asset.thumbnail = 'thumbnail.png';
  }
  await writeJsonAtomic(join(outDir, ASSET_FILE), asset);
  log('mock world: copied fixtures/mock-world');
  return asset;
}

class MarbleRun {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly apiKey: string;
  private readonly base: string;
  private readonly interval: number;
  private readonly timeout: number;
  private readonly receiptPath: string;
  private readonly model: MarbleModel;

  constructor(private readonly o: GenerateWorldOptions) {
    const d = o.deps ?? {};
    this.fetch = d.fetch ?? globalThis.fetch;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.apiKey = d.apiKey ?? env.keys.marble;
    this.base = d.baseUrl ?? BASE_URL;
    this.interval = d.pollIntervalMs ?? 10_000;
    this.timeout = d.timeoutMs ?? 30 * 60_000;
    this.receiptPath = join(o.outDir, RECEIPT_FILE);
    this.model = marbleModel(o.model);
  }

  private log(m: string) {
    this.o.log(`marble: ${m}`);
  }

  async run(): Promise<WorldAsset> {
    let r = await readJson<MarbleReceipt>(this.receiptPath);
    if (r && r.promptSha256 !== sha256(this.o.prompt)) {
      this.log(
        'receipt was made for a different prompt; reusing that world (delete the receipt to regenerate)',
      );
    }
    if (r?.status === 'complete') {
      const asset = await this.verifiedAsset(r);
      if (asset) {
        this.log(`world ${r.world_id} already downloaded`);
        return asset;
      }
      this.log('downloaded assets missing or changed; fetching the world again (no generation)');
      r = await this.save(r, { status: 'generated' });
    }
    if (!r || r.status === 'rejected' || (r.status === 'failed' && this.o.retryFailed)) {
      r = await this.submit(r);
    }
    if (r.status === 'failed') {
      throw new MarbleError(
        `generation failed: ${r.error ?? 'unknown error'} (retry the world stage to resubmit)`,
        'failed',
      );
    }
    if (r.status === 'submitting') {
      throw new MarbleError(
        'a previous submission has no recorded operation id, so its charge status is unknown. ' +
          'Check platform.worldlabs.ai; if no world was created, delete ' +
          `${this.receiptPath} and retry. Not resubmitting.`,
        'uncertain',
      );
    }
    if (r.status === 'submitted') r = await this.poll(r);
    return this.fetchWorld(r);
  }

  private async save(r: MarbleReceipt, patch: Partial<MarbleReceipt>): Promise<MarbleReceipt> {
    const next = { ...r, ...patch, updatedAt: nowIso() };
    await writeJsonAtomic(this.receiptPath, next);
    return next;
  }

  private async api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = this.base + path;
    if (!this.apiKey) throw new MarbleError('WLT_API_KEY is not set', 'invalid');
    let res: Response;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          'WLT-Api-Key': this.apiKey,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error', // never forward the key to another origin
      });
    } catch (e) {
      const code = (e as { cause?: { code?: string } }).cause?.code;
      const err = new MarbleError(
        `${method} ${safeEndpoint(url)} -> network error${code ? ` (${code})` : ''}`,
        'network',
      );
      (err as MarbleError & { preConnect?: boolean }).preConnect = !!code && PRE_CONNECT.has(code);
      throw err;
    }
    if (!res.ok) {
      // Provider error bodies may echo request data; keep only a short plain message.
      let detail = '';
      try {
        const j = (await res.json()) as {
          message?: unknown;
          detail?: unknown;
          error?: { message?: unknown };
        };
        const m = j.message ?? j.detail ?? j.error?.message;
        if (typeof m === 'string')
          detail = `: ${m.replace(/https?:\/\/\S+/g, '<url>').slice(0, 200)}`;
      } catch {
        /* not JSON */
      }
      throw new MarbleError(
        `${method} ${safeEndpoint(url)} -> HTTP ${res.status}${detail}`,
        'http',
        res.status,
      );
    }
    return (await res.json()) as T;
  }

  private async submit(prev: MarbleReceipt | undefined): Promise<MarbleReceipt> {
    // an image prompt is uploaded first (free, no receipt needed: nothing is charged yet)
    const img = this.o.imagePrompt;
    const vid = this.o.videoPrompt;
    const mediaAssetId = vid
      ? await this.uploadImage(vid.file)
      : img
        ? await this.uploadImage(img.file)
        : undefined;
    const body =
      vid && mediaAssetId
        ? videoRequestBody({ ...this.o, ...vid, model: this.model, mediaAssetId })
        : img && mediaAssetId
          ? imageRequestBody({ ...this.o, ...img, model: this.model, mediaAssetId })
          : generateRequestBody({ ...this.o, model: this.model });
    const t = nowIso();
    let r: MarbleReceipt = {
      schema: 'previz.marble-receipt/1',
      status: 'submitting',
      name: this.o.name,
      model: this.model,
      promptSha256: sha256(this.o.prompt),
      history: prev
        ? [
            ...(prev.history ?? []),
            {
              status: prev.status,
              operation_id: prev.operation_id,
              error: prev.error,
              updatedAt: prev.updatedAt,
            },
          ]
        : [],
      ...(mediaAssetId ? { media_asset_id: mediaAssetId } : {}),
      createdAt: t,
      updatedAt: t,
    };
    if (!prev) {
      // Exclusive claim: two processes racing on the same outDir cannot both submit.
      if (!(await writeJsonExclusive(this.receiptPath, r))) {
        throw new MarbleError(
          'another process just claimed this world; rerun to recover its receipt',
          'uncertain',
        );
      }
    } else {
      await writeJsonAtomic(this.receiptPath, r);
    }
    this.log(`submitting ${this.model} "${body.display_name}" (${this.o.prompt.length} chars)`);
    let op: { operation_id?: string; id?: string; done?: boolean };
    try {
      op = await this.api('POST', '/marble/v1/worlds:generate', body);
    } catch (e) {
      const err = e as MarbleError & { preConnect?: boolean };
      // A 4xx (or a connection that was never made) means Marble did not accept the job.
      if ((err.kind === 'http' && (err.status ?? 500) < 500) || err.preConnect) {
        await this.save(r, { status: 'rejected', error: err.message });
      }
      throw err;
    }
    const operationId = op.operation_id ?? op.id;
    if (typeof operationId !== 'string' || !operationId) {
      // Keep 'submitting': something was accepted but we cannot recover it automatically.
      throw new MarbleError(
        'worlds:generate returned no operation_id; check the Marble account',
        'uncertain',
      );
    }
    r = await this.save(r, { status: 'submitted', operation_id: operationId });
    this.log(`operation ${operationId} submitted`);
    return r;
  }

  /** prepare_upload + PUT of a PNG or a video; returns the media asset id. */
  private async uploadImage(file: string): Promise<string> {
    const data = await readFile(file);
    const kind = prepareUploadBody(basename(file));
    if (kind.kind === 'video' && data.length > MAX_VIDEO_BYTES)
      throw new MarbleError(`${basename(file)} is ${data.length} bytes; Marble takes ≤ 100 MB`, 'invalid');
    const contentType = kind.kind === 'video' ? (kind.extension === 'mov' ? 'video/quicktime' : `video/${kind.extension}`) : 'image/png';
    const prepared = await this.api<{
      media_asset?: { id?: string; media_asset_id?: string };
      upload_info?: { upload_url?: string; upload_method?: string; required_headers?: Record<string, string> };
    }>('POST', '/marble/v1/media-assets:prepare_upload', prepareUploadBody(basename(file)));
    const id = prepared.media_asset?.id ?? prepared.media_asset?.media_asset_id;
    const info = prepared.upload_info;
    if (typeof id !== 'string' || !id || !info?.upload_url)
      throw new MarbleError('prepare_upload returned no media asset / upload URL', 'invalid');
    let res: Response;
    try {
      // presigned upload URL: authenticates itself, never send the API key there
      res = await this.fetch(info.upload_url, {
        method: info.upload_method ?? 'PUT',
        headers: { 'content-type': contentType, ...(info.required_headers ?? { 'x-goog-content-length-range': '0,104857600' }) },
        body: data,
      });
    } catch {
      throw new MarbleError(`upload ${safeEndpoint(info.upload_url)} -> network error`, 'network');
    }
    if (!res.ok) throw new MarbleError(`upload ${safeEndpoint(info.upload_url)} -> HTTP ${res.status}`, 'http', res.status);
    this.log(`uploaded ${basename(file)} (${data.length} bytes) as media asset ${id}`);
    return id;
  }

  private async poll(r: MarbleReceipt): Promise<MarbleReceipt> {
    const id = r.operation_id!;
    const started = Date.now();
    let lastNote = '';
    let lastLogAt = 0;
    let errors = 0;
    let firstErrorAt = 0;
    // The operation is already paid for, so a laptop losing Wi-Fi for a while must not fail it:
    // keep retrying transient errors until they have persisted this long.
    const TRANSIENT_BUDGET_MS = 15 * 60_000;
    this.log(`polling operation ${id} every ${Math.round(this.interval / 1000)} s`);
    for (;;) {
      let op: {
        done?: boolean;
        error?: unknown;
        metadata?: { world_id?: string; progress?: { status?: string; description?: string } };
        response?: { world_id?: string; id?: string; world?: { world_id?: string; id?: string } };
      };
      try {
        op = await this.api('GET', `/marble/v1/operations/${encodeURIComponent(id)}`);
        errors = 0;
        firstErrorAt = 0;
      } catch (e) {
        const err = e as MarbleError;
        const transient =
          err.kind === 'network' ||
          (err.kind === 'http' && ((err.status ?? 0) >= 500 || err.status === 429));
        if (!transient) throw err;
        firstErrorAt ||= Date.now();
        const down = Date.now() - firstErrorAt;
        if (down >= TRANSIENT_BUDGET_MS) throw err;
        errors += 1;
        this.log(
          `${err.message}; retrying (${errors}, ${Math.round(down / 1000)} s of ${TRANSIENT_BUDGET_MS / 60_000} min)`,
        );
        await this.sleep(this.interval);
        continue;
      }
      const p = op.metadata?.progress;
      const note =
        [p?.status, p?.description].filter(Boolean).join(': ') || (op.done ? 'done' : 'running');
      const elapsed = Math.round((Date.now() - started) / 1000);
      if (note !== lastNote || Date.now() - lastLogAt > 60_000) {
        this.log(`${note} (${elapsed} s)`);
        lastNote = note;
        lastLogAt = Date.now();
        r = await this.save(r, { progress: note });
      }
      if (op.done) {
        if (op.error) {
          const message =
            typeof op.error === 'string'
              ? op.error
              : String(
                  (op.error as { message?: unknown }).message ?? JSON.stringify(op.error),
                ).slice(0, 300);
          await this.save(r, { status: 'failed', error: message });
          throw new MarbleError(`operation ${id} failed: ${message}`, 'failed');
        }
        const worldId =
          op.metadata?.world_id ??
          op.response?.world_id ??
          op.response?.world?.world_id ??
          op.response?.world?.id ??
          op.response?.id;
        if (typeof worldId !== 'string' || !worldId)
          throw new MarbleError(`operation ${id} finished without a world_id`, 'invalid');
        this.log(`operation ${id} done -> world ${worldId}`);
        return this.save(r, { status: 'generated', world_id: worldId });
      }
      if (Date.now() - started > this.timeout) {
        throw new MarbleError(
          `operation ${id} still running after ${elapsed} s; retry to keep polling`,
          'timeout',
        );
      }
      await this.sleep(this.interval);
    }
  }

  private async fetchWorld(r: MarbleReceipt): Promise<WorldAsset> {
    const worldId = r.world_id!;
    const res = await this.api<Record<string, unknown>>(
      'GET',
      `/marble/v1/worlds/${encodeURIComponent(worldId)}`,
    );
    const world = (res.world && typeof res.world === 'object' ? res.world : res) as MarbleWorld;
    await writeJsonAtomic(join(this.o.outDir, WORLD_FILE), world);
    const splats = world.assets?.splats;
    const urls = splats?.spz_urls ?? {};
    const k500Url = urls['500k'] ?? urls.full_res;
    if (!k500Url) throw new MarbleError(`world ${worldId} has no SPZ URLs`, 'invalid');
    const sem = splats?.semantics_metadata ?? {};
    const msf = Number(sem.metric_scale_factor);
    const gpo = Number(sem.ground_plane_offset);
    if (!(msf > 0)) this.log('world has no metric_scale_factor; assuming 1');
    if (!Number.isFinite(gpo)) this.log('world has no ground_plane_offset; assuming 0');
    this.log(
      `world ${worldId}: metric_scale_factor ${sem.metric_scale_factor} ground_plane_offset ${sem.ground_plane_offset}${world.caption ? ` — "${String(world.caption).slice(0, 120)}"` : ''}`,
    );

    const files = { ...(r.files ?? {}) };
    const asset: WorldAsset = {
      provider: 'marble',
      worldId,
      spz: { k500: '' },
      metricScaleFactor: msf > 0 ? msf : 1,
      groundPlaneOffset: Number.isFinite(gpo) ? gpo : 0,
      opencvFrame: true,
    };
    if (typeof world.caption === 'string' && world.caption.trim())
      asset.caption = world.caption.trim().slice(0, 2000);
    const get = async (url: string | undefined, file: string, spz: boolean, required: boolean) => {
      if (!url) return undefined;
      try {
        files[file] = await this.download(url, file, spz, files[file]);
        r = await this.save(r, { files });
        return file;
      } catch (e) {
        if (required) throw e;
        this.log(`optional ${file} skipped: ${(e as Error).message}`);
        return undefined;
      }
    };
    asset.spz.k500 = (await get(
      k500Url,
      urls['500k'] ? 'world_500k.spz' : 'world_full.spz',
      true,
      true,
    ))!;
    const k100 = await get(urls['100k'], 'world_100k.spz', true, false);
    if (k100) asset.spz.k100 = k100;
    const full = urls['500k']
      ? await get(urls.full_res, 'world_full.spz', true, false)
      : asset.spz.k500;
    if (full) asset.spz.full = full;
    const collider = await get(world.assets?.mesh?.collider_mesh_url, 'collider.glb', false, false);
    if (collider) asset.colliderGlb = collider;
    const thumbUrl = world.assets?.thumbnail_url;
    const thumbExt = thumbUrl?.match(/\.(png|jpe?g|webp)(?:\?|$)/i)?.[1]?.toLowerCase() ?? 'jpg';
    const thumb = await get(
      thumbUrl,
      `thumbnail.${thumbExt === 'jpeg' ? 'jpg' : thumbExt}`,
      false,
      false,
    );
    if (thumb) asset.thumbnail = thumb;

    const checked = WorldAsset.parse(asset);
    await writeJsonAtomic(join(this.o.outDir, ASSET_FILE), checked);
    await this.save(r, { status: 'complete', files });
    this.log(`world ${worldId} ready (${Object.keys(files).length} file(s))`);
    return checked;
  }

  /** Atomic, verified download; skipped when the file already matches its recorded digest. */
  private async download(
    url: string,
    file: string,
    spz: boolean,
    known?: { bytes: number; sha256: string },
  ): Promise<{ bytes: number; sha256: string }> {
    const dest = join(this.o.outDir, file);
    if (known && (await fileMatches(dest, known))) {
      this.log(`${file} already downloaded`);
      return known;
    }
    const tmp = `${dest}.part`;
    let res: Response;
    try {
      // Presigned asset URLs authenticate themselves: no API key here.
      res = await this.fetch(url, { redirect: 'follow' });
    } catch {
      throw new MarbleError(`download ${safeEndpoint(url)} -> network error`, 'network');
    }
    if (!res.ok || !res.body)
      throw new MarbleError(
        `download ${safeEndpoint(url)} -> HTTP ${res.status}`,
        'http',
        res.status,
      );
    const expected = Number(res.headers.get('content-length') ?? NaN);
    const hash = createHash('sha256');
    let bytes = 0;
    let head = Buffer.alloc(0);
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        if (head.length < 65536)
          head = Buffer.concat([head, chunk.subarray(0, 65536 - head.length)]);
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
        tap,
        createWriteStream(tmp),
      );
      if (!bytes) throw new MarbleError(`download ${file} was empty`, 'invalid');
      if (Number.isFinite(expected) && expected !== bytes) {
        throw new MarbleError(
          `download ${file} length mismatch (expected ${expected}, got ${bytes})`,
          'invalid',
        );
      }
      if (spz) {
        try {
          const h = readSpzHeader(head);
          this.log(
            `${file}: SPZ v${h.version}, ${h.numPoints.toLocaleString('en-US')} splats, ${(bytes / 1e6).toFixed(1)} MB`,
          );
        } catch (e) {
          throw new MarbleError(
            `download ${file} is not a valid SPZ: ${(e as Error).message}`,
            'invalid',
          );
        }
      } else {
        this.log(`${file}: ${(bytes / 1e6).toFixed(2)} MB`);
      }
      await rename(tmp, dest);
    } finally {
      await rm(tmp, { force: true });
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  private async verifiedAsset(r: MarbleReceipt): Promise<WorldAsset | undefined> {
    const raw = await readJson(join(this.o.outDir, ASSET_FILE));
    const asset = WorldAsset.safeParse(raw);
    if (!asset.success) return undefined;
    for (const [file, known] of Object.entries(r.files ?? {})) {
      if (!(await fileMatches(join(this.o.outDir, file), known))) return undefined;
    }
    // An optional tier the world offers but we never got (a download cut off by a restart) is
    // worth a free re-fetch: the downloaded files are kept, only the missing ones are pulled.
    const world = await readJson<MarbleWorld>(join(this.o.outDir, WORLD_FILE));
    const urls = world?.assets?.splats?.spz_urls;
    const missing =
      (urls?.full_res && urls['500k'] && !asset.data.spz.full) ||
      (urls?.['100k'] && !asset.data.spz.k100) ||
      (world?.assets?.mesh?.collider_mesh_url && !asset.data.colliderGlb);
    if (missing) {
      this.log('an optional asset was skipped earlier; fetching the missing files (no generation)');
      return undefined;
    }
    return (await exists(join(this.o.outDir, asset.data.spz.k500))) ? asset.data : undefined;
  }
}

async function fileMatches(
  path: string,
  known: { bytes: number; sha256: string },
): Promise<boolean> {
  try {
    if ((await stat(path)).size !== known.bytes) return false;
    return sha256(await readFile(path)) === known.sha256;
  } catch {
    return false;
  }
}

export interface MarbleWorld {
  world_id?: string;
  caption?: string;
  assets?: {
    thumbnail_url?: string;
    splats?: {
      spz_urls?: { '100k'?: string; '500k'?: string; full_res?: string };
      semantics_metadata?: { metric_scale_factor?: number; ground_plane_offset?: number };
    };
    mesh?: { collider_mesh_url?: string };
  };
}
