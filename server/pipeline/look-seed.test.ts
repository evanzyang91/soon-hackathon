import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { LOOK_PRESETS, seedToLook } from '../../shared/look-presets.ts';
import { defaultLook, emptySceneEdits, SceneEdits } from '../../shared/look.ts';
import { ScreenplayPlan } from '../../shared/schema.ts';
import { EditsConflict, EditsStore } from './edits.ts';
import { mockPlan } from './fountain.ts';
import { lookSeedFor, SEED_PROMPT, seedSceneLook, styleForPlan, writeSceneLook } from './look-seed.ts';
import { ProjectStore } from './project.ts';

const fixture = (f: string) => readFileSync(new URL(`../../fixtures/${f}.fountain`, import.meta.url), 'utf8');
const ID = 'look-abc123';
let dataDir: string;
let store: EditsStore;
const onDisk = async (n: number) =>
  SceneEdits.parse(JSON.parse(await readFile(join(dataDir, ID, `scene-${n}`, 'edits.json'), 'utf8')));

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-look-seed-'));
  for (const n of [0, 1]) await mkdir(join(dataDir, ID, `scene-${n}`), { recursive: true });
  store = new EditsStore(() => dataDir);
});

describe('lookSeedFor / styleForPlan', () => {
  it("takes the plan's look, else derives one (a plan made before looks were planned)", () => {
    const plan = ScreenplayPlan.parse(mockPlan(fixture('screenplay')));
    expect(lookSeedFor(plan.scenes[0]!, plan.style)).toBe(plan.scenes[0]!.look);
    // the live bus-stop project's plan.json: no style, no looks
    const { style: _s, ...old } = plan;
    const legacy = ScreenplayPlan.parse({ ...old, scenes: plan.scenes.map(({ look: _l, ...s }) => s) });
    expect(legacy.style).toBeUndefined();
    const style = styleForPlan(legacy);
    expect(style.genre).toBe('contemporary drama');
    expect(legacy.scenes.map((s) => lookSeedFor(s, style).preset)).toEqual(['night-street', 'warm-interior', 'golden-hour']);
    // time of day and interior come from the plan (the chat may have amended them), not the heading
    expect(lookSeedFor({ ...legacy.scenes[2]!, timeOfDay: 'night' }, style).preset).toBe('night-street');
  });

  it('reads a style from an older fantasy plan', () => {
    const { style: _s, ...old } = ScreenplayPlan.parse(mockPlan(fixture('genres/fantasy')));
    expect(styleForPlan(ScreenplayPlan.parse(old)).genre).toBe('high fantasy');
  });
});

describe('seedSceneLook', () => {
  const seed = { preset: 'candlelit' as const, mood: 'cold, eerie, damp stone', fog: { color: '#223344', density: 0.3 } };

  it('writes revision 1 with the seeded look and one history entry', async () => {
    const saved = await seedSceneLook(store, ID, 0, seed);
    expect(saved).not.toBeNull();
    const disk = await onDisk(0);
    expect(disk).toEqual(saved);
    expect(disk.revision).toBe(1);
    expect(disk.look).toEqual(seedToLook(seed));
    expect(disk.look.name).toBe('Candlelit · cold, eerie, damp stone');
    expect(disk.look.fog).toEqual({ color: '#223344', density: 0.3 });
    expect(disk.look.contrast).toBe(LOOK_PRESETS.candlelit.contrast);
    expect(disk.edits).toEqual([]);
    expect(disk.history).toHaveLength(1);
    expect(disk.history[0]).toMatchObject({
      prompt: SEED_PROMPT,
      plan: { scope: 'look', summary: 'Candlelit · cold, eerie, damp stone', ops: [] },
      appliedOpIds: [],
    });
  });

  it("never touches an existing edits.json (the director's grade wins), even an unreadable one", async () => {
    const mine = { ...emptySceneEdits(), look: { ...defaultLook(), name: 'Mine', exposure: 1 } };
    const put = await store.write(ID, 0, mine);
    expect(await seedSceneLook(store, ID, 0, seed)).toBeNull();
    expect(await onDisk(0)).toEqual(put);
    await writeFile(join(dataDir, ID, 'scene-1', 'edits.json'), '{ not json');
    expect(await seedSceneLook(store, ID, 1, seed)).toBeNull();
    expect(await readFile(join(dataDir, ID, 'scene-1', 'edits.json'), 'utf8')).toBe('{ not json');
  });

  it("a laptop's first PUT racing the seed is never clobbered", async () => {
    // PUT first in the lock: the seed sees the file and does nothing
    const mine = { ...emptySceneEdits(), look: { ...defaultLook(), name: 'Mine' } };
    const [put, seeded] = await Promise.all([store.write(ID, 0, mine), seedSceneLook(store, ID, 0, seed)]);
    expect(seeded).toBeNull();
    expect((await onDisk(0)).look.name).toBe('Mine');
    expect(put.revision).toBe(1);
    // seed first: the laptop's revision-0 PUT is a 409 with the seeded document, not an overwrite
    const [first, late] = await Promise.allSettled([seedSceneLook(store, ID, 1, seed), store.write(ID, 1, mine)]);
    expect(first.status).toBe('fulfilled');
    expect(late.status === 'rejected' && late.reason).toBeInstanceOf(EditsConflict);
    expect((await onDisk(1)).look.name).toBe('Candlelit · cold, eerie, damp stone');
  });
});

