// Director's photos through the project pipeline: a character's reference photo and a scene's
// environment photo (what the project chat writes into plan.json), and the two ProjectStore
// methods the chat calls after the plan changed: regenerateWorld and rebuildActorFromPlan.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SceneEdits } from '../../shared/look.ts';
import {
  ScreenplayPlan,
  SceneManifest,
  type ActorAsset,
  type WorldAsset,
} from '../../shared/schema.ts';
import { editsStoreFor } from './edits.ts';
import {
  DRY_RUN_FILE,
  generateWorld,
  promptKey,
  RECEIPT_FILE,
  type GenerateWorldOptions,
} from './marble.ts';
import { ProjectStore, type PipelineDeps, type StoreOptions } from './project.ts';
import { encodePng } from './reprompt/png.ts';

const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);
const LIVE = { anthropic: false, marble: true, modal: true, tts: true };
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const png = (rgb: [number, number, number], width = 40, height = 60) =>
  encodePng({
    width,
    height,
    channels: 3,
    data: new Uint8Array(width * height * 3).map((_, i) => rgb[i % 3]!),
  });

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-photos-'));
});

/** Offline fakes for actors and lines (never the network, whatever keys .env.local holds). */
function fakes() {
  const built: { id: string; referenceImage?: string; detail?: string }[] = [];
  const deps: Partial<PipelineDeps> = {
    buildActor: async ({ character, sceneDir, detail }) => {
      built.push({ id: character.id, referenceImage: character.referenceImage, detail });
      await writeFile(join(sceneDir, 'humanoid.glb'), 'glb');
      const a: ActorAsset = {
        kind: 'glb-humanoid',
        characterId: character.id,
        glb: 'humanoid.glb',
        clips: { idle: 'Idle', talk: 'Talk' },
      };
      return a;
    },
    synthesizeLine: async ({ line, outDir }) => {
      await writeFile(join(outDir, `${line.id}.mp3`), 'mp3');
      return { lineId: line.id, url: `${line.id}.mp3`, durationSeconds: 1 };
    },
  };
  return { deps, built };
}

const store = (o: Partial<StoreOptions> = {}) =>
  new ProjectStore({
    dataDir,
    mock: true,
    keys: { anthropic: false, marble: false },
    echo: false,
    calibrate: false,
    worldLibraryDir: null,
    actorsLibraryDir: null,
    ...o,
  });

/**
 * A project planned like the chat leaves it: Maya's photo and a photo of scene 0's street. The
 * mock parse waits until the uploads are on disk (the project dir only exists once created).
 */
function photoParse() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const parseScreenplay: PipelineDeps['parseScreenplay'] = async (text, o) => {
    await gate;
    const { parseScreenplay: parse } = await import('./screenplay.ts');
    const plan = await parse(text, { ...o, mock: true });
    plan.characters.find((c) => c.id === 'maya')!.referenceImage = 'uploads/maya.png';
    plan.scenes[0]!.worldReference = { file: 'uploads/street.png', isPano: false };
    return plan;
  };
  return { parseScreenplay, release };
}

async function photoProject(
  make: (deps: Partial<PipelineDeps>) => ProjectStore,
  photos = { maya: png([180, 40, 40]), street: png([90, 90, 120], 64, 32) },
) {
  const { parseScreenplay, release } = photoParse();
  const s = make({ parseScreenplay });
  const { id } = await s.createProject({ screenplay: FIXTURE });
  await mkdir(join(dataDir, id, 'uploads'), { recursive: true });
  await writeFile(join(dataDir, id, 'uploads', 'maya.png'), photos.maya);
  await writeFile(join(dataDir, id, 'uploads', 'street.png'), photos.street);
  release();
  await s.idle();
  return { s, id };
}

/** What the chat's amendPlan does to plan.json (a fresh store then reads it, as after a restart). */
async function amendPlan(id: string, fn: (p: ScreenplayPlan) => void) {
  const path = join(dataDir, id, 'plan.json');
  const plan = ScreenplayPlan.parse(JSON.parse(await readFile(path, 'utf8')));
  fn(plan);
  await writeFile(path, JSON.stringify(plan));
}

const manifest = async (id: string, n: number) =>
  SceneManifest.parse(
    JSON.parse(await readFile(join(dataDir, id, `scene-${n}`, 'manifest.json'), 'utf8')),
  );

// whole projects through the store (3 scenes, worlds, ground fields): slow on a loaded machine
const STORE_TEST = { timeout: 30_000 };

