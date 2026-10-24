// Look development checks in GPU Chromium (Metal ANGLE) against running Previz servers (your own
// PORT / DATA_DIR, never the developer's :5173). Every scene is frozen (clock and actor animation
// stopped) and the HUD hidden, so two renders of the same pose are comparable pixel for pixel.
//
//   npx tsx scripts/look-check.ts <check> --base https://localhost:5411 --project <id> [--scene 0]
//     [--before https://localhost:5412]  (identity: a server running the pre-look commit)
//     [--out dir] [--docs]               (--docs also writes docs/images/look-*.png)
//     [--exe <chromium executable>]      (default: Playwright's own Chromium)
//
// checks:
//   identity  default look vs the pre-change build (--before) and vs the forced post pass:
//             share of pixels within ±1/255 per channel (target ≥ 99 %)
//   presets   every LUT and full-look preset on the scene; mean abs difference from the
//             ungraded frame; contact sheet (docs/images/look-presets.png)
//   parity    laptop "view from phone" vs the paired phone at the same pose and look, both at
//             844×390 CSS px, DPR 1.5: mean abs difference (target < 2 %)
//   light     point light 2 m beside an actor: luminance gain on the lit vs the far side of the
//             actor and on nearby splats (docs/images/look-light.png)
//   fps       laptop 1600×900 (+PiP) and phone 844×390 @ DPR 3 with the full post pass, bloom,
//             DOF, fog and a light (--uncapped: no vsync, to see the headroom above 60)
//   all       every check above
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import * as THREE from 'three';
import { decodePng } from '../tests/e2e/helpers.ts';

const GPU_ARGS = ['--ignore-certificate-errors', '--use-angle=metal', '--enable-gpu'];

function args() {
  const [check = 'all', ...rest] = process.argv.slice(2);
  const o: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i]!.replace(/^--/, '');
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) o[k] = '1';
    else o[k] = rest[++i]!;
  }
  if (!o.base || !o.project) throw new Error('--base and --project are required');
  return { check, o };
}

interface View {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}
const quatFor = (v: View) => {
  const m = new THREE.Matrix4().lookAt(new THREE.Vector3(...v.position), new THREE.Vector3(...v.target), new THREE.Vector3(0, 1, 0));
  const q = new THREE.Quaternion().setFromRotationMatrix(m);
  return [q.x, q.y, q.z, q.w] as [number, number, number, number];
};

const HIDE_HUD = `addEventListener('DOMContentLoaded', () => {
  const st = document.createElement('style');
  st.textContent = '#hud-top,#hud-caption,#pip-frame,#hud-empty,#hud-loading,#hud-rec,#hud-bottom,#hud,#toast{display:none!important}';
  document.head.append(st);
});`;

/** Freezes the director's scene: clock at `time`, every update with dt = 0 (same pose each run). */
const FREEZE_LAPTOP = (time: number) => `
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
          v.setTime(${time});
          const up = v.update.bind(v);
          v.update = () => up(0);
        }
      },
    });
  }, 0);
`;

type Rgba = { width: number; height: number; rgba: Uint8Array };
const decode = (b: Buffer): Rgba => decodePng(b);

