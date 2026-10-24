import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { SceneManifest, ScreenplayPlan, type ScenePlan, type WorldAsset } from '../../shared/schema.ts';
import { TriGrid } from '../../web/src/viewer/placement.ts';
import { RayGrid } from './calibrate-geometry.ts';
import { projectPoint } from './calibrate-vision.ts';
import { yawFacing } from './geometry.ts';
import { encodeGlb } from './glb.ts';
import { ProjectStore } from './project.ts';
import { stagedBlocking, stageScene, stagingInputsHash, type StagingReport } from './staging.ts';
import { coveredFraction, planMarks, resolveAnswer, stagingView, type StagingAnswer } from './staging-vision.ts';

type P = [number, number, number];
const quad = (a: P, b: P, c: P, d: P) => [...a, ...b, ...c, ...a, ...c, ...d];
const floor = (r: number) => quad([-r, 0, -r], [-r, 0, r], [r, 0, r], [r, 0, -r]);
/** A closed box standing on the floor (top + four sides). */
const box = (x0: number, x1: number, z0: number, z1: number, h: number) => [
  ...quad([x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]),
  ...quad([x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]),
  ...quad([x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]),
  ...quad([x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]),
  ...quad([x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]),
];
// an open floor with a counter (0.9 m) right of centre and a bench seat (0.45 m) on the left
const TRIS = Float32Array.from([...floor(30), ...box(1, 2, -3.5, -2.5, 0.9), ...box(-2.4, -1.6, -3.4, -3.0, 0.45)]);
const geo = { grid: new TriGrid(TRIS), cast: new RayGrid(TRIS).cast };

const scene = (o: Partial<ScenePlan> = {}): ScenePlan => ({
  index: 0,
  slug: 'ext-bus-stop-night',
  heading: 'EXT. BUS STOP - NIGHT',
  action: 'MAYA waits by the bench. LEO jogs in.',
  worldPrompt: 'a bus stop',
  timeOfDay: 'night',
  interior: false,
  characterIds: ['maya', 'leo'],
  dialogue: [],
  blocking: [
    { characterId: 'maya', position: [-0.7, 0, -2.8], yaw: -1.6, pose: 'standing' },
    { characterId: 'leo', position: [0.8, 0, -2.6], yaw: 1.4, pose: 'walking' },
  ],
  dynamics: [],
  shots: [],
  ...o,
});
const characters = [
  { id: 'maya', name: 'MAYA', description: 'woman, 30s', voice: { id: 'nova', gender: 'female' as const } },
  { id: 'leo', name: 'LEO', description: 'man, 40s', voice: { id: 'onyx', gender: 'male' as const } },
];
const who = (o: Partial<StagingAnswer['characters'][number]> & { characterId: string }): StagingAnswer['characters'][number] => ({
  mark: '',
  px: null,
  pose: 'standing',
  facing: 'camera',
  note: 'a note',
  reasoning: 'why',
  ...o,
});
const answer = (characters: StagingAnswer['characters']): StagingAnswer => ({ set: 'open floor', characters });

