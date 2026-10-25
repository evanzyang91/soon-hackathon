// Pipeline CLI (reads keys through server/env.ts; never prints them).
//
//   pnpm tsx server/pipeline/cli.ts generate-world "<prompt>" <outDir> [--model marble-1.1] [--name <display name>] [--mock] [--retry-failed]
//       Real Marble generation (~5 min, spends credits). Safe to re-run: the receipt in <outDir>
//       makes a rerun poll/fetch the recorded job instead of submitting a new one.
//   pnpm tsx server/pipeline/cli.ts parse <screenplay.fountain> [--mock] [--out plan.json]
//       Screenplay → ScreenplayPlan with Claude (or the offline parser with --mock); prints a summary.
//   pnpm tsx server/pipeline/cli.ts run <screenplay.fountain> [--title <title>]
//       Creates a project under DATA_DIR and runs the whole pipeline (honours MOCK).
//   pnpm tsx server/pipeline/cli.ts make-mock-world [set|all]
//       Regenerates fixtures/mock-world/<set>/ (world.spz + thumbnail.png) for one procedural mock
//       set (street, forest, hall, cave, desert, station, shore, village, room, field) or all.
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
//   pnpm tsx server/pipeline/cli.ts stage <projectDir> <sceneIndex> [--write] [--reuse]
//                                  [--before-after out.png] [--views dir] [--report out.json]
//       Stages the scene's actors on its world (staging.ts: Claude picks each character's mark on
//       free ground seen from the start camera; ~$0.05-0.15 per scene) and prints old → new marks
//       with Claude's notes and reasoning. Nothing is written without --write, which stores
//       scene-<n>/staging.json and rewrites plan.blocking in scene-<n>/manifest.json (plan.json
//       keeps the planner's). --reuse takes a current staging.json instead of asking again.
//       --before-after renders the planner's vs the staged marks from the start camera (+ a second
//       angle); --views keeps the two images Claude saw.
//   pnpm tsx server/pipeline/cli.ts look <projectDir> <sceneIndex> [--write] [--preset <name>]
//       Prints the scene's look seed (plan.json's look, else derived from heading, time of day and
//       interior: look-seed.ts) and the look name it gives. --preset swaps the preset (keeping the
//       mood words). --write sets scene-<n>/edits.json's look to it, keeping the edits, the history
//       (one entry added) and the director's lights and lens; revision + 1. No network.
//   pnpm tsx server/pipeline/cli.ts models "<label>" [--kind creature] [--fetch]
//       Found models (models.ts): the family the label names and the top 5 candidates of the local
//       index with score, licence, clips and size (kind from the label's words when not given).
//       --fetch downloads the best into the model library (MODELS_LIBRARY_DIR, data/models-library)
//       and prints the wall time; a library hit needs no network.
//   pnpm tsx server/pipeline/cli.ts models --bench [--no-fetch]
//       The 20 BENCH_LABELS: p50 / p95 lookup and download times, hit rate, and the animated hit
//       rate of the creature-like labels (Hugging Face downloads only).
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { seedToLook } from '../../shared/look-presets.ts';
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
import { EditsStore } from './edits.ts';
import { readJson, writeJsonAtomic } from './fsutil.ts';
import { lookSeedFor, styleForPlan, writeSceneLook } from './look-seed.ts';
import { LookPresetName, ScreenplayPlan } from '../../shared/schema.ts';
import {
  applyStagingToManifest,
  formatStaging,
  groundMarks,
  measureGroundAtMarks,
  readStaging,
  renderStagingBeforeAfter,
  stagedBlocking,
  stageScene,
  stagingCurrent,
  writeStaging,
} from './staging.ts';
import { generateWorld, marbleModel } from './marble.ts';
import { isMockSet, MOCK_SETS } from './mock-set.ts';
import { MOCK_SPZ_MAX_BYTES, writeMockSets } from './mock-world.ts';
import { defaultStore } from './project.ts';
import { kindForWords } from './dynamics.ts';
import {
  clipsMissing,
  fetchModel,
  findModel,
  LICENSES,
  loadModelIndex,
  type FindResult,
} from './models.ts';
import type { DynamicElementKind } from '../../shared/schema.ts';
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
  'fetch',
  'bench',
  'no-fetch',
]);