describe("director's photos in a live project", STORE_TEST, () => {
  it('builds the actor from the photo and the world from the place photo — never from the libraries', async () => {
    // libraries holding a Maya and the city street: a photo must win over both
    const lib = join(dataDir, '..', `${dataDir.split('/').pop()}-lib`);
    const world = join(lib, 'worlds', 'city-street-night');
    await mkdir(world, { recursive: true });
    await writeFile(join(world, 'world_500k.spz'), 'spz');
    await writeFile(join(world, 'marble-receipt.json'), JSON.stringify({ status: 'complete' }));
    await writeFile(
      join(world, 'world-asset.json'),
      JSON.stringify({
        provider: 'marble',
        worldId: 'w-lib',
        spz: { k500: 'world_500k.spz' },
        metricScaleFactor: 1,
        groundPlaneOffset: 0,
      }),
    );
    const seq = join(lib, 'actors', 'maya', 'sequence');
    await mkdir(seq, { recursive: true });
    await writeFile(
      join(seq, 'sequence.json'),
      JSON.stringify({ frames: ['frame_000.ply'], count: 1, fps: 12, nativeHeight: 1.7 }),
    );
    await writeFile(join(seq, 'frame_000.ply'), 'ply');

    const f = fakes();
    const worlds: GenerateWorldOptions[] = [];
    const photos = { maya: png([180, 40, 40]), street: png([90, 90, 120], 64, 32) };
    const { s, id } = await photoProject(
      (deps) =>
        store({
          mock: false,
          keys: LIVE,
          worldLibraryDir: join(lib, 'worlds'),
          actorsLibraryDir: join(lib, 'actors'),
          deps: {
            ...f.deps,
            ...deps,
            // the real Marble client under MARBLE_DRY_RUN: logs the requests, hands back the mock world
            generateWorld: (o) => (worlds.push(o), generateWorld({ ...o, dryRun: true })),
          },
        }),
      photos,
    );
    const scene = (n: number) =>
      worlds.find((w) => w.outDir === join(dataDir, id, `scene-${n}`, 'world'))!;
    const st = (await s.getProject(id))!;
    const project = join(dataDir, id);

    expect(f.built.find((b) => b.id === 'maya')).toEqual({
      id: 'maya',
      referenceImage: 'uploads/maya.png',
      detail: undefined,
    });
    expect(st.scenes[0]!.stages.actors.note).not.toMatch(/library/);
    expect(
      JSON.parse(await readFile(join(project, 'actors/maya/actor.json'), 'utf8')).referenceSha,
    ).toBe(sha(photos.maya));

    const plan = ScreenplayPlan.parse(
      JSON.parse(await readFile(join(project, 'plan.json'), 'utf8')),
    );
    const prompt = plan.scenes[0]!.worldPrompt;
    expect(scene(0).imagePrompt).toEqual({
      file: join(project, 'uploads/street.png'),
      isPano: false,
      textPrompt: prompt,
    });
    expect(st.scenes[0]!.stages.world.note).toBe(
      'mock world (MARBLE_DRY_RUN: request logged, not submitted) from your photo',
    );
    const dry = JSON.parse(await readFile(join(project, 'scene-0/world', DRY_RUN_FILE), 'utf8'));
    expect(dry.upload.body).toEqual({ file_name: 'street.png', kind: 'image', extension: 'png' });
    expect(dry.generate.body.world_prompt).toEqual({
      type: 'image',
      image_prompt: { source: 'media_asset', media_asset_id: '<dry-run: not uploaded>' },
      is_pano: false,
      text_prompt: prompt,
      disable_recaption: true,
    });
    expect(dry.promptSha256).toBe(await promptKey(scene(0)));
    expect(scene(1).imagePrompt).toBeUndefined(); // scene 1 has no photo
    // the laptop shows the photo next to the world
    expect((await manifest(id, 0)).plan.worldReference).toEqual({
      file: 'uploads/street.png',
      isPano: false,
    });
  });

  it('regenerateWorld: a new photo regenerates scene 0 (old world kept, look kept, region edits dropped); the same photo never twice', async () => {
    const calls: string[] = [];
    // a fake Marble that leaves what a real one does: a complete receipt keyed by promptKey()
    const marble = async (o: GenerateWorldOptions): Promise<WorldAsset> => {
      calls.push(o.outDir);
      await mkdir(o.outDir, { recursive: true });
      await writeFile(join(o.outDir, 'world_500k.spz'), 'spz');
      const asset: WorldAsset = {
        provider: 'marble',
        worldId: `w-${calls.length}`,
        spz: { k500: 'world_500k.spz' },
        metricScaleFactor: 1,
        groundPlaneOffset: 0,
        opencvFrame: true,
      };
      await writeFile(join(o.outDir, 'world-asset.json'), JSON.stringify(asset));
      await writeFile(
        join(o.outDir, RECEIPT_FILE),
        JSON.stringify({
          status: 'complete',
          promptSha256: await promptKey(o),
          world_id: asset.worldId,
        }),
      );
      return asset;
    };
    const live = (deps: Partial<PipelineDeps> = {}) =>
      store({ mock: false, keys: LIVE, deps: { ...fakes().deps, generateWorld: marble, ...deps } });
    const { s, id } = await photoProject(live);
    expect(calls).toHaveLength(3);
    const before = await manifest(id, 0);
    // the three scenes' first worlds are generated concurrently: scene 0's is any of w-1..w-3
    const first = before.world.worldId!;
    expect(first).toMatch(/^w-[123]$/);
    await editsStoreFor(s).update(id, 0, (cur) => ({
      ...cur,
      look: { ...cur.look, exposure: 0.5 },
      edits: [
        {
          kind: 'splat-region',
          id: 'r1',
          label: 'bench',
          shape: 'sphere',
          center: [0, 0, 0],
          size: [1, 1, 1],
          yaw: 0,
          softEdge: 0.15,
          opacity: 0,
          enabled: true,
        },
      ],
    }));

    // same plan: this world was generated from this photo already
    await s.regenerateWorld(id, 0);
    await s.idle();
    expect(calls).toHaveLength(3);
    expect((await s.getProject(id))!.scenes[0]!.stages.world.note).toBe(
      'already generated from your photo: nothing to regenerate',
    );

    // a new photo of the street (the chat set it): regenerated, once, from that photo
    await writeFile(join(dataDir, id, 'uploads', 'street-2.png'), png([20, 120, 20], 64, 32));
    await amendPlan(
      id,
      (p) => (p.scenes[0]!.worldReference = { file: 'uploads/street-2.png', isPano: false }),
    );
    const s2 = live();
    const queued = await s2.regenerateWorld(id, 0);
    expect(queued.scenes[0]!.stages.world).toMatchObject({ status: 'running' });
    await s2.regenerateWorld(id, 0); // idempotent while it runs
    await s2.idle();
    expect(calls).toHaveLength(4);
    expect(calls.at(-1)).toMatch(/scene-0\/regen\/[0-9a-f]{12}\/world$/);
    const st = (await s2.getProject(id))!;
    expect(st.scenes[0]!.stages.world).toEqual({
      status: 'done',
      note: 'regenerated from your photo',
    });
    const after = await manifest(id, 0);
    expect(after.world.worldId).toBe('w-4');
    expect(after.actors).toEqual(before.actors);
    expect(
      JSON.parse(await readFile(join(dataDir, id, 'scene-0/world.prev-1/world-asset.json'), 'utf8'))
        .worldId,
    ).toBe(first);
    const edits = SceneEdits.parse(
      JSON.parse(await readFile(join(dataDir, id, 'scene-0/edits.json'), 'utf8')),
    );
    expect(edits.look.exposure).toBe(0.5);
    expect(edits.edits).toEqual([]);
    expect(edits.history.at(-1)!.plan.summary).toMatch(
      /Dropped 1 region edit \(bench\): they belonged to the old world/,
    );

    // back to the first photo: that world is swapped in again, Marble is not called
    await amendPlan(
      id,
      (p) => (p.scenes[0]!.worldReference = { file: 'uploads/street.png', isPano: false }),
    );
    const s3 = live();
    await s3.regenerateWorld(id, 0);
    await s3.idle();
    expect(calls).toHaveLength(4);
    expect((await manifest(id, 0)).world.worldId).toBe(first);
    expect((await s3.getProject(id))!.scenes[0]!.stages.world.note).toMatch(
      /already generated from your photo \(world\.prev-1\/\) is back: no Marble call/,
    );
    expect(
      JSON.parse(await readFile(join(dataDir, id, 'scene-0/world.prev-2/world-asset.json'), 'utf8'))
        .worldId,
    ).toBe('w-4');
  });
});

