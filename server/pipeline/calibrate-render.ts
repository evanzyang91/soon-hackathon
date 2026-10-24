// Offscreen world renders for scale calibration: a private Vite server (own cache dir, never the
// developer's :5173) serves web/src/viewer/dev/scale-harness.html plus the world's files, and a
// GPU Chromium (Metal ANGLE) draws ScaleShots through window.__scale. Vite and Playwright are
// dev dependencies, imported lazily: without them `openWorldRenderer` throws and calibration
// falls back to geometry only.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorldAsset } from '../../shared/schema.ts';
import type { ScaleHarness, ScalePanel, ScaleShot } from '../../web/src/viewer/dev/scale-shot.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const plainFile = (f: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(f);
export const GPU_ARGS = ['--ignore-certificate-errors', '--use-angle=metal', '--enable-gpu'];

export interface WorldRenderer {
  shot(s: ScaleShot): Promise<Buffer>;
  compose(panels: { image: Buffer; title: string; subtitle?: string }[], footer: string[]): Promise<Buffer>;
  close(): Promise<void>;
}

export interface RendererOptions {
  /** Which SPZ tier to draw (default k500). */
  quality?: 'k100' | 'k500' | 'full';
  background?: string;
  log?: (m: string) => void;
}

const dataUrlToPng = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

export async function openWorldRenderer(
  worldDir: string,
  asset: WorldAsset,
  opts: RendererOptions = {},
): Promise<WorldRenderer> {
  const log = opts.log ?? (() => {});
  const { createServer } = await import('vite');
  const { chromium } = await import('@playwright/test');
  const spzFile = asset.spz[opts.quality ?? 'k500'] ?? asset.spz.k500;
  const server = await createServer({
    configFile: false,
    root: join(repo, 'web'),
    logLevel: 'error',
    cacheDir: join(repo, 'node_modules/.vite-calibrate'),
    resolve: { alias: { '@shared': join(repo, 'shared') } },
    server: { port: 0, host: '127.0.0.1', hmr: false, watch: null },
    optimizeDeps: {
      include: ['three', 'three/addons/loaders/GLTFLoader.js', '@sparkjsdev/spark'],
    },
    plugins: [
      {
        name: 'calibrate-world-files',
        configureServer(s) {
          s.middlewares.use('/__world', (req, res, next) => {
            const name = decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\//, ''));
            if (!plainFile(name)) return next();
            const file = join(worldDir, name);
            stat(file)
              .then((st) => {
                if (!st.isFile()) return next();
                res.setHeader('content-type', 'application/octet-stream');
                res.setHeader('content-length', String(st.size));
                createReadStream(file).pipe(res);
              })
              .catch(() => next());
          });
        },
      },
    ],
  });
  await server.listen();
  const url = server.resolvedUrls?.local[0];
  if (!url) {
    await server.close();
    throw new Error('render server did not start');
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: GPU_ARGS });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${url}src/viewer/dev/scale-harness.html`);
    await page.waitForFunction(() => '__scale' in window, null, { timeout: 60_000 });
    const loaded = await page.evaluate(
      (w) => (window as unknown as { __scale: ScaleHarness }).__scale.load(w),
      {
        spz: `/__world/${spzFile}`,
        collider: asset.colliderGlb ? `/__world/${asset.colliderGlb}` : undefined,
        metricScaleFactor: asset.metricScaleFactor,
        groundPlaneOffset: asset.groundPlaneOffset,
        opencvFrame: asset.opencvFrame,
        background: opts.background,
      },
    );
    log(`render: ${spzFile} loaded (${loaded.splats.toLocaleString('en-US')} splats) in GPU Chromium`);
    const b = browser;
    return {
      async shot(s) {
        const png = await page.evaluate(
          (shot) => (window as unknown as { __scale: ScaleHarness }).__scale.render(shot),
          s,
        );
        if (errors.length) throw new Error(`render page error: ${errors[0]}`);
        return dataUrlToPng(png);
      },
      async compose(panels, footer) {
        const p: ScalePanel[] = panels.map((x) => ({
          image: `data:image/png;base64,${x.image.toString('base64')}`,
          title: x.title,
          subtitle: x.subtitle,
        }));
        const png = await page.evaluate(
          ([ps, f]) => (window as unknown as { __scale: ScaleHarness }).__scale.compose(ps, f),
          [p, footer] as const,
        );
        return dataUrlToPng(png);
      },
      async close() {
        await b.close().catch(() => {});
        await server.close().catch(() => {});
      },
    };
  } catch (e) {
    await browser?.close().catch(() => {});
    await server.close().catch(() => {});
    throw e;
  }
}
