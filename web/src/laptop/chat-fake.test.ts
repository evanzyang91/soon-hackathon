// The MOCK chat planner rules the fake (and the server's MOCK planner) follow, and the fake's
// draft → amend → generate → confirm flow.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Attachment, ChatAction } from '@shared/chat';
import { mockPlan } from '../../../server/pipeline/fountain.ts';
import { FALLBACK_REPLY, FakeChatApi, REGEN_COST, mockChatReply } from './chat-fake';

const FIXTURE = readFileSync(new URL('../../../fixtures/screenplay.fountain', import.meta.url), 'utf8');
const plan = mockPlan(FIXTURE);
const photo = (hint?: string): Attachment => ({
  id: 'abc123',
  kind: 'image',
  file: 'uploads/abc123.png',
  name: 'photo.png',
  width: 600,
  height: 800,
  bytes: 1000,
  ...(hint ? { hint } : {}),
});
const reply = (text: string, live = false, attachments: Attachment[] = []) =>
  mockChatReply({ plan, live, text, attachments });
const kinds = (actions: ChatAction[]) => actions.map((a) => `${a.type}:${a.status}`);

describe('mock chat planner rules', () => {
  it('makes a character taller by 10 cm, from 1.70 m when the plan has no height (an actor rebuild when live)', () => {
    const theo = plan.characters.find((c) => c.id === 'theo')!.heightMeters!; // the mock planner's "tall" 1.80
    const r = reply('make Theo taller');
    const after = Math.round((theo + 0.1) * 100) / 100;
    expect(r.actions).toMatchObject([
      { type: 'plan-patch', target: 'character:theo', field: 'heightMeters', before: theo, after, summary: `Theo is now ${after.toFixed(2)} m`, status: 'applied' },
    ]);
    expect(r.plan.characters.find((c) => c.id === 'theo')!.heightMeters).toBe(after);
    expect(plan.characters.find((c) => c.id === 'theo')!.heightMeters).toBe(theo); // input untouched
    const unset = structuredClone(plan);
    delete unset.characters[0]!.heightMeters;
    expect(mockChatReply({ plan: unset, live: false, text: 'make Theo taller', attachments: [] }).actions[0]).toMatchObject({ before: 1.7, after: 1.8, summary: 'Theo is now 1.80 m' });
    expect(kinds(reply('make theo older and shorter', true).actions)).toEqual([
      'plan-patch:applied',
      'plan-patch:applied',
      'rebuild-actor:applied',
    ]);
  });

  it("rewrites a character's Nth line (re-voiced when live)", () => {
    const r = reply("Maya's second line is 'I let it go.'", true);
    expect(r.actions[0]).toMatchObject({ type: 'plan-patch', target: 'line:s1-l4', field: 'text', after: 'I let it go.' });
    expect(r.actions[1]).toMatchObject({ type: 'revoice', lineIds: ['s1-l4'], status: 'applied' });
    expect(reply("line s3-l4: 'Fine.'").actions).toMatchObject([{ target: 'line:s3-l4', after: 'Fine.' }]);
    expect(reply("Theo says 'Hey.'").actions).toMatchObject([{ target: 'line:s1-l1', after: 'Hey.' }]);
  });

  it('changes a scene: applied in a draft, a confirmed regeneration when live', () => {
    expect(kinds(reply('scene 2 is a diner').actions)).toEqual(['plan-patch:applied']);
    const live = reply('scene 2 is a diner', true);
    expect(kinds(live.actions)).toEqual(['plan-patch:applied', 'regenerate-world:needs-confirm']);
    expect(live.actions[1]).toMatchObject({ sceneIndex: 1, cost: REGEN_COST });
  });

  it('switches a voice by naming it', () => {
    expect(reply("Theo's voice should be onyx").actions).toMatchObject([{ target: 'character:theo', field: 'voice.id', after: 'onyx' }]);
  });

  it('takes reference photos by hint or by "this is <Name>" / "use this for scene N"', () => {
    const r = reply('', false, [photo('character:maya')]);
    expect(r.actions).toMatchObject([{ type: 'character-reference', characterId: 'maya', attachmentId: 'abc123', status: 'applied' }]);
    expect(r.plan.characters.find((c) => c.id === 'maya')!.referenceImage).toBe('uploads/abc123.png');
    expect(kinds(reply('', true, [photo('character:MAYA')]).actions)).toEqual(['character-reference:applied', 'rebuild-actor:applied']);
    expect(reply('this is Theo', false, [photo()]).actions).toMatchObject([{ type: 'character-reference', characterId: 'theo' }]);
    expect(kinds(reply('use this for scene 2', false, [photo()]).actions)).toEqual(['world-reference:applied']);
    expect(kinds(reply('', true, [photo('scene:3')]).actions)).toEqual(['world-reference:applied', 'regenerate-world:needs-confirm']);
    expect(reply('nice', false, [photo()]).reply).toMatch(/pick a target/);
  });

  it('starts generation of a draft only; anything else gets the capabilities line', () => {
    expect(reply('go ahead').generate).toBe(true);
    expect(kinds(reply('go ahead').actions)).toEqual(['generate:applied']);
    const live = reply('build it', true);
    expect(live.generate).toBe(false);
    expect(live.reply).toMatch(/already generated/);
    expect(reply('what time is it?')).toMatchObject({ reply: FALLBACK_REPLY, actions: [] });
  });
});

describe('FakeChatApi', () => {
  it('drafts, amends, generates and confirms like the server', async () => {
    const fake = new FakeChatApi({
      makePlan: (text, title) => mockPlan(text, { title }),
      prepare: async (blob, name) => ({ blob, name: name ?? 'x.png', width: 600, height: 800 }),
      latencyMs: 0,
      stepMs: 1,
    });
    const draft = await fake.createDraft(FIXTURE);
    expect(draft).toMatchObject({ draft: true, parse: { status: 'running' } });
    await new Promise((r) => setTimeout(r, 20));
    const chat = await fake.getChat(draft.id);
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(chat.messages[1]).toMatchObject({ planCard: true, text: 'Planned 3 scenes and 2 characters: Theo, Maya.' });

    const taller = await fake.send(draft.id, { text: 'make Theo taller' });
    expect(taller.chat.messages.at(-1)!.actions).toMatchObject([{ summary: 'Theo is now 1.90 m', status: 'applied' }]);
    expect(taller.status.chatRevision).toBe(taller.chat.revision);
    expect((await fake.getPlan(draft.id)).characters[0]!.heightMeters).toBe(1.9);

    const att = await fake.uploadImage(draft.id, new Blob(['png']), 'maya.png');
    const ref = await fake.send(draft.id, { text: '', attachments: [{ id: att.id, hint: 'character:maya' }] });
    expect(ref.chat.messages.at(-2)!.attachments).toMatchObject([{ id: att.id, hint: 'character:maya' }]);
    expect(ref.chat.messages.at(-1)!.actions).toMatchObject([{ type: 'character-reference', characterId: 'maya' }]);

    expect((await fake.generate(draft.id)).draft).toBe(false);
    const regen = await fake.send(draft.id, { text: 'scene 2 is a diner' });
    const msg = regen.chat.messages.at(-1)!;
    const action = msg.actions!.find((a) => a.status === 'needs-confirm')!;
    const confirmed = await fake.confirm(draft.id, msg.id, action.id);
    expect(confirmed.chat.messages.at(-1)!.actions!.find((a) => a.id === action.id)!.status).toBe('running');
    expect(confirmed.status.scenes[1]!.stages.world.status).toBe('running');
  });
});