describe('MOCK project: the chat-called methods run offline', STORE_TEST, () => {
  it('regenerateWorld swaps a new mock world in; a scene not generated yet needs nothing', async () => {
    const { s, id } = await photoProject((deps) => store({ deps: { ...fakes().deps, ...deps } }));
    await s.regenerateWorld(id, 0);
    await s.idle();
    const st = (await s.getProject(id))!;
    expect(st.scenes[0]!.stages.world.note).toBe('regenerated from your photo');
    expect(st.scenes[0]!.stages.manifest.status).toBe('done');
    expect(existsSync(join(dataDir, id, 'scene-0/world.prev-1/world.spz'))).toBe(true);
    const world = (await manifest(id, 0)).world;
    expect(world.spz.k500).toBe('scene-0/world/world.spz');
    // the regenerated world went through the same calibrate step: its own ground height field
    expect(world.ground?.file).toMatch(/^scene-0\/world\//);
    expect(existsSync(join(dataDir, id, world.ground!.file))).toBe(true);
    await expect(s.regenerateWorld(id, 9)).rejects.toMatchObject({ status: 404 });
  });

  it('rebuildActorFromPlan sets the build aside, builds from the current character, rewrites the manifests', async () => {
    // the real (MOCK) actor module: the photo is copied and stands in as reference.png, offline
    const s = store({ deps: { ...fakes().deps, buildActor: undefined } });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    expect(
      (await manifest(id, 0)).characters.find((c) => c.id === 'maya')!.referenceImage,
    ).toBeUndefined();

    const photo = png([180, 40, 40]);
    await mkdir(join(dataDir, id, 'uploads'), { recursive: true });
    await writeFile(join(dataDir, id, 'uploads', 'maya.png'), photo);
    await amendPlan(
      id,
      (p) => (p.characters.find((c) => c.id === 'maya')!.referenceImage = 'uploads/maya.png'),
    );
    const s2 = store({ deps: { ...fakes().deps, buildActor: undefined } });
    const queued = await s2.rebuildActorFromPlan(id, 'maya');
    expect(queued.actors!.find((a) => a.characterId === 'maya')!.rebuild).toMatchObject({
      status: 'running',
      detail: 'standard',
    });
    await s2.rebuildActorFromPlan(id, 'maya'); // idempotent while it runs
    await s2.idle();

    const maya = (await s2.getProject(id))!.actors!.find((a) => a.characterId === 'maya')!;
    expect(maya.rebuild).toMatchObject({ status: 'done', detail: 'standard' });
    expect(maya.rebuild!.note).toMatch(
      /^standard ✓ in \d+s · from your photo · 3 scene manifest\(s\) updated · previous build in actors\/maya\/prev-1\/$/,
    );
    const actor = join(dataDir, id, 'actors', 'maya');
    expect(existsSync(join(actor, 'prev-1', 'actor.json'))).toBe(true); // never deleted
    expect(sha(await readFile(join(actor, 'reference-source.png')))).toBe(sha(photo));
    expect(existsSync(join(actor, 'reference.png'))).toBe(true);
    expect(JSON.parse(await readFile(join(actor, 'actor.json'), 'utf8')).referenceSha).toBe(
      sha(photo),
    );
    for (let n = 0; n < 3; n++) {
      const m = await manifest(id, n);
      expect(m.characters.find((c) => c.id === 'maya')!.referenceImage).toBe('uploads/maya.png');
      expect(m.actors.find((a) => a.characterId === 'maya')).toMatchObject({
        kind: 'glb-humanoid',
        glb: 'procedural:mannequin',
      });
    }
    // "make her taller": the same person rescaled at once, no new build, nothing set aside
    await amendPlan(id, (p) => (p.characters.find((c) => c.id === 'maya')!.heightMeters = 1.84));
    const s3 = store({ deps: { ...fakes().deps, buildActor: undefined } });
    const taller = await s3.rebuildActorFromPlan(id, 'maya');
    expect(taller.actors!.find((a) => a.characterId === 'maya')!.rebuild).toMatchObject({
      status: 'done',
      note: '1.84 m — only the height changed: rescaled, no rebuild · 3 scene manifest(s) updated',
    });
    expect(existsSync(join(actor, 'prev-2'))).toBe(false);
    expect((await manifest(id, 2)).actors.find((a) => a.characterId === 'maya')!.heightMeters).toBe(
      1.84,
    );
    expect(JSON.parse(await readFile(join(actor, 'actor.json'), 'utf8')).referenceSha).toBe(
      sha(photo),
    );
    await expect(s2.rebuildActorFromPlan(id, 'nobody')).rejects.toMatchObject({ status: 404 });
  });
});
