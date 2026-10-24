// The project chat on a real MOCK ProjectStore over HTTP: a draft is planned and waits, the mock
// planner's amendments land in plan.json, generate runs the pipeline with them, and on the
// generated project each change costs what apply.ts says (a re-voice touches only the changed
// line, a new world waits for confirm, a re-plan keeps ids, photos and scene folders).
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../../shared/api.ts';
import { Attachment, ProjectChat, type ChatAction } from '../../../shared/chat.ts';
import { ProjectStatus, SceneManifest, ScreenplayPlan } from '../../../shared/schema.ts';
import { ProjectStore } from '../project.ts';
import { encodePng } from '../reprompt/png.ts';
import { createPipelineHandler } from '../routes.ts';
import type { ChatDraft } from './draft.ts';
import type { ChatResponse } from '../../../shared/chat.ts';

const FIXTURE = readFileSync(
  new URL('../../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);

let dataDir: string;
let store: ProjectStore;
let base: string;
let server: Server;
/** The next answer of the fake Claude (the replan step); the mock planner answers otherwise. */
let claudeDraft: ChatDraft | undefined;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'previz-chat-'));
  store = new ProjectStore({
    dataDir,
    mock: true,
    keys: { anthropic: false, marble: false },
    echo: false,
    worldLibraryDir: null,
    actorsLibraryDir: null,
  });
  const call = async () =>
    ({
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200 },
      content: [{ type: 'text', text: JSON.stringify(claudeDraft) }],
    }) as unknown as Anthropic.Beta.BetaMessage;
  const mockHandler = createPipelineHandler(() => store, {
    chat: { planner: { mock: true }, watchIntervalMs: 20 },
  });
  const claudeHandler = createPipelineHandler(() => store, {
    chat: { planner: { mock: false, call }, watchIntervalMs: 20 },
  });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const handle = claudeDraft ? claudeHandler : mockHandler;
    if (await handle(req, res, url)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await store.idle();
  await new Promise((r) => server.close(r));
});

const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const say = async (id: string, text: string, attachments?: { id: string; hint?: string }[]) => {
  const res = await post(api.chat(id), { text, ...(attachments ? { attachments } : {}) });
  expect(res.status).toBe(200);
  const body = (await res.json()) as ChatResponse;
  return { ...body, answer: ProjectChat.parse(body.chat).messages.at(-1)! };
};
const planOf = async (id: string) =>
  ScreenplayPlan.parse(JSON.parse(await readFile(join(dataDir, id, 'plan.json'), 'utf8')));
const statusOf = async (id: string) =>
  ProjectStatus.parse(await (await fetch(base + api.project(id))).json());
const manifest = async (id: string, n: number) =>
  SceneManifest.parse(
    JSON.parse(await readFile(join(dataDir, id, `scene-${n}`, 'manifest.json'), 'utf8')),
  );
const types = (actions: ChatAction[] | undefined) =>
  (actions ?? []).map((a) => `${a.type}:${a.status}`);

