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
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { env } from '../env.ts';
import { generateWorld, marbleModel } from './marble.ts';
import { MOCK_WORLD_DIR, writeMockWorld } from './mock-world.ts';
import { defaultStore } from './project.ts';
import { parseScreenplay, summarizePlan } from './screenplay.ts';

const BOOLEAN_FLAGS = new Set(['mock', 'retry-failed']);

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
      const asset = await generateWorld({
        prompt,
        outDir: resolve(outDir),
        name: str(flags.name) ?? `previz ${new Date().toISOString().slice(0, 16)}`,
        model,
        mock,
        log,
        retryFailed: flags['retry-failed'] === true,
      });
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
      const store = defaultStore();
      const status = await store.createProject({
        title: str(flags.title),
        screenplay: await readFile(file, 'utf8'),
      });
      log(`project ${status.id} in ${store.projectDir(status.id)} (${env.mock ? 'MOCK' : 'live'})`);
      await store.idle();
      console.log(JSON.stringify(await store.getProject(status.id), null, 2));
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
        'commands: generate-world "<prompt>" <outDir> | parse <file> | run <file> | make-mock-world  (see header of server/pipeline/cli.ts)',
      );
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