/** Share of pixels whose every channel is within `tol`/255, and mean abs difference (0..1). */
function compare(a: Rgba, b: Rgba, tol = 1) {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`size ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  let within = 0;
  let sum = 0;
  let max = 0;
  const n = a.width * a.height;
  const ca = a.rgba.length / n;
  const cb = b.rgba.length / n;
  for (let i = 0; i < n; i++) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.rgba[i * ca + c]! - b.rgba[i * cb + c]!);
      sum += d;
      if (d > worst) worst = d;
    }
    if (worst <= tol) within++;
    if (worst > max) max = worst;
  }
  return { within: within / n, meanAbs: sum / (n * 3 * 255), max };
}

const STREET_WIDE: View = { position: [0, 1.6, 0.5], target: [0, 1.25, -6], fov: 55 };

async function laptop(browser: Browser, base: string, project: string, scene: number, viewport = { width: 1600, height: 900 }, dpr = 1) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr, ignoreHTTPSErrors: true });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 300));
  });
  await page.addInitScript(FREEZE_LAPTOP(0));
  await page.addInitScript(HIDE_HUD);
  await page.goto(`${base}/?project=${project}&scene=${scene}`);
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __previz?: { state(): { sceneLoaded: boolean; loading: string | null; actors: unknown[] } } }).__previz?.state();
      return !!s && s.sceneLoaded && !s.loading;
    },
    null,
    { timeout: 120_000 },
  );
  await page.evaluate(async () => {
    const d = (window as unknown as { __previz: { director: { setPip(on: boolean): void; camera: { layers: { disable(n: number): void } }; runtime: { colliderReady: Promise<unknown> } } } }).__previz.director;
    d.setPip(false);
    d.camera.layers.disable(1); // gizmo layer (camera markers, light gizmos): not part of the frame
    await d.runtime.colliderReady;
  });
  await page.waitForTimeout(3000);
  return { page, errors };
}

async function fly(page: Page, v: View) {
  const q = quatFor(v);
  await page.evaluate(
    ({ p, q, fov }) => {
      const d = (window as unknown as { __previz: { director: { controls: { flyTo(p: object, q: object, fov: number, s: number): void } } } }).__previz.director;
      d.controls.flyTo({ x: p[0], y: p[1], z: p[2] }, { x: q[0], y: q[1], z: q[2], w: q[3] }, fov, 0);
    },
    { p: v.position, q, fov: v.fov },
  );
}

/** Screenshot of the viewport once two consecutive captures agree (splat sort settled). */
async function stableShot(page: Page, selector = '#viewport', tries = 8): Promise<Buffer> {
  await page.waitForTimeout(1200);
  let prev = await page.locator(selector).screenshot();
  for (let i = 0; i < tries; i++) {
    await page.waitForTimeout(700);
    const next = await page.locator(selector).screenshot();
    if (compare(decode(prev), decode(next), 0).within > 0.9995) return next;
    prev = next;
  }
  return prev;
}

async function setLook(page: Page, look: Record<string, unknown>, opts: { forcePost?: boolean } = {}) {
  await page.evaluate(
    ({ look, forcePost }) => {
      const rt = (window as unknown as { __previz: { director: { runtime: { setLook(l: unknown): void; look: { forcePost: boolean } } } } }).__previz.director.runtime;
      rt.look.forcePost = !!forcePost;
      rt.setLook(look);
    },
    { look, forcePost: opts.forcePost ?? false },
  );
}

const png = (b: Buffer) => `data:image/png;base64,${b.toString('base64')}`;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

async function compose(browser: Browser, html: string, out: string) {
  const page = await browser.newPage({ viewport: { width: 2000, height: 1200 } });
  await page.setContent(`<!doctype html><html><head><style>
    body{margin:0;background:#0f1217;color:#e6e9ee;font:14px system-ui,sans-serif}
    #c{display:inline-block;padding:14px} h1{font-size:18px;margin:0 0 10px}
    .grid{display:grid;gap:8px} .tile img{display:block;border-radius:5px} .tile div{padding:3px 2px 0;font-weight:600}
    .tile span{color:#9aa4b2;font-weight:400} .foot{color:#9aa4b2;font-size:13px;margin-top:8px;max-width:1500px;line-height:1.4}
  </style></head><body><div id="c">${html}</div></body></html>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await writeFile(out, await page.locator('#c').screenshot());
  await page.close();
}

// ---------------------------------------------------------------------------------------------

async function identity(browser: Browser, o: Record<string, string>, out: string) {
  const scene = Number(o.scene ?? 0);
  const views: View[] = [STREET_WIDE, { position: [1.4, 1.65, -1.8], target: [-0.7, 1.3, -2.8], fov: 35 }];
  const now = await laptop(browser, o.base!, o.project!, scene);
  const before = o.before ? await laptop(browser, o.before, o.project!, scene) : null;
  const res: Record<string, unknown>[] = [];
  for (const [i, v] of views.entries()) {
    await setLook(now.page, { name: 'Default' });
    await fly(now.page, v);
    const direct = await stableShot(now.page);
    await setLook(now.page, { name: 'Default' }, { forcePost: true });
    const forced = await stableShot(now.page);
    const frames = await now.page.evaluate(() => (window as unknown as { __previz: { director: { view: { postFrames: { main: number } } } } }).__previz.director.view.postFrames.main);
    await setLook(now.page, { name: 'Default' });
    const r: Record<string, unknown> = { view: i, postFramesForced: frames, forcedVsDirect: compare(decode(forced), decode(direct)) };
    await writeFile(join(out, `identity-${i}-now.png`), direct);
    await writeFile(join(out, `identity-${i}-forced.png`), forced);
    if (before) {
      await fly(before.page, v);
      const b = await stableShot(before.page);
      await writeFile(join(out, `identity-${i}-before.png`), b);
      r.nowVsBefore = compare(decode(direct), decode(b));
      r.forcedVsBefore = compare(decode(forced), decode(b));
    }
    res.push(r);
  }
  await now.page.close();
  await before?.page.close();
  return { identity: res, errors: now.errors };
}

const PRESETS: { title: string; look: Record<string, unknown> }[] = [
  { title: 'Ungraded', look: { name: 'Default' } },
  ...['teal-orange', 'noir', 'kodak', 'bleach', 'cool-night', 'golden'].map((lut) => ({ title: `LUT · ${lut}`, look: { name: lut, lut, lutStrength: 1 } })),
];

async function presets(browser: Browser, o: Record<string, string>, out: string, docs: boolean) {
  const { page, errors } = await laptop(browser, o.base!, o.project!, Number(o.scene ?? 0), { width: 1400, height: 820 });
  // the four full looks come from the app's own preset table
  const full = await page.evaluate(async () => {
    const m = await import('/src/viewer/look/presets.ts');
    return (m.FULL_PRESETS as { name: string }[]).map((p) => ({ title: `Look · ${p.name}`, look: p as unknown as Record<string, unknown> }));
  });
  const all = [...PRESETS, ...full];
  await fly(page, STREET_WIDE);
  const shots: { title: string; b: Buffer; diff: number }[] = [];
  let ungraded: Rgba | null = null;
  for (const p of all) {
    await setLook(page, { ...p.look, grain: 0 });
    const b = await stableShot(page);
    const img = decode(b);
    ungraded ??= img;
    shots.push({ title: p.title, b, diff: compare(img, ungraded).meanAbs });
    await writeFile(join(out, `preset-${p.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`), b);
  }
  await setLook(page, { name: 'Default' });
  await page.close();
  const tiles = shots
    .map((s) => `<div class="tile"><img src="${png(s.b)}" width="460"><div>${esc(s.title)} <span>${s.title === 'Ungraded' ? '' : `Δ ${(s.diff * 100).toFixed(1)} % mean abs`}</span></div></div>`)
    .join('');
  const html = `<h1>Look presets — The Last Bus, EXT. CITY BUS STOP – NIGHT (real Marble world + LHM actors), same frozen frame</h1>
    <div class="grid" style="grid-template-columns:repeat(4,460px)">${tiles}</div>
    <div class="foot">Each tile is the director's view through the look post pass (grain off for the comparison). LUTs are analytic display-space transforms
    (web/src/viewer/look/grade.ts); full looks also set grade, film and atmosphere (fog and sky tint are per-splat, lights.ts). Δ = mean absolute difference from the ungraded frame.</div>`;
  if (docs) await compose(browser, html, 'docs/images/look-presets.png');
  await compose(browser, html, join(out, 'look-presets.png'));
  return { presets: shots.map((s) => ({ title: s.title, meanAbsVsUngraded: +s.diff.toFixed(4) })), errors };
}

async function parity(browser: Browser, o: Record<string, string>, out: string) {
  const project = o.project!;
  const scene = Number(o.scene ?? 0);
  // --plain: no grade (shows how far apart the two renders are without any look)
  const look = o.plain === '1' ? { name: 'Plain' } : {
    name: 'Parity check',
    exposure: 0.25,
    contrast: 1.12,
    saturation: 0.9,
    temperature: 0.3,
    shadows: 0.1,
    lut: 'teal-orange',
    lutStrength: 0.6,
    vignette: 0.35,
    bloom: 0.4,
    fog: { color: '#7d8a99', density: 0.2 },
    skyTint: { color: '#ff9a50', strength: 0.4 },
    dof: { enabled: true, focusDistance: 3, fStop: 2 },
    lights: [{ id: 'k', name: 'Key', kind: 'point', position: [-2.7, 1.3, -2.8], color: '#ffc58a', intensity: 3, radius: 6 }],
  };
  // stage = viewport − 630 px of side panels − 36 px top bar → exactly 844×390, like the phone
  const lap = await laptop(browser, o.base!, project, scene, { width: 844 + 630, height: 390 + 36 }, 1.5);
  const room = await lap.page.evaluate(() => (window as unknown as { __previz: { state(): { room: string | null } } }).__previz.state().room);
  if (!room) throw new Error('laptop has no room');
  const phone = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 1.5, ignoreHTTPSErrors: true, isMobile: false });
  await phone.addInitScript(HIDE_HUD);
  await phone.goto(`${o.base}/phone.html?room=${room}&sim=1&autostart=1&governor=0&voice=0`);
  await phone.waitForFunction(() => {
    const p = (window as unknown as { __phone?: { viewMode: string; viewStatus: string; framesRendered: number } }).__phone;
    return p?.viewMode === 'webgl' && p.viewStatus === 'ready' && p.framesRendered > 5;
  }, null, { timeout: 120_000 });
  // freeze the phone's scene the same way (dt = 0, time 0)
  await phone.evaluate(() => {
    const rt = (window as unknown as { __phone: { sceneRuntime(): { update(dt: number): void; setTime(t: number): void } } }).__phone.sceneRuntime();
    const up = rt.update.bind(rt);
    rt.setTime(0);
    rt.update = () => up(0);
  });
  // the director applies the look through its session: live look → phone, then saved → revision
  await lap.page.evaluate((look) => {
    const w = window as unknown as { __look: { session: { apply(l: unknown, c: string | null): void } }; __previz: { director: { setViewFromPhone(on: boolean): void } } };
    w.__look.session.apply(look, null);
    w.__previz.director.setViewFromPhone(true);
  }, look);
  await phone.waitForFunction((name) => (window as unknown as { __phone: { look: { name: string } } }).__phone.look.name === name, look.name, { timeout: 15_000 });
  await lap.page.waitForFunction(() => (window as unknown as { __look: { session: { status: string } } }).__look.session.status === 'saved', null, { timeout: 15_000 });
  await phone.waitForTimeout(1500);
  const a = await stableShot(lap.page);
  const b = await stableShot(phone, '#gl');
  await writeFile(join(out, 'parity-laptop.png'), a);
  await writeFile(join(out, 'parity-phone.png'), b);
  const phoneState = await phone.evaluate(() => ({
    ...(window as unknown as { __phone: { look: object } }).__phone.look,
    // the HUD's toast (hidden for the capture) names the look when it changes
    toast: document.getElementById('toast')?.textContent ?? null,
  }));
  const res = compare(decode(a), decode(b), 2);
  // reset the scene's saved look for the next checks
  await lap.page.evaluate(() => (window as unknown as { __look: { session: { apply(l: unknown, c: string | null): void } } }).__look.session.apply({ name: 'Default' }, null));
  await lap.page.waitForTimeout(800);
  await phone.close();
  await lap.page.close();
  return { parity: { ...res, phone: phoneState }, errors: lap.errors };
}

