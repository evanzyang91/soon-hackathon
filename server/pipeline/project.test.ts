import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectStatus,
  SceneManifest,
  type ActorAsset,
  type LineAudio,
} from '../../shared/schema.ts';
import { ProjectStore, toProjectUrl, type PipelineDeps, type StoreOptions } from './project.ts';

const FIXTURE = readFileSync(
  new URL('../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-projects-'));
});

/** Fake WP D modules that write real files and count calls. */
function fakeActors(opts: { failLine?: string } = {}) {
  const actorCalls: string[] = [];
  const ttsCalls: string[] = [];
  let failLine = opts.failLine;
  const deps: Partial<PipelineDeps> = {
    buildActor: async ({ character, sceneDir }) => {
      actorCalls.push(character.id);
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
      ttsCalls.push(line.id);
      if (line.id === failLine) throw new Error('tts provider timeout');
      await writeFile(join(outDir, `${line.id}.mp3`), 'mp3');
      const a: LineAudio = { lineId: line.id, url: `${line.id}.mp3`, durationSeconds: 1.5 };
      return a;
    },
  };
  return { deps, actorCalls, ttsCalls, clearFailure: () => (failLine = undefined) };
}

const store = (o: Partial<StoreOptions> = {}) =>
  new ProjectStore({
    dataDir,
    mock: true,
    keys: { anthropic: false, marble: false },
    echo: false,
    // never the developer's real data/marble or data/actors-library
    worldLibraryDir: null,
    actorsLibraryDir: null,
    ...o,
  });

const readManifest = async (id: string, n: number) =>
  SceneManifest.parse(
    JSON.parse(await readFile(join(dataDir, id, `scene-${n}`, 'manifest.json'), 'utf8')),
  );

