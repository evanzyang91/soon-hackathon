// Side-by-side renders of two scene manifests from the same cameras, in GPU Chromium (Metal
// ANGLE), against a running Previz server (your own PORT / DATA_DIR, never the developer's
// :5173). Each side opens the laptop page on its manifest, freezes the scene at `--time` seconds
// with no animation advancing (every actor in the same pose on both sides), hides the HUD, and
// captures the viewport from each `--view`; the panels are composed into one PNG with titles.
//
//   npx tsx scripts/compare-shots.ts --base https://localhost:5391 \
//     --left /projects/p/scene-0/manifest-standard.json --left-title "Standard (LHM-500M)" \
//     --right /projects/p/scene-0/manifest.json --right-title "High detail (LHM-1B + fine-tune)" \
//     --view -0.4,1.5,-1.6:0.8,1.3,-2.6:35 [--view ...] [--time 30] [--title T] [--footer T] \
//     [--viewport 1600x900] --out docs/images/x.png
//
// --view is camera x,y,z : look-at x,y,z : vertical fov (degrees), in scene metres.
import { writeFile } from 'node:fs/promises';
import { chromium, type Browser, type Page } from '@playwright/test';
import * as THREE from 'three';
import { GPU_ARGS } from '../server/pipeline/calibrate-render.ts';

interface View {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

function parseArgs(argv: string[]) {
  const views: View[] = [];
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!.replace(/^--/, '');
    const v = argv[++i]!;
    if (k === 'view') {
      const [p, t, f] = v.split(':');
      const nums = (s: string) => s.split(',').map(Number) as [number, number, number];
      views.push({ position: nums(p!), target: nums(t!), fov: Number(f ?? 40) });
    } else o[k] = v;
  }
  for (const need of ['base', 'left', 'right', 'out']) if (!o[need]) throw new Error(`--${need} is required`);
  if (!views.length) throw new Error('at least one --view');
  return { o, views };
}

/** Freezes the director's scene: clock at `time`, every update with dt = 0 (same pose each run). */
const FREEZE = (time: number) => `
  window.__freezeTime = ${time};
  const iv = setInterval(() => {
    const d = window.__previz && window.__previz.director;
    if (!d) return;
    clearInterval(iv);
    let rt = d.runtime;
    Object.defineProperty(d, 'runtime', {
      configurable: true,
      get: () => rt,
      set: (v) => {
        rt = v;
        if (v && !v.__frozen) {
          v.__frozen = true;
          v.setTime(window.__freezeTime);
          const up = v.update.bind(v);
          v.update = () => up(0);
        }
      },
    });
  }, 0);
`;

async function shoot(browser: Browser, base: string, manifest: string, views: View[], time: number, viewport: [number, number]) {
  const page: Page = await browser.newPage({ viewport: { width: viewport[0], height: viewport[1] }, ignoreHTTPSErrors: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(FREEZE(time));
  await page.goto(`${base}/?manifest=${encodeURIComponent(manifest)}`);
  await page.waitForFunction(
    () => {
      const p = (window as unknown as { __previz?: { state(): { sceneLoaded: boolean; loading: string | null; actors: unknown[] } } }).__previz;
      const s = p?.state();
      return !!s && s.sceneLoaded && !s.loading && s.actors.length > 0;
    },
    null,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    const d = (window as unknown as { __previz: { director: { setPip(on: boolean): void; runtime: { colliderReady: Promise<unknown> } } } }).__previz.director;
    d.setPip(false);
    await d.runtime.colliderReady;
  });
  await page.addStyleTag({ content: '#hud-top,#hud-caption,#pip-frame,#hud-empty,#hud-loading,#hud-rec,#hud-bottom{display:none!important}' });
  await page.waitForTimeout(4000); // splat world + actor rigs finish streaming
  const shots: Buffer[] = [];
  for (const v of views) {
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), new THREE.Vector3(0, 1, 0));
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    await page.evaluate(
      ({ p, q, fov }) => {
        const d = (window as unknown as { __previz: { director: { controls: { flyTo(p: object, q: object, fov: number, s: number): void } } } }).__previz.director;
        d.controls.flyTo({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }, fov, 0);
      },
      { p: v.position, q: [q.x, q.y, q.z, q.w], fov: v.fov },
    );
    await page.waitForTimeout(1500);
    shots.push(await page.locator('#viewport').screenshot());
  }
  if (errors.length) console.warn(`${manifest}: page errors: ${errors.slice(0, 3).join(' | ')}`);
  const state = await page.evaluate(() => (window as unknown as { __previz: { state(): unknown } }).__previz.state());
  await page.close();
  return { shots, state };
}

async function main() {
  const { o, views } = parseArgs(process.argv.slice(2));
  const time = Number(o.time ?? 30);
  const [vw, vh] = (o.viewport ?? '1600x900').split('x').map(Number) as [number, number];
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: GPU_ARGS });
  try {
    const left = await shoot(browser, o.base!, o.left!, views, time, [vw, vh]);
    const right = await shoot(browser, o.base!, o.right!, views, time, [vw, vh]);
    console.log(JSON.stringify({ left: left.state, right: right.state }, null, 1).slice(0, 4000));
    const img = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
    const rows = views
      .map((_, i) => `<div class="row"><img src="${img(left.shots[i]!)}"><img src="${img(right.shots[i]!)}"></div>`)
      .join('');
    const html = `<!doctype html><html><head><style>
      body{margin:0;background:#0f1217;color:#e6e9ee;font:15px system-ui,sans-serif}
      #c{display:inline-block;padding:14px}
      h1{font-size:18px;margin:0 0 10px} .heads,.row{display:flex;gap:10px} .row{margin-bottom:10px}
      .heads div{flex:1;font-weight:600;padding:2px 2px 6px} img{display:block;width:${o.panel ?? 760}px;border-radius:6px}
      .foot{color:#9aa4b2;font-size:13px;max-width:${2 * Number(o.panel ?? 760) + 10}px;line-height:1.4}
    </style></head><body><div id="c">
      ${o.title ? `<h1>${esc(o.title)}</h1>` : ''}
      <div class="heads"><div>${esc(o['left-title'] ?? o.left!)}</div><div>${esc(o['right-title'] ?? o.right!)}</div></div>
      ${rows}
      ${o.footer ? `<div class="foot">${esc(o.footer)}</div>` : ''}
    </div></body></html>`;
    const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await writeFile(o.out!, await page.locator('#c').screenshot());
    console.log(`wrote ${o.out}`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