async function light(browser: Browser, o: Record<string, string>, out: string, docs: boolean) {
  const { page, errors } = await laptop(browser, o.base!, o.project!, Number(o.scene ?? 0), { width: 1400, height: 820 });
  const actor = await page.evaluate(() => {
    const d = (window as unknown as { __previz: { state(): { actors: { id: string; position: number[] }[] } } }).__previz.state();
    return d.actors.find((a) => a.id === 'maya') ?? d.actors[0]!;
  });
  const [ax, , az] = actor.position as [number, number, number];
  // 2 m from the actor, front-left of her as the camera sees her (45°), chest height
  const lightPos: [number, number, number] = [ax - Math.SQRT2, 1.3, az + Math.SQRT2];
  const v: View = { position: [ax, 1.45, az + 2.6], target: [ax, 1.05, az], fov: 45 };
  await fly(page, v);
  await setLook(page, { name: 'Default' });
  const before = await stableShot(page);
  await setLook(page, { name: 'Key light', lights: [{ id: 'key', name: 'Key', kind: 'point', position: lightPos, color: '#ffd2a1', intensity: 3, radius: 6 }] });
  const after = await stableShot(page);
  await setLook(page, { name: 'Default' });
  // the actor's screen box: her mark ± 0.3 m, feet to 1.7 m, through the director camera
  const box = await page.evaluate(([x, z]) => {
    const d = (window as unknown as { __previz: { director: { camera: { position: { constructor: new (x: number, y: number, z: number) => { project(c: unknown): { x: number; y: number } } } } } } }).__previz.director;
    const V = d.camera.position.constructor;
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const dx of [-0.3, 0.3]) for (const dy of [0.1, 1.7]) for (const dz of [-0.3, 0.3]) {
      const p = new V(x + dx, dy, z + dz).project(d.camera);
      const u = (p.x + 1) / 2;
      const v = (1 - p.y) / 2;
      x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v);
    }
    return { x0, x1, y0, y1 };
  }, [ax, az] as const);
  const A = decode(before);
  const B = decode(after);
  // luminance gain map + region stats (actor occupies the centre column of this framing)
  const w = A.width;
  const h = A.height;
  const ch = A.rgba.length / (w * h);
  const lum = (img: Rgba, i: number) => 0.2126 * img.rgba[i * ch]! + 0.7152 * img.rgba[i * ch + 1]! + 0.0722 * img.rgba[i * ch + 2]!;
  const region = (x0: number, x1: number, y0: number, y1: number) => {
    let sa = 0;
    let sb = 0;
    let n = 0;
    for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++)
      for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
        const i = y * w + x;
        sa += lum(A, i);
        sb += lum(B, i);
        n++;
      }
    return { before: +(sa / n).toFixed(1), after: +(sb / n).toFixed(1), gain: +((sb - sa) / Math.max(1, sa)).toFixed(3) };
  };
  const stats = {
    light: lightPos,
    actor: actor.position,
    actorBox: box,
    actorLitSide: region(box.x0, (box.x0 + box.x1) / 2, box.y0 + 0.15 * (box.y1 - box.y0), box.y1 - 0.1 * (box.y1 - box.y0)),
    actorFarSide: region((box.x0 + box.x1) / 2, box.x1, box.y0 + 0.15 * (box.y1 - box.y0), box.y1 - 0.1 * (box.y1 - box.y0)),
    groundNearLight: region(0.0, 0.3, 0.75, 1.0),
    farBackground: region(0.7, 1.0, 0.0, 0.3),
  };
  // gain heat map
  const heat = await browser.newPage({ viewport: { width: w, height: h } });
  const heatPng = await heat.evaluate(
    async ({ a, b }) => {
      // (no named helpers in here: tsx wraps them in a __name() call the page does not have)
      const ia = await new Promise<HTMLImageElement>((r) => { const i = new Image(); i.onload = () => r(i); i.src = a; });
      const ib = await new Promise<HTMLImageElement>((r) => { const i = new Image(); i.onload = () => r(i); i.src = b; });
      const c = document.createElement('canvas');
      c.width = ia.width;
      c.height = ia.height;
      const x = c.getContext('2d')!;
      x.drawImage(ia, 0, 0);
      const da = x.getImageData(0, 0, c.width, c.height);
      x.drawImage(ib, 0, 0);
      const db = x.getImageData(0, 0, c.width, c.height);
      const o = x.createImageData(c.width, c.height);
      for (let i = 0; i < da.data.length; i += 4) {
        const la = 0.2126 * da.data[i]! + 0.7152 * da.data[i + 1]! + 0.0722 * da.data[i + 2]!;
        const lb = 0.2126 * db.data[i]! + 0.7152 * db.data[i + 1]! + 0.0722 * db.data[i + 2]!;
        const g = Math.max(0, Math.min(1, (lb - la) / 80));
        o.data[i] = 255 * Math.min(1, g * 2);
        o.data[i + 1] = 255 * Math.max(0, g * 2 - 1) * 0.85 + 20 * (1 - g);
        o.data[i + 2] = 40 * (1 - g);
        o.data[i + 3] = 255;
      }
      x.putImageData(o, 0, 0);
      return c.toDataURL('image/png');
    },
    { a: png(before), b: png(after) },
  );
  await heat.close();
  await page.close();
  await writeFile(join(out, 'light-before.png'), before);
  await writeFile(join(out, 'light-after.png'), after);
  const html = `<h1>A Look light 2 m beside the actor (point, intensity 3, radius 6 m, warm) — splats and actor relit by the world modifier</h1>
    <div class="grid" style="grid-template-columns:repeat(3,600px)">
      <div class="tile"><img src="${png(before)}" width="600"><div>Before <span>(no Look lights)</span></div></div>
      <div class="tile"><img src="${png(after)}" width="600"><div>After <span>(light 2 m front-left of her, 1.3 m high)</span></div></div>
      <div class="tile"><img src="${heatPng}" width="600"><div>Luminance gain <span>(black 0 → red → yellow ≥ +80/255)</span></div></div>
    </div>
    <div class="foot">Actor lit side (left half of her box) luminance ${stats.actorLitSide.before} → ${stats.actorLitSide.after} (+${(stats.actorLitSide.gain * 100).toFixed(0)} %),
    far side ${stats.actorFarSide.before} → ${stats.actorFarSide.after} (+${(stats.actorFarSide.gain * 100).toFixed(0)} %); ground near the light +${(stats.groundNearLight.gain * 100).toFixed(0)} %;
    far background +${(stats.farBackground.gain * 100).toFixed(0)} %. Each splat's colour × (ambient + intensity · colour · windowed inverse-square falloff · N·L with the splat's thin axis facing the viewer);
    no new shadows (the world is baked).</div>`;
  if (docs) await compose(browser, html, 'docs/images/look-light.png');
  await compose(browser, html, join(out, 'look-light.png'));
  return { light: stats, errors };
}

