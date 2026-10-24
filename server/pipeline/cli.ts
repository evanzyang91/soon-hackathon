// Pipeline CLI (reads keys through server/env.ts; never prints them).
//
//   pnpm tsx server/pipeline/cli.ts generate-world "<prompt>" <outDir> [--model marble-1.1] [--name <display name>] [--mock] [--retry-failed]
//       Real Marble generation (~5 min, spends credits). Safe to re-run: the receipt in <outDir>
//       makes a rerun poll/fetch the recorded job instead of submitting a new one.
//   pnpm tsx server/pipeline/cli.ts parse <screenplay.fountain> [--mock] [--out plan.json]
//       Screenplay → ScreenplayPlan with Claude (or the offline parser with --mock); prints a summary.
//   pnpm tsx server/pipeline/cli.ts run <screenplay.fountain> [--title <title>]
//       Creates a project under DATA_DIR and runs the whole pipeline (honours MOCK).
//   pnpm tsx server/pipeline/cli.ts make-mock-world
//       Regenerates fixtures/mock-world/ (world.spz + thumbnail.png).
//   pnpm tsx server/pipeline/cli.ts calibrate <worldDir> [--write] [--no-vision] [--interior|--exterior]
//                                  [--before-after out.png] [--views dir] [--reuse]
//       Measures the world's real scale (collider references + Claude vision with 1.70 m
//       mannequins, see calibrate.ts), the visible splat ground (floorOffsetMeters, at the
//       blocking marks of ../manifest.json when there is one) and the ground height field
//       (calibrate-ground.ts) and prints the report. --write stores all three in world-asset.json
//       (+ ground.json), the world-library copy with the same world id and ../manifest.json.
//       --reuse takes the last scale-calibration.json instead of measuring the scale (no Claude
//       call); the splat ground and the field are always measured again (local, ~2 s). So
//       `calibrate <project>/scene-<n>/world --reuse --no-vision --write` refreshes an existing
//       scene's ground (ground.json + its manifest) offline.
//   generate-world / run also calibrate the new world unless --no-calibrate (or CALIBRATE=0).
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from '../env.ts';
import {
  calibrateWorld,
  formatReport,
  previousCalibration,
  readWorldAsset,
  redecide,
  renderBeforeAfter,
  withGround,
  writeCalibration,
} from './calibrate.ts';
import { describeField, groundField } from './calibrate-ground.ts';
import { readJson } from './fsutil.ts';
import { generateWorld, marbleModel } from './marble.ts';
import { MOCK_WORLD_DIR, writeMockWorld } from './mock-world.ts';
import { defaultStore } from './project.ts';
import { parseScreenplay, summarizePlan } from './screenplay.ts';

const BOOLEAN_FLAGS = new Set([
  'mock',
  'retry-failed',
  'write',
  'no-vision',
  'interior',
  'exterior',
  'reuse',
  'no-calibrate',
]);