describe('staging marks', () => {
  const marks = planMarks(geo);
  const at = (x: number, z: number) => marks.find((m) => Math.abs(m.x - x) < 1e-6 && Math.abs(m.z - z) < 1e-6);

  it('labels free, visible floor in rows from the camera, numbered left to right', () => {
    expect(marks.length).toBeGreaterThan(30);
    expect(marks[0]!.label).toBe('A1');
    const rowA = marks.filter((m) => m.label.startsWith('A'));
    expect(new Set(rowA.map((m) => m.z)).size).toBe(1);
    expect(rowA.map((m) => m.x)).toEqual([...rowA.map((m) => m.x)].sort((a, b) => a - b));
    const rowB = marks.filter((m) => m.label.startsWith('B'));
    expect(rowB[0]!.z).toBeLessThan(rowA[0]!.z);
  });

  it('leaves out spots in or against the counter, behind it, and outside the director frame', () => {
    expect(at(1.5, -3)).toBeUndefined(); // inside the counter
    expect(at(1.5, -4.5)).toBeUndefined(); // hidden behind it
    expect(at(0, -3)).toBeDefined();
    expect(at(4, -3)).toBeUndefined(); // 53° off axis: outside the start view
  });

  it('turns marks into blocking facing each other, with the note kept', () => {
    const a = at(-1, -3)!;
    const b = at(0.5, -3.5)!;
    const r = resolveAnswer(
      answer([who({ characterId: 'maya', mark: a.label, facing: 'leo', note: 'by the bench' }), who({ characterId: 'leo', mark: b.label.toLowerCase(), facing: 'maya' })]),
      { scene: scene(), marks, geo },
    );
    expect(r.failures).toEqual([]);
    const [maya, leo] = r.blocking;
    expect(maya!.position).toEqual([-1, 0, -3]);
    expect(leo!.position).toEqual([0.5, 0, -3.5]);
    expect(maya!.yaw).toBeCloseTo(yawFacing(maya!.position, leo!.position), 3);
    expect(leo!.yaw).toBeCloseTo(yawFacing(leo!.position, maya!.position), 3);
    expect(maya!.note).toBe('by the bench');
    expect(leo!.pose).toBe('standing');
  });

  it('fails unknown marks, missing characters, crowding and someone hidden behind someone else', () => {
    const ctx = { scene: scene(), marks, geo };
    expect(resolveAnswer(answer([who({ characterId: 'maya', mark: 'Z9' })]), ctx).failures.sort()).toEqual([
      'leo has no mark',
      'maya: mark "Z9" is not one of the labelled marks',
    ]);
    const same = resolveAnswer(answer([who({ characterId: 'maya', mark: at(0, -3)!.label }), who({ characterId: 'leo', mark: at(0.5, -3)!.label })]), ctx);
    expect(same.failures.join()).toMatch(/only 0\.50 m apart/);
    const behind = resolveAnswer(answer([who({ characterId: 'maya', mark: at(0, -2)!.label }), who({ characterId: 'leo', mark: at(0, -5.5)!.label })]), ctx);
    expect(behind.failures.join()).toMatch(/sees leo \d+% hidden behind maya/);
    expect(coveredFraction([0, 1.6, 0], [0, 0, -2], [1.5, 0, -3])).toBe(0);
  });

  it('casts a feet pixel onto the floor, refuses one on the counter, and seats a sitter on the bench', () => {
    const view = stagingView('standard');
    const pxOf = (p: P) => {
      const q = projectPoint(view, p)!;
      return { x: q[0], y: q[1] };
    };
    const ctx = { scene: scene(), marks, geo };
    const feet = resolveAnswer(answer([who({ characterId: 'maya', px: pxOf([-1.2, 0, -4.2]) }), who({ characterId: 'leo', mark: at(0, -3)!.label })]), ctx);
    expect(feet.failures).toEqual([]);
    expect(feet.blocking[0]!.position[0]).toBeCloseTo(-1.2, 2);
    expect(feet.blocking[0]!.position[2]).toBeCloseTo(-4.2, 2);
    const wall = resolveAnswer(answer([who({ characterId: 'maya', px: pxOf([1.4, 0.5, -2.5]) }), who({ characterId: 'leo', mark: at(0, -3)!.label })]), ctx);
    expect(wall.failures.join()).toMatch(/feet pixel .* is not on the floor/);
    const sit = resolveAnswer(
      answer([who({ characterId: 'maya', pose: 'sitting', px: pxOf([-2, 0.45, -3.2]), facing: 'leo' }), who({ characterId: 'leo', mark: at(-0.5, -3.5)!.label, facing: 'maya' })]),
      ctx,
    );
    expect(sit.failures).toEqual([]);
    expect(sit.blocking[0]!.pose).toBe('sitting');
    expect(Math.hypot(sit.blocking[0]!.position[0] + 2, sit.blocking[0]!.position[2] + 3.2)).toBeLessThan(0.3);
    const noSeat = resolveAnswer(answer([who({ characterId: 'maya', pose: 'sitting', px: pxOf([-0.5, 0, -2.5]) }), who({ characterId: 'leo', mark: at(0.5, -3.5)!.label })]), ctx);
    expect(noSeat.failures.join()).toMatch(/0\.00 m above the floor, not a seat/);
  });
});

// ---------------------------------------------------------------------------
// stageScene with an injected request and renderer
// ---------------------------------------------------------------------------

async function worldDir(): Promise<{ dir: string; asset: WorldAsset }> {
  const dir = await mkdtemp(join(tmpdir(), 'previz-staging-'));
  const asset: WorldAsset = {
    provider: 'marble',
    worldId: 'w-1',
    spz: { k500: 'world_500k.spz' },
    colliderGlb: 'collider.glb',
    metricScaleFactor: 1,
    groundPlaneOffset: 0,
    opencvFrame: false,
    caption: 'An empty bus stop with a bench.',
  };
  await writeFile(join(dir, 'collider.glb'), encodeGlb(TRIS));
  await writeFile(join(dir, 'world-asset.json'), JSON.stringify(asset));
  return { dir, asset };
}

