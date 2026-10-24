// Chat routes against a fake store (no pipeline) and a fake Claude call: upload validation, what
// the planner is sent (plan, photos as image blocks with their id and hint), how its answer is
// checked and applied on a generated project, and the errors.
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api } from '../../../shared/api.ts';
import { Attachment, ProjectChat } from '../../../shared/chat.ts';
import type { ProjectStatus, ScreenplayPlan } from '../../../shared/schema.ts';
import { mockPlan } from '../fountain.ts';
import type { ChatHost } from './apply.ts';
import { emptyDraftAction, type ChatDraft } from './draft.ts';
import type { ChatPlannerCall } from './planner.ts';
import type { ChatResponse } from '../../../shared/chat.ts';
import { handleChatRequest } from './routes.ts';
import { ChatStore } from './store.ts';
import { MAX_UPLOAD_BYTES } from './uploads.ts';

const FIXTURE = readFileSync(
  new URL('../../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);
const JPEG = readFileSync(
  new URL('../../../fixtures/real-samples/reference-512.jpg', import.meta.url),
);
const ID = 'last-bus-abc123';

let server: Server;
let base: string;
let plan: ScreenplayPlan;
const calls: string[] = [];
let requests: Parameters<ChatPlannerCall>[0][] = [];
let answer: ChatDraft | Error;

function fakeHost(dir: string): ChatHost {
  plan = mockPlan(FIXTURE, { log: () => {} });
  const done = { status: 'done' as const };
  const st: ProjectStatus = {
    id: ID,
    title: plan.title,
    createdAt: '2026-10-24T00:00:00Z',
    mock: false,
    parse: done,
    scenes: plan.scenes.map((s) => ({
      sceneIndex: s.index,
      slug: s.slug,
      stages: { parse: done, world: done, actors: done, tts: done, manifest: done },
    })),
  };
  const ok = async (what: string) => {
    calls.push(what);
    return structuredClone(st);
  };
  return {
    dataDir: dir,
    chat: new ChatStore((id) => join(dir, id)),
    projectDir: (id) => join(dir, id),
    getProject: async (id) => (id === ID ? structuredClone(st) : undefined),
    getPlan: async () => structuredClone(plan),
    readScreenplay: async () => FIXTURE,
    amendPlan: async (_id, fn) => {
      const before = plan;
      const next = structuredClone(plan);
      fn(next);
      plan = next;
      calls.push('amend');
      return { plan, before, changed: [] };
    },
    generate: () => ok('generate'),
    retry: (_id, n, stage) => ok(`retry ${n} ${stage}`),
    rebuildActorFromPlan: (_id, cid) => ok(`rebuild ${cid}`),
    regenerateWorld: (_id, n) => ok(`regenerate ${n}`),
    replan: () => ok('replan'),
    logEvent: async () => {},
  };
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'previz-chat-routes-'));
  await mkdir(join(dir, ID));
  const host = fakeHost(dir);
  const call: ChatPlannerCall = async (req) => {
    requests.push(req);
    if (answer instanceof Error) throw answer;
    return {
      stop_reason: 'end_turn',
      usage: { input_tokens: 3000, output_tokens: 400, cache_read_input_tokens: 2000 },
      content: [{ type: 'text', text: JSON.stringify(answer) }],
    } as unknown as Anthropic.Beta.BetaMessage;
  };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const parts = url.pathname.replace(/\/+$/, '').split('/').slice(1);
    if (
      await handleChatRequest(req, res, parts, url, host, {
        planner: { mock: false, call },
        waitMs: 50,
      })
    )
      return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise((r) => server.close(r)));

