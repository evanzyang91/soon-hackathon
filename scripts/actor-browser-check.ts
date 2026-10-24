// WP D browser check: mounts a procedural mannequin and an LHM-format splat actor (synthetic,
// packaged by the real worker packager) in a bare three + Spark scene, calls speak() with the
// mock TTS WAV and asserts: no console errors, the promise resolves after ~duration, the jaw
// follows the audio, the splat actor switches to its talk loop, both stand ~1.7 m with feet on 0.
//
//   npx tsx scripts/actor-browser-check.ts [--headed] [--shots DIR] [--sequence ACTOR_DIR] [--gpu]
//     --sequence ACTOR_DIR  check a real packaged avatar (a dir holding sequence/, e.g.
//                           data/actors-library/maya) instead of the synthetic one
//     --gpu                 Metal ANGLE instead of SwiftShader (a real 40k-splat avatar)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { mockDurationSeconds, mockWav } from '../server/pipeline/tts.ts';

const repo = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const shots = args.includes('--shots') ? args[args.indexOf('--shots') + 1]! : null;
const fixtures = mkdtempSync(join(tmpdir(), 'actor-check-'));
const fail = (m: string) => {
  throw new Error(m);
};

async function main() {
  const realSeq = args.includes('--sequence') ? args[args.indexOf('--sequence') + 1]! : null;
  if (realSeq) execFileSync('ln', ['-s', realSeq, join(fixtures, 'synth')]);
  else execFileSync('python3', [join(repo, 'worker/tests/make_synthetic_actor.py'), join(fixtures, 'synth'), '--frames', '12', '--talk', '6', '--splats', '6000'], { stdio: 'inherit' });
  // --audio FILE --seconds S plays a real TTS file instead of the mock beeps
  const text = 'Did you hear that? Somebody is on the stairs.';
  const real = args.includes('--audio') ? args[args.indexOf('--audio') + 1]! : null;
  writeFileSync(join(fixtures, 'line.wav'), real ? readFileSync(real) : mockWav(text));
  const seconds = real ? Number(args[args.indexOf('--seconds') + 1]) : mockDurationSeconds(text);

  const server = await createServer({
    configFile: false,
    root: join(repo, 'web'),
    logLevel: 'warn',
    resolve: { alias: { '@shared': join(repo, 'shared') } },
    server: { port: 0, host: '127.0.0.1' },
    optimizeDeps: { include: ['three', '@sparkjsdev/spark'] },
    plugins: [
      {
        name: 'actor-fixtures',
        configureServer(s) {
          s.middlewares.use('/fixture', (req, res, next) => {
            const file = normalize(join(fixtures, decodeURIComponent((req.url ?? '/').split('?')[0]!)));
            if (!file.startsWith(fixtures) || !existsSync(file) || !statSync(file).isFile()) return next();
            const type = { '.json': 'application/json', '.wav': 'audio/wav' }[extname(file)] ?? 'application/octet-stream';
            res.setHeader('content-type', type);
            res.end(readFileSync(file));
          });
        },
      },
    ],
  });
  await server.listen();
  const url = server.resolvedUrls!.local[0]!;
  const launch = { headless: !args.includes('--headed'), args: ['--autoplay-policy=no-user-gesture-required', ...(args.includes('--gpu') ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'])] };
  // fall back to the installed Google Chrome when Playwright's bundled build isn't downloaded
  const browser = await chromium.launch(launch).catch((err: Error) => {
    if (!/Executable doesn't exist/.test(err.message)) throw err;
    console.log('bundled Chromium missing; using the installed Google Chrome');
    return chromium.launch({ ...launch, channel: 'chrome' });
  });
  const consoleErrors: string[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${m.text()} [${m.location().url}]`));
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('response', (r) => r.status() >= 400 && consoleErrors.push(`HTTP ${r.status()} ${new URL(r.url()).pathname}`));
    await page.goto(`${url}src/viewer/actors/dev/harness.html?splat=fixture/synth/sequence`);
    await page.waitForFunction(() => 'actorHarnessReady' in window || (window as any).__harness, null, { timeout: 60_000 });
    const ids = await page.evaluate(() => (window as any).__harness.ready());
    if (ids.join() !== 'raj,maya') fail(`actors mounted: ${ids}`);
    await page.waitForTimeout(4000);
    const fps = await page.evaluate('new Promise((r) => { let n = 0; const t0 = performance.now(); function f() { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); } requestAnimationFrame(f); })');
    console.log(`render loop ~${fps} fps`);
    const kinds = await page.evaluate(() => ['raj', 'maya'].map((id) => (window as any).__harness.debug(id).kind));
    if (kinds.join() !== 'mannequin,splat') fail(`actor kinds ${kinds} (splat path fell back?)`);
    for (const id of ['raj', 'maya']) {
      const b = await page.evaluate((i) => (window as any).__harness.box(i), id);
      const h = b.max[1] - b.min[1];
      console.log(`${id}: feet y=${b.min[1].toFixed(3)} height=${h.toFixed(3)} m`);
      if (Math.abs(b.min[1]) > 0.08 || h < 1.55 || h > 1.85) fail(`${id} is not standing 1.7 m on y=0: ${JSON.stringify(b)}`);
    }
    const idleFrames = new Set<number>();
    for (let i = 0; i < 8; i++) {
      idleFrames.add(await page.evaluate(() => (window as any).__harness.debug('maya').frame));
      await page.waitForTimeout(120);
    }
    const seqJson = JSON.parse(readFileSync(join(fixtures, 'synth/sequence/sequence.json'), 'utf8'));
    const idleN = seqJson.loops.idle.count;
    const talkR = seqJson.loops.talk;
    if (idleFrames.size < 3 || [...idleFrames].some((f) => f >= idleN)) fail(`splat idle loop not advancing within 0..${idleN - 1}: ${[...idleFrames]}`);
    if (shots) await page.screenshot({ path: join(shots, 'actors-idle.png') });

    // ---- speak: mannequin (amplitude-driven jaw) ----------------------------------------------
    const jawSamples: number[] = [];
    const speakRaj = page.evaluate(([u, s]) => (window as any).__harness.speak('raj', u, s), [`${url}fixture/line.wav`, seconds] as const);
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000 * 0.8) {
      const d = await page.evaluate(() => (window as any).__harness.debug('raj'));
      jawSamples.push(d.jaw);
      await page.waitForTimeout(25);
    }
    if (shots) await page.screenshot({ path: join(shots, 'actors-speaking.png') });
    const took = await speakRaj;
    const state = await page.evaluate(() => (window as any).__harness.audioState());
    console.log(`raj.speak resolved after ${took.toFixed(2)} s (audio ${seconds.toFixed(2)} s, context ${state}); jaw max ${Math.max(...jawSamples).toFixed(2)}`);
    if (took < seconds - 0.25 || took > seconds + 1.0) fail(`speak() resolved after ${took}s, expected ~${seconds}s`);
    // headless SwiftShader renders ~15 fps, so troughs between 120 ms syllables are under-sampled:
    // require a clearly open jaw and a large swing rather than a full close
    const live = jawSamples.slice(8);
    if (Math.max(...live) < 0.3 || Math.max(...live) - Math.min(...live) < 0.35)
      fail(`jaw did not follow the syllables: ${jawSamples.map((v) => v.toFixed(2))}`);
    await page.waitForTimeout(150); // userData.debug refreshes on the next animation frame
    const after = await page.evaluate(() => (window as any).__harness.debug('raj'));
    if (after.speaking) fail('raj still speaking after the promise resolved');

    // ---- speak: splat actor (switches to the talk loop) ----------------------------------------
    const speakMaya = page.evaluate(([u, s]) => (window as any).__harness.speak('maya', u, s), [`${url}fixture/line.wav`, seconds] as const);
    await page.waitForTimeout(700);
    const talkFrames = new Set<number>();
    for (let i = 0; i < 8; i++) {
      talkFrames.add(await page.evaluate(() => (window as any).__harness.debug('maya').frame));
      await page.waitForTimeout(110);
    }
    const tookMaya = await speakMaya;
    console.log(`maya.speak resolved after ${tookMaya.toFixed(2)} s; talk frames ${[...talkFrames].sort((a, b) => a - b)}`);
    if ([...talkFrames].some((f) => f < talkR.start || f >= talkR.start + talkR.count) || talkFrames.size < 2) fail(`splat talk loop not used: ${[...talkFrames]}`);
    if (Math.abs(tookMaya - seconds) > 1.0) fail(`maya.speak resolved after ${tookMaya}s`);
    await page.waitForTimeout(400);
    const back = await page.evaluate(() => (window as any).__harness.debug('maya'));
    if (back.frame >= idleN) fail('splat actor did not return to its idle loop');

    const harnessErrors = await page.evaluate(() => (window as any).__harness.errors);
    const errors = [...consoleErrors, ...harnessErrors];
    if (errors.length) fail(`console errors:\n${errors.join('\n')}`);
    console.log('actor browser check: OK');
  } finally {
    await browser.close();
    await server.close();
    if (realSeq) rmSync(join(fixtures, 'synth'), { force: true }); // the symlink, not the library
    rmSync(fixtures, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