const fakeRenderer = async () => ({
  shot: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  compose: async () => Buffer.from([]),
  close: async () => {},
});

/** The label the prompt's mark table gives the spot (x, z). */
const labelAt = (text: string, x: number, z: number) =>
  new RegExp(`^([A-K]\\d+): ${x.toFixed(1)}, ${z.toFixed(1)},`, 'm').exec(text)![1]!;

const message = (a: StagingAnswer) =>
  ({
    stop_reason: 'end_turn',
    usage: { input_tokens: 5000, output_tokens: 1000 },
    content: [{ type: 'text', text: JSON.stringify(a) }],
  }) as unknown as Anthropic.Beta.BetaMessage;

describe('stageScene', () => {
  it('feeds validation failures back once and keeps the corrected answer', async () => {
    const { dir } = await worldDir();
    const texts: string[] = [];
    const answers = (t: string) => [
      answer([who({ characterId: 'maya', mark: labelAt(t, -1, -3) }), who({ characterId: 'leo', mark: 'Q1' })]),
      answer([who({ characterId: 'maya', mark: labelAt(t, -1, -3), facing: 'leo', note: 'by the bench' }), who({ characterId: 'leo', mark: labelAt(t, 0.5, -3.5), facing: 'maya' })]),
    ];
    const report = await stageScene({
      worldDir: dir,
      scene: scene(),
      characters,
      openRenderer: fakeRenderer,
      call: async (req) => {
        texts.push((req.content.at(-1) as { text: string }).text);
        expect(req.content.filter((b) => b.type === 'image').length).toBeGreaterThanOrEqual(2);
        return message(answers(texts[0]!)[texts.length - 1]!);
      },
    });
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('An empty bus stop with a bench.');
    expect(texts[1]).toContain('leo: mark "Q1" is not one of the labelled marks');
    expect(report.status).toBe('staged');
    expect(report.blocking.map((b) => b.note)).toEqual(['by the bench', 'a note']);
    expect(report.usage.costUsd).toBeCloseTo(2 * (5000 * 4 + 1000 * 20) / 1e6, 6);
    expect(report.inputsHash).toBe(stagingInputsHash({ worldId: 'w-1', scene: scene(), characters }));
  });

  it('shows a passing answer back with mannequins; a broken correction leaves the first standing', async () => {
    const { dir } = await worldDir();
    const reqs: { text: string; images: number }[] = [];
    const report = await stageScene({
      worldDir: dir,
      scene: scene(),
      characters,
      openRenderer: fakeRenderer,
      call: async (req) => {
        const text = (req.content.at(-1) as { text: string }).text;
        reqs.push({ text, images: req.content.filter((b) => b.type === 'image').length });
        const first = reqs[0]!.text;
        return message(
          reqs.length === 1
            ? answer([who({ characterId: 'maya', mark: labelAt(first, -1, -3), facing: 'leo' }), who({ characterId: 'leo', mark: labelAt(first, 0.5, -3.5), facing: 'maya' })])
            : answer([who({ characterId: 'maya', mark: 'nowhere' }), who({ characterId: 'leo', mark: labelAt(first, 0.5, -3.5) })]),
        );
      },
    });
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!.images).toBeGreaterThan(reqs[0]!.images); // + the mannequin preview
    expect(reqs[1]!.text).toMatch(/passed the automatic checks/);
    expect(report.status).toBe('staged');
    expect(report.blocking[0]!.position).toEqual([-1, 0, -3]);
    expect(report.attempts[1]!.failures.join()).toMatch(/"nowhere" is not one of the labelled marks/);

    const once = await stageScene({
      worldDir: dir,
      scene: scene(),
      characters,
      openRenderer: fakeRenderer,
      review: false,
      call: async (req) => {
        const t = (req.content.at(-1) as { text: string }).text;
        return message(answer([who({ characterId: 'maya', mark: labelAt(t, -1, -3) }), who({ characterId: 'leo', mark: labelAt(t, 0.5, -3.5) })]));
      },
    });
    expect(once.attempts).toHaveLength(1);
    expect(once.status).toBe('staged');
  });

  it("keeps the planner's blocking when the retry fails too", async () => {
    const { dir } = await worldDir();
    const report = await stageScene({
      worldDir: dir,
      scene: scene(),
      characters,
      openRenderer: fakeRenderer,
      call: async (req) => {
        const mark = labelAt((req.content.at(-1) as { text: string }).text, 0, -3);
        return message(answer([who({ characterId: 'maya', mark }), who({ characterId: 'leo', mark })]));
      },
    });
    expect(report.status).toBe('kept');
    expect(report.attempts).toHaveLength(2);
    expect(report.reason).toMatch(/only 0\.00 m apart/);
    expect(report.blocking).toEqual(scene().blocking);
  });

  it('rescales staged marks to a later calibration factor and drops them when the scene changed', () => {
    const report = {
      schema: 'previz.staging/1',
      version: 1,
      status: 'staged',
      worldId: 'w-1',
      factor: 1,
      inputsHash: stagingInputsHash({ worldId: 'w-1', scene: scene(), characters }),
      blocking: [{ characterId: 'maya', position: [-1, 0, -3], yaw: 0, pose: 'standing' }],
    } as unknown as StagingReport;
    const asset = { worldId: 'w-1', scaleCalibration: { factor: 1.2 } } as WorldAsset;
    expect(stagedBlocking(report, { asset, scene: scene(), characters })![0]!.position).toEqual([-1.2, 0, -3.6]);
    expect(stagedBlocking(report, { asset, scene: scene({ action: 'rewritten' }), characters })).toBeUndefined();
    expect(stagedBlocking(report, { asset: { ...asset, worldId: 'w-2' }, scene: scene(), characters })).toBeUndefined();
  });
});