/** `cli models --bench`: the noun families of docs/PLAN-v4.md "Found models", one label each. */
export const BENCH_LABELS: { label: string; kind?: DynamicElementKind }[] = [
  { label: 'A huge T. rex lumbers past.' },
  { label: 'A velociraptor runs across the street.' },
  { label: 'A triceratops grazes in the distance.' },
  { label: 'A dog trots past.' },
  { label: 'A cat wanders by.' },
  { label: 'A horse gallops past.' },
  { label: 'A herd of deer crosses the field.' },
  { label: 'An elephant walks by.' },
  { label: 'A dragon flies overhead.' },
  { label: 'A robot walks past.', kind: 'creature' },
  { label: 'A red sports car drives by.' },
  { label: 'A police car speeds past.' },
  { label: 'A taxi pulls up.' },
  { label: 'A bus rumbles past.' },
  { label: 'A motorcycle zooms by.' },
  { label: 'An airliner flies low overhead.' },
  { label: 'A police helicopter hovers over the street.' },
  { label: 'A UFO hovers over the street.' },
  { label: 'A hot-air balloon drifts overhead.', kind: 'generic' },
  { label: 'A sailboat glides past.' },
];

const CREATURE_KINDS = new Set<DynamicElementKind>(['creature', 'dog', 'horse', 'bird', 'dragon', 'pedestrian']);
const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;
const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
};