function args(argv: string[]) {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && !BOOLEAN_FLAGS.has(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const views0 = (flags: Record<string, string | true>) =>
  typeof flags.views === 'string' ? resolve(flags.views) : undefined;
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = args(rest);
  switch (cmd) {
    case 'generate-world': {
      const [prompt, outDir] = pos;
      if (!prompt || !outDir)
        throw new Error(
          'usage: generate-world "<prompt>" <outDir> [--model m] [--name n] [--mock]',
        );
      const mock = flags.mock === true;
      if (!mock && !env.keys.marble) throw new Error('WLT_API_KEY is not set (.env.local / .env)');
      const model = marbleModel(str(flags.model) ?? env.marbleModel);
      let asset = await generateWorld({
        prompt,
        outDir: resolve(outDir),
        name: str(flags.name) ?? `previz ${new Date().toISOString().slice(0, 16)}`,
        model,
        mock,
        log,
        retryFailed: flags['retry-failed'] === true,
      });
      if (asset.provider === 'marble' && env.calibrate && flags['no-calibrate'] !== true) {
        const report = await calibrateWorld(resolve(outDir), {
          vision: env.calibrateVision && !!env.keys.anthropic,
          log,
        });
        console.log(formatReport(report, outDir));
        asset = await writeCalibration(resolve(outDir), report, { log });
      }
      console.log(JSON.stringify(asset, null, 2));
      return;
    }
    case 'parse': {
      const [file] = pos;
      if (!file) throw new Error('usage: parse <screenplay.fountain> [--mock] [--out plan.json]');
      const text = await readFile(file, 'utf8');
      const mock = flags.mock === true || env.mock;
      if (!mock && !env.keys.anthropic) log('ANTHROPIC_API_KEY not set: offline parser');
      const plan = await parseScreenplay(text, { mock, log, title: str(flags.title) });
      const out = str(flags.out);
      if (out) await writeFile(out, `${JSON.stringify(plan, null, 2)}\n`);
      console.log(summarizePlan(plan));
      return;
    }
    case 'run': {
      const [file] = pos;
      if (!file) throw new Error('usage: run <screenplay.fountain> [--title t]');
      const store = flags['no-calibrate'] === true ? defaultStore({ calibrate: false }) : defaultStore();
      const status = await store.createProject({
        title: str(flags.title),
        screenplay: await readFile(file, 'utf8'),
      });
      log(`project ${status.id} in ${store.projectDir(status.id)} (${env.mock ? 'MOCK' : 'live'})`);
      await store.idle();
      console.log(JSON.stringify(await store.getProject(status.id), null, 2));
      return;
    }
    case 'calibrate': {
      const [dir] = pos;
      if (!dir)
        throw new Error(
          'usage: calibrate <worldDir> [--write] [--no-vision] [--interior|--exterior] [--before-after out.png] [--views dir] [--reuse]',
        );
      const worldDir = resolve(dir);
      const asset = await readWorldAsset(worldDir);
      // a project world: measure the floor where that scene's actors stand
      const scene = await readJson<{ world?: { worldId?: string }; plan?: { blocking?: { position: number[] }[] } }>(
        join(dirname(worldDir), 'manifest.json'),
      ).catch(() => undefined);
      const marks =
        scene?.world?.worldId === asset.worldId
          ? scene?.plan?.blocking?.map((b) => [b.position[0]!, b.position[2]!] as const)
          : undefined;
      if (marks?.length) log(`floor measured at the scene's blocking marks: ${marks.map((m) => `(${m.join(', ')})`).join(' ')}`);
      const prev = flags.reuse === true ? await previousCalibration(worldDir, asset.worldId) : null;
      let report = prev && (await withGround(redecide(prev), worldDir, marks));
      if (flags.reuse === true && !report) log('no previous scale-calibration.json for this world; measuring');
      if (!report) {
        const vision = flags['no-vision'] !== true && env.calibrateVision;
        if (vision && !env.keys.anthropic) log('ANTHROPIC_API_KEY not set: geometric measurement only');
        report = await calibrateWorld(worldDir, {
          interior: flags.interior === true ? true : flags.exterior === true ? false : undefined,
          vision: vision && !!env.keys.anthropic,
          log,
          saveViewsTo: views0(flags),
          marks,
        });
      }
      console.log(formatReport(report, dir));
      const views = str(flags.views);
      if (views) await writeFile(resolve(views, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      let written = asset;
      if (flags.write === true) {
        written = await writeCalibration(worldDir, report, { libraryDir: env.worldLibraryDir, manifest: true, log, marks });
        log(`wrote scaleCalibration ×${report.calibration.factor} (${report.calibration.confidence}), floorOffsetMeters ${report.floorOffsetMeters ?? '—'}, ground ${written.ground ? `${written.ground.file} (${written.ground.covered}/${written.ground.cells} cells)` : '—'} to ${dir}`);
      }
      const field = await groundField(worldDir, written, { marks }).catch((e: Error) => {
        log(`ground field not measured: ${e.message}`);
        return null;
      });
      console.log(describeField(field, written, marks));
      const ba = str(flags['before-after']);
      if (ba) {
        await renderBeforeAfter(worldDir, report, resolve(ba), { log });
        log(`before/after image: ${ba}`);
      }
      return;
    }
    case 'make-mock-world': {
      const r = await writeMockWorld();
      log(
        `wrote ${MOCK_WORLD_DIR}world.spz (${r.splats} splats, ${r.spzBytes} bytes) + thumbnail.png`,
      );
      return;
    }
    default:
      console.log(
        'commands: generate-world "<prompt>" <outDir> | parse <file> | run <file> | calibrate <worldDir> | make-mock-world  (see header of server/pipeline/cli.ts)',
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