const upload = (body: Buffer, type: string, id = ID) =>
  fetch(`${base}${api.uploads(id)}?name=${encodeURIComponent('../../Leo 01.jpg')}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: new Uint8Array(body),
  });
const post = (path: string, body: unknown) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('uploads', () => {
  it('stores by content, trusts the bytes over the label, and refuses the rest with JSON errors', async () => {
    const res = await upload(JPEG, 'image/png'); // a JPEG labelled PNG is stored as the JPEG it is
    expect(res.status).toBe(201);
    const a = Attachment.parse(await res.json());
    expect(a).toMatchObject({
      file: `uploads/${a.id}.jpg`,
      name: 'Leo 01.jpg',
      width: 341,
      height: 512,
      bytes: JPEG.length,
    });
    expect(res.headers.get('location')).toBe(`/projects/${ID}/${a.file}`);
    const err = async (r: Response) => [r.status, ((await r.json()) as { error: string }).error];
    expect(await err(await upload(Buffer.from('hello'), 'text/plain'))).toEqual([
      415,
      expect.stringMatching(/content-type/),
    ]);
    expect(await err(await upload(Buffer.from('GIF89a not really'), 'image/png'))).toEqual([
      415,
      expect.stringMatching(/PNG, JPEG or WebP/),
    ]);
    expect(await err(await upload(Buffer.alloc(MAX_UPLOAD_BYTES + 1), 'image/jpeg'))).toEqual([
      413,
      expect.stringMatching(/over/),
    ]);
    expect(await err(await upload(JPEG, 'image/jpeg', 'nope-000000'))).toEqual([
      404,
      'no such project',
    ]);
    expect((await fetch(base + api.uploads(ID))).status).toBe(405);
  });
});

describe('chat (fake Claude, generated project)', () => {
  it('GET answers an empty thread before anything was said', async () => {
    const res = await fetch(base + api.chat(ID));
    expect(ProjectChat.parse(await res.json())).toEqual({ version: 1, revision: 0, messages: [] });
  });

  it('sends the plan and the photo to the planner, applies the checked answer, and reports what it could not do', async () => {
    const a = Attachment.parse(await (await upload(JPEG, 'image/jpeg')).json());
    answer = {
      reply: 'Maya now has this face, and Theo stands a step closer.',
      actions: [
        {
          ...emptyDraftAction('character-reference', 'Maya is built from this photo'),
          target: 'character:maya',
        }, // the one photo of the message
        {
          ...emptyDraftAction('plan-patch', 'Theo moves closer'),
          target: 'scene:0',
          field: 'blocking.theo.position',
          value: '0.4, 0, -2.2',
        },
        {
          ...emptyDraftAction('plan-patch', 'a line that does not exist'),
          target: 'line:s9-l9',
          field: 'text',
          value: 'x',
        },
      ],
    };
    requests = [];
    calls.length = 0;
    const res = await post(api.chat(ID), {
      text: 'this is Maya. Theo should stand closer to her',
      attachments: [{ id: a.id, hint: 'character:maya' }],
    });
    expect(res.status).toBe(200);
    const { chat, status } = (await res.json()) as ChatResponse;
    expect(status.id).toBe(ID);

    // what Claude was given
    const req = requests[0]!;
    expect(req.system).toMatch(/cheapest action/);
    const blocks = req.content;
    const text = blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    expect(text).toMatch(/s1-l4 maya: "It's Tuesday\."/);
    expect(text).toMatch(/\[index 1 = scene 2\] INT\. KITCHEN - MORNING/);
    expect(text).toContain(
      `Photo ${a.id} "Leo 01.jpg", 341×512, the director's hint: character:maya, attached to this message:`,
    );
    const image = blocks.find((b) => b.type === 'image') as Anthropic.Beta.BetaImageBlockParam;
    expect(image.source).toEqual({
      type: 'base64',
      media_type: 'image/jpeg',
      data: JPEG.toString('base64'),
    });
    expect(text).toMatch(
      /The director's new message: """this is Maya\. Theo should stand closer to her"""/,
    );

    // what was applied
    const m = ProjectChat.parse(chat).messages.at(-1)!;
    expect(m).toMatchObject({ role: 'assistant', source: 'claude', costUsd: 0.0204 });
    expect(m.text).toBe(
      'Maya now has this face, and Theo stands a step closer. Not done: line:s9-l9 text: no line "s9-l9".',
    );
    expect(m.actions!.map((x) => `${x.type}:${x.status}`)).toEqual([
      'character-reference:applied',
      'plan-patch:applied',
      'rebuild-actor:applied',
    ]);
    expect(m.actions![1]).toMatchObject({
      target: 'scene:0',
      field: 'blocking.theo.position',
      after: [0.4, 0, -2.2],
      effect: 'updates the scene',
    });
    expect(calls).toEqual(['amend', 'rebuild maya', 'retry 0 manifest']);
    expect(plan.characters.find((c) => c.id === 'maya')!.referenceImage).toBe(a.file);
    expect(plan.scenes[0]!.blocking.find((b) => b.characterId === 'theo')!.position).toEqual([
      0.4, 0, -2.2,
    ]);
  });

  it('world changes wait for confirm; confirm runs one, decline skips one; a planner failure changes nothing', async () => {
    const night = (n: number) => ({
      ...emptyDraftAction('plan-patch', `Scene ${n + 1} at night`),
      target: `scene:${n}`,
      field: 'timeOfDay',
      value: 'night',
    });
    answer = {
      reply: 'The kitchen and the rooftop are now at night.',
      actions: [night(1), night(2)],
    };
    calls.length = 0;
    const r = (await (
      await post(api.chat(ID), { text: 'kitchen and rooftop at night' })
    ).json()) as ChatResponse;
    const m = r.chat.messages.at(-1)!;
    expect(m.actions!.map((x) => `${x.type}:${x.status}`)).toEqual([
      'plan-patch:applied',
      'plan-patch:applied',
      'regenerate-world:needs-confirm',
      'regenerate-world:needs-confirm',
    ]);
    expect(calls).toEqual(['amend']);
    const [regen1, regen2] = [m.actions![2]!, m.actions![3]!];
    const confirmed = (await (
      await post(api.chatConfirm(ID), { messageId: m.id, actionId: regen1.id })
    ).json()) as ChatResponse;
    expect(calls).toEqual(['amend', 'regenerate 1']);
    // the fake world stage is already done: the watch settles at once
    expect(confirmed.chat.messages.find((x) => x.id === m.id)!.actions![2]!.status).toBe('done');
    const declined = (await (
      await post(api.chatConfirm(ID), { messageId: m.id, actionId: regen2.id, decline: true })
    ).json()) as ChatResponse;
    expect(declined.chat.messages.find((x) => x.id === m.id)!.actions![3]).toMatchObject({
      status: 'skipped',
      note: expect.stringMatching(/^declined/),
    });
    expect(declined.chat.revision).toBeGreaterThan(confirmed.chat.revision);
    expect(calls).toEqual(['amend', 'regenerate 1']); // nothing ran for the declined one
    const late = await post(api.chatConfirm(ID), { messageId: m.id, actionId: regen2.id });
    expect(late.status).toBe(409);

    answer = new Error('connect ECONNREFUSED');
    calls.length = 0;
    const failed = (await (
      await post(api.chat(ID), { text: 'make Theo taller' })
    ).json()) as ChatResponse;
    expect(failed.chat.messages.at(-1)).toMatchObject({
      text: 'Sorry, the planner is unreachable (connect ECONNREFUSED). Nothing was changed.',
    });
    expect(calls).toEqual([]);
  });

  it('validates requests', async () => {
    const status = async (r: Promise<Response>) => (await r).status;
    expect(
      await status(post(api.chat(ID), { text: 'hi', attachments: [{ id: '0123456789abcdef' }] })),
    ).toBe(400);
    expect(await status(post(api.chat(ID), { text: '   ' }))).toBe(400);
    expect(await status(post(api.chat('nope-000000'), { text: 'hi' }))).toBe(404);
    expect(await status(post(api.chatConfirm(ID), { messageId: 'm-x', actionId: 'a-x' }))).toBe(
      404,
    );
    expect(await status(fetch(base + api.chatConfirm(ID)))).toBe(405);
    expect(await status(post(api.generate(ID), {}))).toBe(202);
    expect(calls.at(-1)).toBe('generate');
  });
});