describe('project chat on a MOCK project', () => {
  let id: string;
  let photo: Attachment;

  it('a draft is parsed only, and its thread opens with the screenplay and the plan card', async () => {
    const res = await post(api.projects, { screenplay: FIXTURE, draft: true });
    expect(res.status).toBe(202);
    id = ProjectStatus.parse(await res.json()).id;
    await store.idle();
    const st = await statusOf(id);
    expect(st.draft).toBe(true);
    expect(st.parse.status).toBe('done');
    expect(
      st.scenes.map((j) => [j.stages.world.status, j.stages.world.note, j.manifestUrl]),
    ).toEqual([0, 1, 2].map(() => ['pending', 'waiting for generate', undefined]));
    const chat = ProjectChat.parse(await (await fetch(base + api.chat(id))).json());
    expect(chat.messages.map((m) => [m.role, !!m.planCard])).toEqual([
      ['user', false],
      ['assistant', true],
    ]);
    expect(chat.messages[0]!.text).toBe(FIXTURE);
    expect(chat.messages[1]!.text).toMatch(
      /^Planned 3 scenes and 2 characters: Theo and Maya\. 1 EXT\. CITY STREET - NIGHT \(4 lines\)/,
    );
    expect(st.chatRevision).toBe(chat.revision);
  });

  it('uploads are content-addressed and served under the project', async () => {
    const png = encodePng({ width: 4, height: 6, channels: 3, data: new Uint8Array(72).fill(200) });
    const up = (name: string) =>
      fetch(`${base}${api.uploads(id)}?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(png),
      });
    const first = await up('maya.png');
    expect(first.status).toBe(201);
    photo = Attachment.parse(await first.json());
    expect(photo).toMatchObject({
      kind: 'image',
      file: `uploads/${photo.id}.png`,
      name: 'maya.png',
      width: 4,
      height: 6,
      bytes: png.length,
    });
    expect(photo.id).toMatch(/^[0-9a-f]{16}$/);
    expect(await (await up('again.png')).json()).toEqual(photo); // same bytes → the same attachment
    expect((await readFile(join(dataDir, id, photo.file))).equals(png)).toBe(true);
  });

  it('draft: amendments and photos are applied at once and nothing is scheduled', async () => {
    const taller = await say(id, 'make Theo taller');
    expect(taller.answer.text).toBe('Theo is now 1.90 m.');
    expect(taller.answer.source).toBe('mock');
    expect(taller.answer.actions).toEqual([
      expect.objectContaining({
        type: 'plan-patch',
        target: 'character:theo',
        field: 'heightMeters',
        after: 1.9,
        status: 'applied',
      }),
    ]);
    expect((await planOf(id)).characters.find((c) => c.id === 'theo')!.heightMeters).toBe(1.9);

    const maya = await say(id, 'this is Maya', [{ id: photo.id }]);
    expect(types(maya.answer.actions)).toEqual(['character-reference:applied']);
    expect((await planOf(id)).characters.find((c) => c.id === 'maya')!.referenceImage).toBe(
      photo.file,
    );
    expect(maya.status.draft).toBe(true);
    expect(maya.status.scenes.every((j) => j.stages.world.status === 'pending')).toBe(true);

    // the laptop sends photos as their own message: no text, the UI's hint (0-based scene index)
    const street = encodePng({
      width: 8,
      height: 4,
      channels: 3,
      data: new Uint8Array(96).fill(40),
    });
    const place = Attachment.parse(
      await (
        await fetch(`${base}${api.uploads(id)}?name=street.png`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array(street),
        })
      ).json(),
    );
    const placed = await say(id, '', [{ id: place.id, hint: 'scene:0' }]);
    expect(placed.answer.actions).toEqual([
      expect.objectContaining({
        type: 'world-reference',
        sceneIndex: 0,
        isPano: true,
        status: 'applied',
      }),
    ]);
    expect((await planOf(id)).scenes[0]!.worldReference).toEqual({
      file: place.file,
      isPano: true,
    });
    const log = await readFile(join(dataDir, id, 'log.txt'), 'utf8');
    expect(log).toMatch(
      /chat: plan-patch character:theo heightMeters — Theo is now 1\.90 m \[applied\]/,
    );
    expect(log).toMatch(
      /chat: character-reference maya — Maya is built from this photo \[applied\]/,
    );
  });

  it('generate starts the pipeline with the amended plan', async () => {
    const go = await say(id, 'looks good, go ahead');
    expect(types(go.answer.actions)).toEqual(['generate:applied']);
    expect(go.status.draft).toBeUndefined();
    await store.idle();
    const st = await statusOf(id);
    expect(st.scenes.every((j) => j.stages.manifest.status === 'done')).toBe(true);
    const m = await manifest(id, 0);
    expect(m.characters.find((c) => c.id === 'theo')!.heightMeters).toBe(1.9);
    expect(m.characters.find((c) => c.id === 'maya')!.referenceImage).toBe(photo.file);
    // a second generate is a no-op
    expect((await post(api.generate(id), {})).status).toBe(202);
    expect((await say(id, 'generate')).answer).toMatchObject({
      text: 'This project is already generated.',
    });
  });

  it('generated: a line edit re-voices only that line (the sidecar cache keeps the others)', async () => {
    const audio = (line: string) =>
      stat(join(dataDir, id, 'scene-0', 'audio', `${line}.wav`)).then((s) => s.mtimeMs);
    const [l1, l4] = [await audio('s1-l1'), await audio('s1-l4')];
    await new Promise((r) => setTimeout(r, 20));
    const edit = await say(id, "Maya's second line is 'I let it go.'");
    expect(edit.answer.actions).toEqual([
      expect.objectContaining({
        type: 'plan-patch',
        target: 'line:s1-l4',
        after: 'I let it go.',
        status: 'applied',
        effect: 're-voices 1 line',
      }),
      expect.objectContaining({ type: 'revoice', lineIds: ['s1-l4'], status: 'applied' }),
    ]);
    await store.idle();
    expect(await audio('s1-l1')).toBe(l1);
    expect(await audio('s1-l4')).toBeGreaterThan(l4);
    expect((await manifest(id, 0)).plan.dialogue.find((d) => d.id === 's1-l4')!.text).toBe(
      'I let it go.',
    );
  });

  it('generated: a new place needs a confirmed world; a new look rebuilds the actor', async () => {
    const diner = await say(id, 'scene 2 is a diner, not a kitchen');
    expect(types(diner.answer.actions)).toEqual([
      'plan-patch:applied',
      'regenerate-world:needs-confirm',
    ]);
    const regen = diner.answer.actions![1] as Extract<ChatAction, { type: 'regenerate-world' }>;
    expect(regen).toMatchObject({
      sceneIndex: 1,
      cost: '~5 min · 1,580 Marble credits',
      note: expect.stringMatching(/MOCK/),
    });
    expect(diner.answer.actions![0]).toMatchObject({ effect: 'needs a new world' });
    expect((await planOf(id)).scenes[1]!.worldPrompt).toMatch(/diner/);

    const res = await post(api.chatConfirm(id), { messageId: diner.answer.id, actionId: regen.id });
    expect(res.status).toBe(200);
    await store.idle();
    await expect
      .poll(async () => {
        const chat = ProjectChat.parse(await (await fetch(base + api.chat(id))).json());
        return chat.messages.find((m) => m.id === diner.answer.id)!.actions![1]!.status;
      })
      .toBe('done');
    // every action status change bumped the revision, and the status mirrors it
    const chatNow = ProjectChat.parse(await (await fetch(base + api.chat(id))).json());
    expect(chatNow.revision).toBeGreaterThanOrEqual(diner.chat.revision + 2); // running, done
    expect((await statusOf(id)).chatRevision).toBe(chatNow.revision);
    expect(
      (
        await post(api.chatConfirm(id), {
          messageId: diner.answer.id,
          actionId: diner.answer.actions![0]!.id,
        })
      ).status,
    ).toBe(409);
    expect(
      (await post(api.chatConfirm(id), { messageId: diner.answer.id, actionId: 'a-nope' })).status,
    ).toBe(404);

    const older = await say(id, 'make Theo older');
    expect(types(older.answer.actions)).toEqual(['plan-patch:applied', 'rebuild-actor:applied']);
    expect(older.answer.actions![0]).toMatchObject({ effect: 'rebuilds Theo' });
    await store.idle();
    expect(
      (await statusOf(id)).scenes.every(
        (j) => j.stages.actors.status === 'done' && j.stages.manifest.status === 'done',
      ),
    ).toBe(true);
  });

  it('generated: a re-plan waits for confirm, then keeps ids, amendments, photos and scene folders', async () => {
    await writeFile(join(dataDir, id, 'scene-0', 'marker.txt'), 'old scene 0');
    claudeDraft = {
      reply: 'Added a diner scene before the street.',
      actions: [
        {
          type: 'replan',
          target: '',
          field: '',
          value: '',
          attachmentId: '',
          isPano: false,
          edits: [
            {
              find: 'EXT. CITY STREET - NIGHT',
              replace:
                'INT. NIGHT DINER - NIGHT\n\nNeon over a counter.\n\nTHEO\nOne more coffee.\n\nEXT. CITY STREET - NIGHT',
            },
          ],
          summary: 'Add a diner scene first',
        },
      ],
    };
    const r = await say(id, 'open with them in a diner');
    claudeDraft = undefined;
    expect(r.answer).toMatchObject({ source: 'claude', costUsd: 0.008 });
    const replan = r.answer.actions![0] as Extract<ChatAction, { type: 'replan' }>;
    expect(replan).toMatchObject({
      status: 'needs-confirm',
      cost: '~5 min · 1,580 Marble credits',
    });
    expect(replan.note).toMatch(/3 scenes keep their world, 1 new scene needs a world/);
    expect((await planOf(id)).scenes).toHaveLength(3); // nothing yet

    expect(
      (await post(api.chatConfirm(id), { messageId: r.answer.id, actionId: replan.id })).status,
    ).toBe(200);
    await store.idle();
    const plan = await planOf(id);
    expect(plan.scenes.map((s) => s.heading)).toEqual([
      'INT. NIGHT DINER - NIGHT',
      'EXT. CITY STREET - NIGHT',
      'INT. KITCHEN - MORNING',
      'EXT. ROOFTOP - DUSK',
    ]);
    expect(plan.characters.map((c) => c.id).sort()).toEqual(['maya', 'theo']);
    expect(plan.characters.find((c) => c.id === 'theo')).toMatchObject({
      heightMeters: 1.9,
      description: expect.stringMatching(/, older$/),
    });
    expect(plan.characters.find((c) => c.id === 'maya')!.referenceImage).toBe(photo.file);
    expect(plan.scenes[2]!.worldPrompt).toMatch(/diner/); // the kitchen scene kept its amended prompt
    expect(await readFile(join(dataDir, id, 'scene-1', 'marker.txt'), 'utf8')).toBe('old scene 0');
    const st = await statusOf(id);
    expect(st.scenes.map((j) => j.stages.manifest.status)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ]);
    const chat = ProjectChat.parse(await (await fetch(base + api.chat(id))).json());
    expect(chat.messages.find((m) => m.id === r.answer.id)!.actions![0]).toMatchObject({
      status: 'done',
      note: '4 scenes, 2 characters',
    });
    expect(chat.messages.at(-1)).toMatchObject({
      planCard: true,
      text: expect.stringMatching(/^Re-planned 4 scenes/),
    });
  });
});