function printFind(label: string, kind: DynamicElementKind, r: FindResult) {
  const q = r.query;
  console.log(
    `"${label}" → kind ${kind}, ${q ? `family ${q.family.id}${q.needsClips ? ' (needs clips)' : ''}, height ${q.heightM} m${q.extras.length ? `, also ${q.extras.join(' ')}` : ''}` : 'no family'}`,
  );
  r.candidates.forEach((c, i) =>
    console.log(
      `  ${i + 1}. ${c.score.toFixed(1).padStart(5)}  ${c.name.slice(0, 44).padEnd(44)} ${LICENSES[c.license].id.padEnd(12)} ${c.anim ? `animated ${c.anim}` : 'static    '}  ${String(Math.round(c.faces / 1000)).padStart(4)}k faces  ${mb(c.bytes).padStart(7)}  ${c.uid}${c.family !== q?.family.id ? `  (as ${c.family})` : ''}`,
    ),
  );
  if (!r.candidates.length) console.log('  (no candidate: the procedural body stays)');
}

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
        // --reuse: the stored decision (old rule) on the left, the re-decided one on the right
        await renderBeforeAfter(worldDir, report, resolve(ba), { log, ...(prev ? { previous: prev } : {}) });
        log(`before/after image: ${ba}`);
      }
      return;
    }
    case 'stage': {
      const [dir, n] = pos;
      if (!dir || n === undefined || !/^\d+$/.test(n))
        throw new Error(
          'usage: stage <projectDir> <sceneIndex> [--write] [--reuse] [--before-after out.png] [--views dir] [--report out.json]',
        );
      const projectDir = resolve(dir);
      const plan = ScreenplayPlan.parse(await readJson(join(projectDir, 'plan.json')));
      const scene = plan.scenes[Number(n)];
      if (!scene) throw new Error(`no scene ${n} in ${dir}/plan.json`);
      const sceneDir = join(projectDir, `scene-${n}`);
      const worldDir = join(sceneDir, 'world');
      const asset = await readWorldAsset(worldDir);
      const inputs = { worldId: asset.worldId, scene, characters: plan.characters, factor: asset.scaleCalibration?.factor ?? 1 };
      const prev = flags.reuse === true ? await readStaging(sceneDir) : undefined;
      let report = prev && stagingCurrent(prev, inputs) ? prev : undefined;
      if (flags.reuse === true) log(report ? 'reusing scene staging.json (no Claude call)' : 'no current staging.json for this scene; staging');
      if (!report) {
        if (!env.keys.anthropic) throw new Error('ANTHROPIC_API_KEY is not set (.env.local / .env)');
        report = await stageScene({ worldDir, asset, scene, characters: plan.characters, log, saveViewsTo: views0(flags) });
      }
      console.log(formatStaging(report, `${scene.heading} (${dir})`));
      const out = str(flags.report);
      if (out) await writeFile(resolve(out), `${JSON.stringify(report, null, 2)}\n`);
      if (flags.write === true) {
        await writeStaging(sceneDir, report);
        const m = await applyStagingToManifest(sceneDir, report, log);
        log(`wrote ${sceneDir}/staging.json${m ? ' and plan.blocking in manifest.json' : ' (manifest.json not changed: missing, another world, or nothing staged)'}`);
        const staged = stagedBlocking(report, { asset, scene, characters: plan.characters });
        if (staged) {
          const next = await measureGroundAtMarks(worldDir, asset, groundMarks(staged, scene.blocking), { log, manifest: true });
          log(`floor offset ${next.floorOffsetMeters ?? '—'} and the ground field re-measured at the staged marks (world-asset.json, ground.json, manifest.json)`);
        }
      }
      const ba = str(flags['before-after']);
      if (ba) {
        await renderStagingBeforeAfter(worldDir, report, resolve(ba), { log, characters: plan.characters });
        log(`before/after image: ${ba}`);
      }
      return;
    }
    case 'look': {
      const [dir, n] = pos;
      if (!dir || n === undefined || !/^\d+$/.test(n))
        throw new Error('usage: look <projectDir> <sceneIndex> [--write] [--preset <name>]');
      const projectDir = resolve(dir);
      const plan = ScreenplayPlan.parse(await readJson(join(projectDir, 'plan.json')));
      const scene = plan.scenes[Number(n)];
      if (!scene) throw new Error(`no scene ${n} in ${dir}/plan.json`);
      let seed = lookSeedFor(scene, styleForPlan(plan));
      const preset = str(flags.preset);
      if (preset) {
        const p = LookPresetName.safeParse(preset);
        if (!p.success) throw new Error(`unknown preset "${preset}" (${LookPresetName.options.join(', ')})`);
        // the planner's adjustments were tuned to its own preset: keep only the mood words
        seed = { preset: p.data, mood: seed.mood };
      }
      console.log(`${scene.heading}: ${scene.look ? "the plan's look" : 'derived from the heading (plan.json has no look)'}${preset ? `, preset ${preset}` : ''}`);
      console.log(JSON.stringify(seed, null, 2));
      console.log(`look name: ${seedToLook(seed).name}`);
      if (flags.write === true) {
        // the project's own data dir and id, so the store's validation and revisions apply
        const store = new EditsStore(() => dirname(projectDir));
        const saved = await writeSceneLook(store, basename(projectDir), Number(n), seed, 'look from the plan (cli look)');
        log(`wrote scene-${n}/edits.json: look "${saved.look.name}", revision ${saved.revision} (${saved.edits.length} edit(s) and the history kept)`);
        // a built scene's manifest carries the seed too (the laptop's "Scene's look" reads manifest.plan.look)
        const manifestPath = join(projectDir, `scene-${n}`, 'manifest.json');
        const raw = await readJson<{ plan?: Record<string, unknown> }>(manifestPath).catch(() => undefined);
        if (raw?.plan) {
          await writeJsonAtomic(manifestPath, { ...raw, plan: { ...raw.plan, look: seed } });
          log(`wrote scene-${n}/manifest.json: plan.look = ${seed.preset}`);
        }
      }
      return;
    }
    case 'models': {
      const t0 = performance.now();
      await loadModelIndex();
      const loadMs = performance.now() - t0;
      const libraryDir = env.modelsLibraryDir;
      if (flags.bench) {
        const rows: { label: string; kind: DynamicElementKind; r: FindResult; dl?: number; cached?: boolean; clips?: number; rig?: string | null; err?: string }[] = [];
        for (const b of BENCH_LABELS) {
          const kind = b.kind ?? kindForWords(b.label) ?? 'generic';
          const r = await findModel(b.label, kind);
          const row: (typeof rows)[number] = { label: b.label, kind, r };
          if (r.candidate && flags['no-fetch'] !== true) {
            const t = performance.now();
            try {
              const got = await fetchModel(r.candidate, { libraryDir });
              row.dl = performance.now() - t;
              row.cached = got.cached;
              row.clips = got.meta.clips.length;
              row.rig = clipsMissing(got.meta);
            } catch (e) {
              row.err = (e as Error).message;
            }
          }
          rows.push(row);
          const c = r.candidate;
          console.log(
            `${b.label.padEnd(46)} ${kind.padEnd(10)} ${(r.query?.family.id ?? '—').padEnd(12)} ${r.ms.toFixed(1).padStart(6)} ms  ${c ? `${c.name.slice(0, 34).padEnd(34)} ${LICENSES[c.license].id.padEnd(12)} ${c.anim ? 'anim' : 'stat'} ${mb(c.bytes).padStart(7)}` : '(none)'.padEnd(64)}${row.dl !== undefined ? `  ${row.cached ? 'library' : `${(row.dl / 1000).toFixed(2)} s`}${row.clips !== undefined ? ` · ${row.clips} clip(s)${row.rig && (CREATURE_KINDS.has(kind) || r.query?.needsClips) ? ` (${row.rig})` : ''}` : ''}` : row.err ? `  FAILED ${row.err}` : ''}`,
          );
        }
        const look = rows.map((x) => x.r.ms);
        const net = rows.filter((x) => x.dl !== undefined && !x.cached).map((x) => x.dl!);
        const hits = rows.filter((x) => x.r.candidate).length;
        const creatures = rows.filter((x) => CREATURE_KINDS.has(x.kind) || x.r.query?.needsClips);
        const animHits = creatures.filter((x) => x.r.candidate && x.r.candidate.anim > 0 && (x.clips === undefined || !x.rig)).length;
        console.log(
          `\nindex load ${loadMs.toFixed(0)} ms · lookup p50 ${pct(look, 50).toFixed(1)} ms, p95 ${pct(look, 95).toFixed(1)} ms` +
            (net.length ? ` · download p50 ${(pct(net, 50) / 1000).toFixed(2)} s, p95 ${(pct(net, 95) / 1000).toFixed(2)} s (${net.length} from the network, ${rows.filter((x) => x.cached).length} from the library)` : ' · no downloads') +
            ` · hit rate ${hits}/${rows.length} · animated hit rate (creature-like) ${animHits}/${creatures.length}` +
            ` · ${rows.filter((x) => x.err).length} download failure(s)`,
        );
        return;
      }
      const label = pos[0];
      if (!label) throw new Error('usage: models "<label>" [--kind creature] [--fetch]  |  models --bench [--no-fetch]');
      const kind = (str(flags.kind) ?? kindForWords(label) ?? 'generic') as DynamicElementKind;
      const r = await findModel(label, kind);
      printFind(label, kind, r);
      console.log(`lookup ${r.ms.toFixed(1)} ms (index load ${loadMs.toFixed(0)} ms)`);
      if (flags.fetch && r.candidate) {
        const t = performance.now();
        const got = await fetchModel(r.candidate, { libraryDir });
        console.log(
          `${got.cached ? 'library hit' : `downloaded ${mb(got.meta.bytes)}`} in ${((performance.now() - t) / 1000).toFixed(2)} s → ${join(got.dir, 'model.glb')} · clips: ${got.meta.clips.join(', ') || 'none'} · ${got.meta.attribution}`,
        );
      }
      return;
    }
    case 'make-mock-world': {
      const which = pos[0] ?? 'all';
      if (which !== 'all' && !isMockSet(which))
        throw new Error(`usage: make-mock-world [set|all]  (sets: ${MOCK_SETS.join(', ')})`);
      for (const r of await writeMockSets(which === 'all' ? MOCK_SETS : [which])) {
        const over = r.spzBytes > MOCK_SPZ_MAX_BYTES ? `  OVER the ${MOCK_SPZ_MAX_BYTES / 1024} KB budget` : '';
        log(`wrote ${r.dir}/world.spz (${r.splats} splats, ${(r.spzBytes / 1024).toFixed(1)} KB) + thumbnail.png${over}`);
      }
      return;
    }
    default:
      console.log(
        'commands: generate-world "<prompt>" <outDir> | parse <file> | run <file> | calibrate <worldDir> | stage <projectDir> <sceneIndex> | look <projectDir> <sceneIndex> | models "<label>" [--fetch] | models --bench | make-mock-world [set|all]  (see header of server/pipeline/cli.ts)',
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