describe('pipeline', () => {
  it('a live Marble world is staged after download; the manifest carries the staged marks, plan.json the planner’s', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'previz-projects-'));
    const fixture = readFileSync(new URL('../../fixtures/screenplay.fountain', import.meta.url), 'utf8');
    const staged: string[] = [];
    const store = new ProjectStore({
      dataDir,
      mock: false,
      echo: false,
      calibrate: false,
      worldLibraryDir: null,
      actorsLibraryDir: null,
      keys: { anthropic: true, marble: true, tts: true },
      deps: {
        parseScreenplay: async (text, o) => (await import('./screenplay.ts')).parseScreenplay(text, { ...o, mock: true }),
        generateWorld: async ({ outDir }) => {
          await mkdir(outDir, { recursive: true });
          await writeFile(join(outDir, 'collider.glb'), encodeGlb(TRIS));
          await writeFile(join(outDir, 'world_500k.spz'), 'spz');
          return { provider: 'marble', worldId: `w-${outDir.split('/').at(-2)}`, spz: { k500: 'world_500k.spz' }, colliderGlb: 'collider.glb', metricScaleFactor: 1, groundPlaneOffset: 0, opencvFrame: false };
        },
        buildActor: async ({ character }) => ({ kind: 'glb-humanoid', characterId: character.id, glb: 'procedural:mannequin', clips: { idle: 'Idle', talk: 'Talk' } }),
        synthesizeLine: async ({ line, outDir }) => {
          await writeFile(join(outDir, `${line.id}.wav`), '');
          return { lineId: line.id, url: `${line.id}.wav`, durationSeconds: 1 };
        },
        stageScene: async ({ scene: sc, characters: cs, asset }) => {
          staged.push(sc.slug);
          return {
            schema: 'previz.staging/1',
            version: 1,
            inputsHash: stagingInputsHash({ worldId: asset!.worldId, scene: sc, characters: cs }),
            worldId: asset!.worldId,
            factor: 1,
            status: 'staged',
            blocking: sc.blocking.map((b, k) => ({ ...b, position: [k - 0.5, 0, -4], note: `staged ${b.characterId}` })),
          } as unknown as StagingReport;
        },
      },
    });
    const { id } = await store.createProject({ screenplay: fixture });
    await store.idle();
    expect(staged).toHaveLength(3);
    const plan = ScreenplayPlan.parse(JSON.parse(await readFile(join(dataDir, id, 'plan.json'), 'utf8')));
    const m = SceneManifest.parse(JSON.parse(await readFile(join(dataDir, id, 'scene-0', 'manifest.json'), 'utf8')));
    expect(m.plan.blocking.map((b) => b.position)).toEqual([[-0.5, 0, -4], [0.5, 0, -4]]);
    expect(m.plan.blocking[0]!.note).toMatch(/^staged /);
    expect(plan.scenes[0]!.blocking.map((b) => b.note)).toEqual([undefined, undefined]);
    expect(existsSync(join(dataDir, id, 'scene-0', 'staging.json'))).toBe(true);
    expect((await store.getProject(id))!.scenes[0]!.stages.world.note).toMatch(/2 actor\(s\) staged on the set$/);
  });
});