describe('project pipeline (mock)', () => {
  it('runs screenplay → 3 manifests that validate, sharing one actor per character', async () => {
    const f = fakeActors();
    const s = store({ deps: f.deps });
    const created = await s.createProject({ screenplay: FIXTURE });
    expect(created.parse.status).toMatch(/pending|running/);
    expect(created.title).toBe('The Last Bus');
    await s.idle();

    const status = ProjectStatus.parse(
      JSON.parse(await readFile(join(dataDir, created.id, 'project.json'), 'utf8')),
    );
    expect(status.parse.status).toBe('done');
    expect(status.scenes).toHaveLength(3);
    for (const job of status.scenes) {
      expect(Object.values(job.stages).map((x) => x.status)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'done',
      ]);
      expect(job.manifestUrl).toBe(`/projects/${created.id}/scene-${job.sceneIndex}/manifest.json`);
    }

    expect(f.actorCalls.sort()).toEqual(['maya', 'theo']); // built once, used by 3 scenes
    expect(f.ttsCalls).toHaveLength(12);

    for (let n = 0; n < 3; n++) {
      const m = await readManifest(created.id, n);
      expect(m.projectId).toBe(created.id);
      expect(m.plan.index).toBe(n);
      expect(m.world.spz.k500).toBe(`scene-${n}/world/world.spz`);
      expect(m.startCamera).toEqual({
        position: [0, 1.6, 0],
        quaternion: [0, 0, 0, 1],
        fovDeg: 50,
      });
      expect(m.actors.map((a) => a.kind === 'glb-humanoid' && a.glb).sort()).toEqual([
        'actors/maya/humanoid.glb',
        'actors/theo/humanoid.glb',
      ]);
      expect(m.audio.map((a) => a.lineId)).toEqual(m.plan.dialogue.map((d) => d.id));
      // every URL resolves to a real file under the project root
      for (const url of [m.world.spz.k500, m.world.thumbnail!, ...m.audio.map((a) => a.url)]) {
        expect(existsSync(join(dataDir, created.id, url)), url).toBe(true);
      }
    }
    expect(await readFile(join(dataDir, created.id, 'log.txt'), 'utf8')).toMatch(
      /manifest written/,
    );
    expect(await s.listProjects()).toHaveLength(1);
  });

  it('a failed tts line marks the stage failed, still writes the manifest, and retry fills the gap', async () => {
    const f = fakeActors({ failLine: 's2-l3' });
    const s = store({ deps: f.deps });
    const { id } = await s.createProject({ title: 'Retry me', screenplay: FIXTURE });
    await s.idle();
    let st = (await s.getProject(id))!;
    expect(st.title).toBe('Retry me');
    expect(st.scenes[1]!.stages.tts).toMatchObject({ status: 'failed' });
    expect(st.scenes[1]!.stages.tts.note).toMatch(/s2-l3: tts provider timeout/);
    expect(st.scenes[1]!.stages.manifest.status).toBe('done');
    expect((await readManifest(id, 1)).audio).toHaveLength(3);

    f.clearFailure();
    f.ttsCalls.length = 0;
    st = await s.retry(id, 1, 'tts');
    expect(st.scenes[1]!.stages.tts.status).toBe('pending');
    await s.idle();
    st = (await s.getProject(id))!;
    expect(st.scenes[1]!.stages.tts.status).toBe('done');
    expect(f.ttsCalls).toEqual(['s2-l3']); // only the missing line
    expect((await readManifest(id, 1)).audio.map((a) => a.lineId)).toEqual([
      's2-l1',
      's2-l2',
      's2-l3',
      's2-l4',
    ]);
  });

  it('a failed world skips the manifest; retrying the world produces it', async () => {
    const f = fakeActors();
    let failScene: number | undefined = 2;
    const s = store({
      deps: {
        ...f.deps,
        generateWorld: async (o) => {
          if (o.outDir.includes(`scene-${failScene}`)) throw new Error('Marble HTTP 503');
          const { generateWorld } = await import('./marble.ts');
          return generateWorld(o);
        },
      },
    });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    let st = (await s.getProject(id))!;
    expect(st.scenes[2]!.stages.world).toEqual({ status: 'failed', note: 'Marble HTTP 503' });
    expect(st.scenes[2]!.stages.manifest.status).toBe('skipped');
    expect(existsSync(join(dataDir, id, 'scene-2', 'manifest.json'))).toBe(false);
    expect(st.scenes[0]!.stages.manifest.status).toBe('done');

    failScene = undefined;
    await s.retry(id, 2, 'world');
    await s.idle();
    st = (await s.getProject(id))!;
    expect(st.scenes[2]!.stages.world.status).toBe('done');
    expect(st.scenes[2]!.stages.manifest.status).toBe('done');
    await readManifest(id, 2);
  });

  it('resumes unfinished work from disk after a restart without redoing finished stages', async () => {
    const hang = () => new Promise<never>(() => {});
    const a = store({ deps: { generateWorld: hang, buildActor: hang, synthesizeLine: hang } });
    const { id } = await a.createProject({ screenplay: FIXTURE });
    // wait until the first process has parsed and started every stage, then "crash" it
    for (let i = 0; i < 200; i++) {
      const st = (await a.getProject(id))!;
      if (st.scenes.length === 3 && st.scenes.every((j) => j.stages.world.status === 'running'))
        break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const onDisk = ProjectStatus.parse(
      JSON.parse(await readFile(join(dataDir, id, 'project.json'), 'utf8')),
    );
    expect(onDisk.parse.status).toBe('done');

    const f = fakeActors();
    let parses = 0;
    const b = store({
      deps: {
        ...f.deps,
        parseScreenplay: async () => {
          parses++;
          throw new Error('should not re-parse');
        },
      },
    });
    expect(await b.resumeAll()).toEqual([id]);
    await b.idle();
    const st = (await b.getProject(id))!;
    expect(parses).toBe(0);
    expect(st.scenes.every((j) => j.stages.manifest.status === 'done')).toBe(true);
    for (let n = 0; n < 3; n++) await readManifest(id, n);
    // a second resume finds nothing to do
    expect(await b.resumeAll()).toEqual([]);
  });

  it('does not resume live projects while the server runs in MOCK mode', async () => {
    const hang = () => new Promise<never>(() => {});
    const live = store({ mock: false, deps: { parseScreenplay: hang } });
    const { id } = await live.createProject({ screenplay: FIXTURE });
    const mock = store({ mock: true });
    expect(await mock.resumeAll()).toEqual([]);
    expect((await mock.getProject(id))!.parse.status).toMatch(/pending|running/);
  });

  it('parse failures are reported and retryable; done parses are not', async () => {
    let fail = true;
    const f = fakeActors();
    const s = store({
      deps: {
        ...f.deps,
        parseScreenplay: async (text, o) => {
          if (fail) throw new Error('Claude 529 overloaded');
          const { parseScreenplay } = await import('./screenplay.ts');
          return parseScreenplay(text, o);
        },
      },
    });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    expect((await s.getProject(id))!.parse).toEqual({
      status: 'failed',
      note: 'Claude 529 overloaded',
    });
    fail = false;
    await s.retry(id, 0, 'parse');
    await s.idle();
    expect((await s.getProject(id))!.scenes).toHaveLength(3);
    await expect(s.retry(id, 0, 'parse')).rejects.toMatchObject({ status: 409 });
    await expect(s.retry(id, 7, 'world')).rejects.toMatchObject({ status: 404 });
    await expect(s.retry('nope-123', 0, 'world')).rejects.toMatchObject({ status: 404 });
  });

  it('live: a fallback actor cached before a restart is rebuilt when Modal keys are set', async () => {
    const hang = () => new Promise<never>(() => {});
    const mannequin = (characterId: string, fallback: boolean): ActorAsset => ({
      kind: 'glb-humanoid',
      characterId,
      glb: 'procedural:mannequin',
      clips: { idle: 'Idle', talk: 'Talk' },
      ...(fallback ? { fallback: true } : {}),
    });
    const liveKeys = { anthropic: false, marble: false, modal: true, tts: true };
    // process A: maya falls back (Modal billing), theo never finishes; then A "crashes"
    const a = store({
      mock: false,
      keys: liveKeys,
      deps: {
        buildActor: async ({ character }) =>
          character.id === 'maya' ? mannequin('maya', true) : hang(),
        synthesizeLine: hang,
      },
    });
    const { id } = await a.createProject({ screenplay: FIXTURE });
    const mayaJson = join(dataDir, id, 'actors', 'maya', 'actor.json');
    for (let i = 0; i < 400 && !existsSync(mayaJson); i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(JSON.parse(await readFile(mayaJson, 'utf8')).fallback).toBe(true);

    // process B resumes with Modal working: maya is rebuilt instead of reusing the fallback
    const f = fakeActors();
    const b = store({ mock: false, keys: liveKeys, deps: f.deps });
    expect(await b.resumeAll()).toEqual([id]);
    await b.idle();
    expect(f.actorCalls.sort()).toEqual(['maya', 'theo']);
    const m = await readManifest(id, 0);
    expect(m.actors.map((x) => x.fallback ?? false)).toEqual([false, false]);
  });

  it('live: retrying tts re-synthesizes fallback beeps too; MOCK projects keep them', async () => {
    const run = async (mock: boolean) => {
      const calls: string[] = [];
      let upgraded = false;
      const deps: Partial<PipelineDeps> = {
        ...fakeActors().deps,
        synthesizeLine: async ({ line, outDir }) => {
          calls.push(line.id);
          if (!upgraded && line.id === 's1-l2') throw new Error('tts provider timeout');
          await writeFile(join(outDir, `${line.id}.wav`), 'wav');
          const a: LineAudio = { lineId: line.id, url: `${line.id}.wav`, durationSeconds: 1 };
          return upgraded ? a : { ...a, fallback: true };
        },
      };
      const s = store({ mock, keys: { anthropic: false, marble: false, tts: true }, deps });
      const { id } = await s.createProject({ screenplay: FIXTURE });
      await s.idle();
      const st = (await s.getProject(id))!;
      expect(st.scenes[0]!.stages.tts.status).toBe('failed');
      upgraded = true;
      calls.length = 0;
      await s.retry(id, 0, 'tts');
      await s.idle();
      const m = await readManifest(id, 0);
      return { calls: calls.sort(), fallbacks: m.audio.filter((x) => x.fallback).length };
    };
    expect(await run(false)).toEqual({ calls: ['s1-l1', 's1-l2', 's1-l3', 's1-l4'], fallbacks: 0 });
    expect(await run(true)).toEqual({ calls: ['s1-l2'], fallbacks: 3 });
  });

  it('live: a matching world-library world is reused instead of calling Marble; MOCK ignores it', async () => {
    const library = join(dataDir, '..', `${dataDir.split('/').pop()}-library`);
    const lib = join(library, 'city-street-night');
    await mkdir(lib, { recursive: true });
    for (const f of ['world_500k.spz', 'thumbnail.webp']) await writeFile(join(lib, f), f);
    await writeFile(join(lib, 'marble-receipt.json'), JSON.stringify({ status: 'complete' }));
    await writeFile(
      join(lib, 'world-asset.json'),
      JSON.stringify({
        provider: 'marble',
        worldId: 'w-lib',
        spz: { k500: 'world_500k.spz' },
        thumbnail: 'thumbnail.webp',
        metricScaleFactor: 2,
        groundPlaneOffset: 1,
      }),
    );
    const run = async (mock: boolean) => {
      const prompts: string[] = [];
      const s = store({
        mock,
        worldLibraryDir: library,
        deps: {
          ...fakeActors().deps,
          generateWorld: async (o) => {
            prompts.push(o.prompt);
            const { generateWorld } = await import('./marble.ts');
            return generateWorld({ ...o, mock: true });
          },
        },
      });
      const { id } = await s.createProject({ screenplay: FIXTURE });
      await s.idle();
      return { id, st: (await s.getProject(id))!, worldCalls: prompts.length };
    };

    const live = await run(false);
    expect(live.worldCalls).toBe(2); // scenes 1 and 2 only
    const job = live.st.scenes[0]!;
    expect(job.stages.world).toEqual({ status: 'done', note: 'reused library world w-lib' });
    expect(job.stages.manifest.status).toBe('done');
    expect(job.thumbnailUrl).toBe(`/projects/${live.id}/scene-0/world/thumbnail.webp`);
    const m = await readManifest(live.id, 0);
    expect(m.world).toMatchObject({ provider: 'marble', worldId: 'w-lib' });
    // project-root-relative, and the file is really there (what the laptop loads)
    expect(m.world.spz.k500).toBe('scene-0/world/world_500k.spz');
    expect(existsSync(join(dataDir, live.id, m.world.spz.k500))).toBe(true);
    expect(existsSync(join(dataDir, live.id, 'scene-0/world/marble-receipt.json'))).toBe(true);
    expect((await readManifest(live.id, 1)).world.provider).toBe('mock');

    const mock = await run(true);
    expect(mock.worldCalls).toBe(3);
    expect((await readManifest(mock.id, 0)).world.provider).toBe('mock');
  });

  it('live: a matching actors-library avatar is reused instead of building one; MOCK ignores it', async () => {
    const library = join(dataDir, '..', `${dataDir.split('/').pop()}-actors`);
    const seqDir = join(library, 'maya', 'sequence');
    await mkdir(seqDir, { recursive: true });
    const frames = ['frame_000.ply', 'frame_001.ply'];
    await writeFile(
      join(seqDir, 'sequence.json'),
      JSON.stringify({ frames, count: 2, fps: 12, nativeHeight: 1.812259935736556 }),
    );
    for (const f of frames) await writeFile(join(seqDir, f), 'ply');
    const run = async (mock: boolean) => {
      const f = fakeActors();
      const s = store({ mock, actorsLibraryDir: library, deps: f.deps });
      const { id } = await s.createProject({ screenplay: FIXTURE });
      await s.idle();
      return { id, st: (await s.getProject(id))!, built: f.actorCalls };
    };
    const live = await run(false);
    expect(live.built).toEqual(['theo']); // maya came from the library
    expect(live.st.scenes[0]!.stages.actors.note).toContain('reused library actor: maya');
    const m = await readManifest(live.id, 0);
    const maya = m.actors.find((a) => a.characterId === 'maya')!;
    expect(maya).toEqual({
      kind: 'splat-sequence',
      characterId: 'maya',
      sequenceDir: 'actors/maya/sequence',
      fps: 12,
      nativeHeight: 1.8123,
      heightMeters: 1.7,
    });
    expect(existsSync(join(dataDir, live.id, 'actors/maya/sequence/frame_001.ply'))).toBe(true);
    expect(m.actors.find((a) => a.characterId === 'theo')!.kind).toBe('glb-humanoid');

    const mock = await run(true);
    expect(mock.built.sort()).toEqual(['maya', 'theo']);
  });

  it('live: a new Marble world is scale-calibrated after download, written into its asset and manifest', async () => {
    const run = async (calibrate: boolean) => {
      const calls: { dir: string; interior?: boolean; vision?: boolean }[] = [];
      const s = store({
        mock: false,
        calibrate,
        keys: { anthropic: true, marble: true, tts: true },
        deps: {
          ...fakeActors().deps,
          parseScreenplay: async (text, o) => {
            const { parseScreenplay } = await import('./screenplay.ts');
            return parseScreenplay(text, { ...o, mock: true });
          },
          synthesizeLine: async ({ line, outDir }) => {
            await writeFile(join(outDir, `${line.id}.mp3`), 'mp3');
            return { lineId: line.id, url: `${line.id}.mp3`, durationSeconds: 1 };
          },
          generateWorld: async ({ outDir }) => {
            await mkdir(outDir, { recursive: true });
            await writeFile(join(outDir, 'world_500k.spz'), 'spz');
            const asset = {
              provider: 'marble' as const,
              worldId: `w-${outDir.split('/').at(-2)}`,
              spz: { k500: 'world_500k.spz' },
              metricScaleFactor: 2,
              groundPlaneOffset: 1.5,
              opencvFrame: true,
            };
            await writeFile(join(outDir, 'world-asset.json'), JSON.stringify(asset));
            return asset;
          },
          calibrateWorld: async (dir, o) => {
            calls.push({ dir, interior: o.interior, vision: o.vision });
            const { readWorldAsset } = await import('./calibrate.ts');
            const a = await readWorldAsset(dir);
            return {
              schema: 'previz.scale-calibration/1',
              worldId: a.worldId,
              createdAt: new Date().toISOString(),
              metricScaleFactor: 2,
              groundPlaneOffset: 1.5,
              interior: !!o.interior,
              geometry: null,
              vision: null,
              decision: { factor: 0.87, candidate: 0.87, applied: true, confidence: 'medium', method: 'vision', reason: 'test' },
              calibration: { factor: 0.87, method: 'vision', confidence: 'medium', evidence: 'door 2.04 m · test' },
              costUsd: 0.1,
            };
          },
        },
      });
      const { id } = await s.createProject({ screenplay: FIXTURE });
      await s.idle();
      return { id, calls, st: (await s.getProject(id))! };
    };

    const on = await run(true);
    expect(on.calls).toHaveLength(3);
    expect(on.calls.every((c) => c.vision === true)).toBe(true);
    expect(on.st.scenes[0]!.stages.world.note).toMatch(/scale ×0\.87 \(medium\)$/);
    const m = await readManifest(on.id, 0);
    expect(m.world.scaleCalibration).toEqual({
      factor: 0.87,
      method: 'vision',
      confidence: 'medium',
      evidence: 'door 2.04 m · test',
    });
    expect(existsSync(join(dataDir, on.id, 'scene-0/world/scale-calibration.json'))).toBe(true);

    const off = await run(false);
    expect(off.calls).toHaveLength(0);
    expect((await readManifest(off.id, 0)).world.scaleCalibration).toBeUndefined();
  });

  it('end to end with the real (mock-mode) WP D modules and Marble mock', async () => {
    const s = store();
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    const st = (await s.getProject(id))!;
    expect(st.scenes).toHaveLength(3);
    for (let n = 0; n < 3; n++) {
      expect(st.scenes[n]!.stages.world.status).toBe('done');
      expect(st.scenes[n]!.stages.manifest.status).toBe('done');
      const m = await readManifest(id, n);
      expect(m.plan.dialogue.length).toBeGreaterThan(0);
      // the laptop's scene list shows the heading and the world thumbnail
      expect(st.scenes[n]!.heading).toBe(m.plan.heading);
      expect(st.scenes[n]!.thumbnailUrl).toBe(`/projects/${id}/scene-${n}/world/thumbnail.png`);
      expect(existsSync(join(dataDir, id, `scene-${n}`, 'world', 'thumbnail.png'))).toBe(true);
    }
    expect(st.scenes[0]!.heading).toBe('EXT. CITY STREET - NIGHT');
  });
});

describe('actor rebuilds (High detail)', () => {
  const liveKeys = { anthropic: false, marble: false, modal: true, tts: true };
  /** Live WP D fake: standard builds and high rebuilds write a real sequence dir. */
  function liveActors(o: { failHigh?: string; hangHigh?: boolean } = {}) {
    const calls: string[] = [];
    const deps: Partial<PipelineDeps> = {
      ...fakeActors().deps,
      buildActor: async ({ character, sceneDir, detail }) => {
        calls.push(`${character.id}:${detail ?? 'standard'}`);
        if (detail === 'high' && o.failHigh) throw new Error(o.failHigh);
        if (detail === 'high' && o.hangHigh) return new Promise<never>(() => {});
        await mkdir(join(sceneDir, 'sequence'), { recursive: true });
        // what the worker writes: a playable frame and `detail` in sequence.json
        const h = detail === 'high' ? 1.8 : 1.7;
        await writeFile(
          join(sceneDir, 'sequence', 'sequence.json'),
          JSON.stringify({ frames: ['frame_000.ply'], count: 1, fps: 12, nativeHeight: h, ...(detail ? { detail } : {}) }),
        );
        await writeFile(join(sceneDir, 'sequence', 'frame_000.ply'), `ply-${detail ?? 'standard'}`);
        const a: ActorAsset = {
          kind: 'splat-sequence',
          characterId: character.id,
          sequenceDir: 'sequence',
          fps: 12,
          nativeHeight: detail === 'high' ? 1.8 : 1.7,
          heightMeters: 1.7,
          ...(detail === 'high' ? { detail: 'high' as const } : {}),
        };
        return a;
      },
    };
    return { deps, calls };
  }
  const live = (o: Partial<StoreOptions> = {}) => store({ mock: false, keys: liveKeys, ...o });
  const maya = (m: SceneManifest) => m.actors.find((a) => a.characterId === 'maya')!;
  const mayaStatus = (st: ProjectStatus | undefined) => st!.actors!.find((a) => a.characterId === 'maya')!;

  it('rebuilds one character in the background and points every manifest at the new build', async () => {
    const f = liveActors();
    const s = live({ deps: f.deps });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    expect((await s.getProject(id))!.actors!.sort((a, b) => a.characterId.localeCompare(b.characterId))).toEqual([
      { characterId: 'maya', name: 'MAYA', detail: 'standard', kind: 'splat-sequence' },
      { characterId: 'theo', name: 'THEO', detail: 'standard', kind: 'splat-sequence' },
    ]);
    const before = await readManifest(id, 0);

    const queued = await s.rebuildActor(id, 'maya', 'high');
    const entry = queued.actors!.find((a) => a.characterId === 'maya')!;
    expect(entry.detail).toBe('standard'); // the standard build stays until the new one lands
    expect(entry.rebuild).toMatchObject({ detail: 'high', status: 'running' });
    expect(Date.parse(entry.rebuild!.startedAt!)).toBeGreaterThan(0);
    await s.idle();

    const st = (await s.getProject(id))!;
    const done = st.actors!.find((a) => a.characterId === 'maya')!;
    expect(done).toMatchObject({ detail: 'high', kind: 'splat-sequence', rebuild: { detail: 'high', status: 'done' } });
    expect(done.rebuild!.note).toMatch(/^high detail ✓ in \d+s · 3 scene manifest\(s\) updated$/);
    for (let n = 0; n < 3; n++) {
      const m = await readManifest(id, n);
      expect(maya(m)).toMatchObject({ kind: 'splat-sequence', detail: 'high', sequenceDir: 'actors/maya/high/sequence' });
      expect(m.actors.find((a) => a.characterId === 'theo')).toEqual(before.actors.find((a) => a.characterId === 'theo'));
    }
    // the standard build is still on disk, and the cached actor now points at the high one
    expect(existsSync(join(dataDir, id, 'actors/maya/sequence/sequence.json'))).toBe(true);
    expect(JSON.parse(await readFile(join(dataDir, id, 'actors/maya/actor.json'), 'utf8')).detail).toBe('high');
    expect(f.calls.filter((c) => c.endsWith(':high'))).toEqual(['maya:high']);

    // idempotent: again reuses the finished build; standard switches back without a new build
    await s.rebuildActor(id, 'maya', 'standard');
    await s.idle();
    expect(maya(await readManifest(id, 2))).toMatchObject({ sequenceDir: 'actors/maya/sequence' });
    expect('detail' in maya(await readManifest(id, 2))).toBe(false);
    expect(mayaStatus(await s.getProject(id))).toMatchObject({ detail: 'standard', rebuild: { detail: 'standard', status: 'done' } });
  });

  it('a failed rebuild leaves the standard build and manifests untouched and reports why', async () => {
    const f = liveActors({ failHigh: 'CUDA out of memory' });
    const s = live({ deps: f.deps });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    const before = await readFile(join(dataDir, id, 'scene-0', 'manifest.json'), 'utf8');
    await s.rebuildActor(id, 'maya', 'high');
    await s.idle();
    const entry = (await s.getProject(id))!.actors!.find((a) => a.characterId === 'maya')!;
    expect(entry).toMatchObject({ detail: 'standard', rebuild: { status: 'failed', note: 'CUDA out of memory' } });
    expect(await readFile(join(dataDir, id, 'scene-0', 'manifest.json'), 'utf8')).toBe(before);
    expect(await readFile(join(dataDir, id, 'log.txt'), 'utf8')).toMatch(/FAILED CUDA out of memory \(the current build stays in use\)/);
  });

  it('refuses MOCK projects and missing Modal keys; a running rebuild is not queued twice', async () => {
    const mock = store({ deps: fakeActors().deps });
    const p = await mock.createProject({ screenplay: FIXTURE });
    await mock.idle();
    await expect(mock.rebuildActor(p.id, 'maya', 'high')).rejects.toMatchObject({ status: 409 });
    const noModal = live({ keys: { ...liveKeys, modal: false }, deps: liveActors().deps });
    const q = await noModal.createProject({ screenplay: FIXTURE });
    await noModal.idle();
    await expect(noModal.rebuildActor(q.id, 'maya', 'high')).rejects.toThrow(/Modal keys/);
    await expect(noModal.rebuildActor(q.id, 'nobody', 'high')).rejects.toMatchObject({ status: 404 });

    const f = liveActors({ hangHigh: true });
    const s = live({ deps: f.deps });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    void s.rebuildActor(id, 'maya', 'high');
    for (let i = 0; i < 200 && !f.calls.includes('maya:high'); i++) await new Promise((r) => setTimeout(r, 5));
    const again = await s.rebuildActor(id, 'maya', 'high');
    expect(mayaStatus(again).rebuild!.status).toBe('running');
    expect(f.calls.filter((c) => c === 'maya:high')).toHaveLength(1);

    // a restart resumes the interrupted rebuild (the worker recovers its receipt)
    const g = liveActors();
    const resumed = live({ deps: g.deps });
    expect(await resumed.resumeAll()).toEqual([id]);
    await resumed.idle();
    expect(g.calls).toEqual(['maya:high']);
    expect(maya(await readManifest(id, 1))).toMatchObject({ detail: 'high' });
  });

  it('refreshes an existing actors-library copy and later projects reuse it as high detail', async () => {
    const library = join(dataDir, '..', `${dataDir.split('/').pop()}-lib-actors`);
    const seqDir = join(library, 'maya', 'sequence');
    await mkdir(seqDir, { recursive: true });
    await writeFile(join(seqDir, 'sequence.json'), JSON.stringify({ frames: ['frame_000.ply'], count: 1, fps: 12, nativeHeight: 1.7 }));
    await writeFile(join(seqDir, 'frame_000.ply'), 'ply');
    const f = liveActors();
    const s = live({ deps: f.deps, actorsLibraryDir: library });
    const { id } = await s.createProject({ screenplay: FIXTURE });
    await s.idle();
    expect(f.calls).toEqual(['theo:standard']); // maya came from the library
    await s.rebuildActor(id, 'maya', 'high');
    await s.idle();
    expect(mayaStatus(await s.getProject(id)).rebuild!.note).toMatch(/library copy refreshed/);
    expect(await readFile(join(library, 'maya/sequence/frame_000.ply'), 'utf8')).toBe('ply-high');
    expect(await readFile(join(library, 'maya/sequence.previous/frame_000.ply'), 'utf8')).toBe('ply');
    expect(f.calls).toEqual(['theo:standard', 'maya:high']);

    const next = live({ deps: liveActors().deps, actorsLibraryDir: library });
    const p2 = await next.createProject({ screenplay: FIXTURE });
    await next.idle();
    expect(maya(await readManifest(p2.id, 0))).toMatchObject({ detail: 'high', nativeHeight: 1.8 });
    expect(mayaStatus(await next.getProject(p2.id))).toMatchObject({ characterId: 'maya', detail: 'high' });
  });
});

describe('toProjectUrl', () => {
  it('normalizes paths from WP D modules to project-relative URLs', async () => {
    const project = join(dataDir, 'p1');
    const base = join(project, 'actors', 'maya');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'a.glb'), 'x');
    await mkdir(join(project, 'shared'), { recursive: true });
    await writeFile(join(project, 'shared', 'b.glb'), 'x');
    expect(await toProjectUrl('a.glb', base, project)).toBe('actors/maya/a.glb');
    expect(await toProjectUrl(join(base, 'a.glb'), base, project)).toBe('actors/maya/a.glb');
    expect(await toProjectUrl('shared/b.glb', base, project)).toBe('shared/b.glb');
    expect(await toProjectUrl('/assets/humanoid.glb', base, project)).toBe('/assets/humanoid.glb');
    expect(await toProjectUrl('https://cdn.example/x.glb', base, project)).toBe(
      'https://cdn.example/x.glb',
    );
    expect(await toProjectUrl('later.ply', base, project)).toBe('actors/maya/later.ply');
  });
});