describe('writeSceneLook (cli look --write, chat look patches)', () => {
  it("replaces the look, keeps edits, history, lights and lens, revision + 1", async () => {
    await seedSceneLook(store, ID, 0, { preset: 'daylight-neutral', mood: '' });
    const light = { id: 'key', name: 'Key', kind: 'point' as const, position: [1, 2, -3] as [number, number, number], color: '#ffffff', intensity: 2, radius: 6, coneDeg: 45, enabled: true };
    const cur = await store.read(ID, 0);
    await store.write(ID, 0, {
      ...cur,
      look: { ...cur.look, lights: [light], dof: { enabled: true, focusDistance: 2.5, fStop: 2 } },
      edits: [{ kind: 'look', id: 'op-1', patch: { vignette: 0.5 }, enabled: true }],
    });
    const saved = await writeSceneLook(store, ID, 0, { preset: 'moonlit', mood: 'cold' }, 'look from the plan (cli look)');
    expect(saved.revision).toBe(3);
    expect(saved.look.name).toBe('Moonlit · cold');
    expect(saved.look.temperature).toBe(LOOK_PRESETS.moonlit.temperature);
    expect(saved.look.lights).toEqual([light]);
    expect(saved.look.dof).toEqual({ enabled: true, focusDistance: 2.5, fStop: 2 });
    expect(saved.edits.map((e) => e.id)).toEqual(['op-1']);
    expect(saved.history.map((h) => h.prompt)).toEqual([SEED_PROMPT, 'look from the plan (cli look)']);
    expect(await onDisk(0)).toEqual(saved);
  });
});

describe('the manifest stage seeds every new scene (MOCK pipeline)', () => {
  const projects = () =>
    new ProjectStore({
      dataDir,
      mock: true,
      keys: { anthropic: false, marble: false },
      echo: false,
      worldLibraryDir: null,
      actorsLibraryDir: null,
    });

  it('a fantasy screenplay opens graded, and a manifest rewrite leaves the grade alone', async () => {
    const s = projects();
    const { id } = await s.createProject({ screenplay: fixture('genres/fantasy') });
    await s.idle();
    const plan = ScreenplayPlan.parse(JSON.parse(await readFile(join(dataDir, id, 'plan.json'), 'utf8')));
    expect(plan.style!.genre).toMatch(/fantasy/);
    const edits = (n: number) =>
      readFile(join(dataDir, id, `scene-${n}`, 'edits.json'), 'utf8').then((t) => SceneEdits.parse(JSON.parse(t)));
    const e0 = await edits(0);
    expect(e0.revision).toBe(1);
    expect(e0.look).toEqual(seedToLook(plan.scenes[0]!.look!));
    expect(e0.look.name).toBe('Enchanted · misty, vast, soft');
    expect((await edits(1)).look.name).toMatch(/^Candlelit/);
    const log = await readFile(join(dataDir, id, 'log.txt'), 'utf8');
    expect(log).toMatch(/\[scene 0\] look seeded: Enchanted · misty, vast, soft/);
    // the director grades scene 0; a later manifest rewrite must not undo it
    const mine = await editsStoreGrade(s, id);
    await s.retry(id, 0, 'manifest');
    await s.idle();
    expect(await edits(0)).toEqual(mine);
  });
});

async function editsStoreGrade(s: ProjectStore, id: string): Promise<SceneEdits> {
  const edits = new EditsStore(() => s.dataDir);
  const cur = await edits.read(id, 0);
  return edits.write(id, 0, { ...cur, look: { ...cur.look, name: 'Director', exposure: 0.7 } });
}