const FULL_LOOK = {
  name: 'Full pass',
  exposure: 0.2,
  contrast: 1.1,
  temperature: 0.2,
  lut: 'teal-orange',
  lutStrength: 0.7,
  vignette: 0.3,
  grain: 0.25,
  bloom: 0.5,
  fog: { color: '#7d8a99', density: 0.2 },
  dof: { enabled: true, focusDistance: 3, fStop: 2 },
  lights: [{ id: 'k', name: 'Key', kind: 'point', position: [-2.7, 1.3, -2.8], color: '#ffc58a', intensity: 3, radius: 6 }],
};

async function fps(browser: Browser, o: Record<string, string>) {
  const project = o.project!;
  const scene = Number(o.scene ?? 0);
  const measure = async (page: Page, read: () => number, ms = 5000) => {
    const f0 = await page.evaluate(read);
    const t0 = Date.now();
    await page.waitForTimeout(ms);
    const f1 = await page.evaluate(read);
    return +(((f1 - f0) * 1000) / (Date.now() - t0)).toFixed(1);
  };
  const lapFrames = () => (window as unknown as { __previz: { director: { view: { mainFrames: number } } } }).__previz.director.view.mainFrames;
  const lap = await laptop(browser, o.base!, project, scene, { width: 1600, height: 900 });
  await fly(lap.page, STREET_WIDE);
  // a camera for the PiP to show
  await lap.page.evaluate(() => {
    const d = (window as unknown as { __previz: { director: { dropCamera(n: string): void; setPip(on: boolean): void } } }).__previz.director;
    d.dropCamera('fps');
  });
  const r: Record<string, number> = {};
  await setLook(lap.page, { name: 'Default' });
  r.laptopUngraded = await measure(lap.page, lapFrames);
  await setLook(lap.page, FULL_LOOK);
  r.laptopFullLook = await measure(lap.page, lapFrames);
  await lap.page.evaluate(() => (window as unknown as { __previz: { director: { setPip(on: boolean): void } } }).__previz.director.setPip(true));
  r.laptopFullLookWithPip = await measure(lap.page, lapFrames);
  await setLook(lap.page, { name: 'Default' });
  const room = await lap.page.evaluate(() => (window as unknown as { __previz: { state(): { room: string | null } } }).__previz.state().room);
  // the laptop stops rendering while the phone is measured (same GPU); its look session still
  // broadcasts through the relay
  await lap.page.evaluate(() => (window as unknown as { __previz: { director: { stop(): void } } }).__previz.director.stop());
  // phone: iPhone-size landscape, DPR 3 (the phone renderer caps its pixel ratio at 1.5)
  const phone = await browser.newPage({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, ignoreHTTPSErrors: true });
  // uncapped rAF saturates the main thread, which the render governor reads as a slow device
  const gov = o.uncapped === '1' ? '&governor=0' : '';
  await phone.goto(`${o.base}/phone.html?room=${room}&sim=1&autostart=1&voice=0${gov}`);
  await phone.waitForFunction(() => (window as unknown as { __phone?: { viewMode: string; framesRendered: number } }).__phone?.viewMode === 'webgl', null, { timeout: 120_000 });
  const phFrames = () => (window as unknown as { __phone: { framesRendered: number } }).__phone.framesRendered;
  await phone.waitForTimeout(3000);
  r.phoneUngraded = await measure(phone, phFrames);
  await lap.page.evaluate((look) => (window as unknown as { __look: { session: { apply(l: unknown, c: null): void } } }).__look.session.apply(look, null), FULL_LOOK);
  await phone.waitForFunction(() => (window as unknown as { __phone: { look: { name: string } } }).__phone.look.name === 'Full pass', null, { timeout: 15_000 });
  await phone.waitForTimeout(2000);
  r.phoneFullLook = await measure(phone, phFrames);
  const ph = await phone.evaluate(() => {
    const p = (window as unknown as { __phone: { renderLevel: number; look: unknown; renderMs: number } }).__phone;
    return { renderLevel: p.renderLevel, look: p.look, renderMs: +p.renderMs.toFixed(2) };
  });
  await lap.page.evaluate(() => (window as unknown as { __look: { session: { apply(l: unknown, c: null): void } } }).__look.session.apply({ name: 'Default' }, null));
  await lap.page.waitForTimeout(800);
  await phone.close();
  await lap.page.close();
  return { fps: r, phone: ph };
}

async function main() {
  const { check, o } = args();
  const out = o.out ?? 'test-results/look-check';
  await mkdir(out, { recursive: true });
  const docs = o.docs === '1';
  // --uncapped: no vsync / frame-rate limit, so fps shows the real headroom instead of 60
  const extra = o.uncapped === '1' ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [];
  // --exe: a specific Chromium build (e.g. ~/Library/Caches/ms-playwright/chromium-1243/...)
  const browser = await chromium.launch({
    ...(o.exe ? { executablePath: o.exe } : { channel: 'chromium' }),
    headless: true,
    args: [...GPU_ARGS, ...extra],
  });
  console.error(`chromium ${browser.version()}`);
  const results: Record<string, unknown> = {};
  try {
    const run = (c: string) => check === 'all' || check === c;
    if (run('identity')) Object.assign(results, await identity(browser, o, out));
    if (run('presets')) Object.assign(results, await presets(browser, o, out, docs));
    if (run('parity')) Object.assign(results, await parity(browser, o, out));
    if (run('light')) Object.assign(results, await light(browser, o, out, docs));
    if (run('fps')) Object.assign(results, await fps(browser, o));
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
  await writeFile(join(out, `${check}.json`), JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
