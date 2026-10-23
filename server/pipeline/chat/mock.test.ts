// The offline chat planner's rules (WP6's chat e2e is written against them) on the fixture plan,
// each answer also passing checkDraft as-is (the mock never proposes what cannot be applied).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Attachment } from '../../../shared/chat.ts';
import type { ProjectStatus } from '../../../shared/schema.ts';
import { mockPlan } from '../fountain.ts';
import { checkDraft, type ChatContext } from './draft.ts';
import { MOCK_ASK_PHOTO, MOCK_FALLBACK, mockChatDraft } from './mock.ts';

const SCREENPLAY = readFileSync(
  new URL('../../../fixtures/screenplay.fountain', import.meta.url),
  'utf8',
);
const PLAN = mockPlan(SCREENPLAY, { log: () => {} });
const status = (draft: boolean): ProjectStatus => ({
  id: 'p',
  title: PLAN.title,
  createdAt: '2026-10-24T00:00:00Z',
  mock: true,
  parse: { status: 'done' },
  scenes: [],
  ...(draft ? { draft: true } : {}),
});
const photo = (id: string, hint?: string, size = [512, 768]): Attachment => ({
  id,
  kind: 'image',
  file: `uploads/${id}.jpg`,
  width: size[0]!,
  height: size[1]!,
  bytes: 1000,
  ...(hint ? { hint } : {}),
});

function plan(
  text: string,
  o: { draft?: boolean; photos?: Attachment[]; earlier?: Attachment[] } = {},
) {
  const ctx: ChatContext = {
    plan: PLAN,
    status: status(o.draft ?? true),
    screenplay: SCREENPLAY,
    history: [],
    message: { text, attachments: o.photos ?? [] },
    earlier: o.earlier ?? [],
  };
  const draft = mockChatDraft(ctx);
  const checked = checkDraft(draft, ctx);
  expect(checked.problems).toEqual([]);
  expect(checked.proposals).toHaveLength(draft.actions.length);
  return {
    reply: draft.reply,
    actions: draft.actions.map(({ type, target, field, value, attachmentId, isPano }) => ({
      type,
      target,
      field,
      value,
      attachmentId,
      isPano,
    })),
  };
}

describe('mock chat planner', () => {
  it('make <Name> taller / older and taller', () => {
    const a = plan('make Theo taller');
    expect(a.actions).toEqual([
      expect.objectContaining({
        type: 'plan-patch',
        target: 'character:theo',
        field: 'heightMeters',
        value: '1.90',
      }),
    ]);
    expect(a.reply).toBe('Theo is now 1.90 m.');
    const b = plan('Make MAYA older and shorter, then generate');
    expect(b.actions.map((x) => [x.target, x.field, x.value.slice(-7)])).toEqual([
      ['character:maya', 'heightMeters', '1.59'],
      ['character:maya', 'description', ', older'],
      ['', '', ''],
    ]);
    expect(b.reply).toMatch(/Maya's description now adds "older"/);
  });

  it('line edits keep the line id: ordinal, number, "says", explicit id; quotes never trigger rules', () => {
    expect(plan("Maya's second line is 'I let it go.'").actions).toEqual([
      expect.objectContaining({ target: 'line:s1-l4', field: 'text', value: 'I let it go.' }),
    ]);
    expect(plan('Theo’s line 2 should be “Saddest thing all week.”').actions[0]).toMatchObject({
      target: 'line:s1-l3',
      value: 'Saddest thing all week.',
    });
    expect(plan("In scene 2, Theo says 'Tea, obviously.'").actions[0]).toMatchObject({
      target: 'line:s2-l1',
      value: 'Tea, obviously.',
    });
    expect(plan('line s3-l4: "Deal. Now go home."').actions[0]).toMatchObject({
      target: 'line:s3-l4',
      value: 'Deal. Now go home.',
    });
    // "start" inside the new line is dialogue, not a request to generate
    expect(plan("Maya says 'Let's start over.'").actions.map((x) => x.type)).toEqual([
      'plan-patch',
    ]);
  });

  it("scene N is <place> / <X> instead of <Y> rewrite that scene's world prompt", () => {
    const a = plan('scene 2 is a diner, not a kitchen').actions[0]!;
    expect(a).toMatchObject({ type: 'plan-patch', target: 'scene:1', field: 'worldPrompt' });
    expect(a.value).toMatch(/diner/);
    expect(a.value).not.toMatch(/kitchen/i);
    const b = plan('Can we do a diner instead of the kitchen?').actions[0]!;
    expect(b).toMatchObject({ target: 'scene:1', field: 'worldPrompt' });
    expect(b.value).toMatch(/interior of a diner/i);
    // the heading's place ("ROOFTOP") is swapped where the prompt names it; the light stays
    const c = plan('scene 3 should be a rainy rooftop garden').actions[0]!;
    expect(c).toMatchObject({ target: 'scene:2', field: 'worldPrompt' });
    expect(c.value).toMatch(/exterior rainy rooftop garden, .*dusk light/i);
  });

  it("voices: a named voice id, or 'swap' picks the next free one", () => {
    expect(plan("Theo's voice should be ash").actions[0]).toMatchObject({
      target: 'character:theo',
      field: 'voice.id',
      value: 'ash',
    });
    expect(plan("swap Maya's voice").actions[0]).toMatchObject({
      target: 'character:maya',
      field: 'voice.id',
      value: 'fable',
    });
  });

  it('photos: hints, "this is <Name>", "use this for …", an earlier unassigned photo, or a question', () => {
    expect(plan('', { photos: [photo('aaaaaaaaaaaaaaaa', 'character:theo')] }).actions).toEqual([
      expect.objectContaining({
        type: 'character-reference',
        target: 'character:theo',
        attachmentId: 'aaaaaaaaaaaaaaaa',
      }),
    ]);
    expect(plan('this is Maya', { photos: [photo('bbbbbbbbbbbbbbbb')] }).actions[0]).toMatchObject({
      type: 'character-reference',
      target: 'character:maya',
    });
    expect(
      plan('use this photo for the kitchen', { photos: [photo('cccccccccccccccc')] }).actions[0],
    ).toMatchObject({
      type: 'world-reference',
      target: 'scene:1',
      isPano: false,
    });
    expect(
      plan('use this for scene 3', { photos: [photo('dddddddddddddddd', undefined, [4096, 2048])] })
        .actions[0],
    ).toMatchObject({ target: 'scene:2', isPano: true });
    expect(plan('', { photos: [photo('eeeeeeeeeeeeeeee', 'scene:0')] }).actions[0]).toMatchObject({
      type: 'world-reference',
      target: 'scene:0',
    });
    // the photo came in an earlier message; this one only says who it is
    expect(
      plan('Theo looks like this', { earlier: [photo('ffffffffffffffff')] }).actions[0],
    ).toMatchObject({ target: 'character:theo', attachmentId: 'ffffffffffffffff' });
    const unknown = plan('', { photos: [photo('0000000000000000')] });
    expect(unknown).toEqual({ reply: MOCK_ASK_PHOTO, actions: [] });
  });

  it('genre / style … western → the four style fields; scene N look <preset> → look.preset', () => {
    const western = plan('make the whole film look like a western');
    expect(western.actions.map((a) => [a.target, a.field])).toEqual([
      ['style', 'genre'],
      ['style', 'era'],
      ['style', 'worldStyle'],
      ['style', 'palette'],
    ]);
    expect(western.actions[0]!.value).toBe('western');
    expect(western.reply).toMatch(/style is now western, 1880s American frontier/);
    expect(plan('change the genre to sci-fi').actions[0]!.value).toBe('science fiction');
    const look = plan('scene 2 look candlelit, and scene 3 look: golden hour please');
    expect(look.actions).toEqual([
      expect.objectContaining({ target: 'scene:1', field: 'look.preset', value: 'candlelit' }),
      expect.objectContaining({ target: 'scene:2', field: 'look.preset', value: 'golden-hour' }),
    ]);
    expect(plan('scene 2 look sparkly').reply).toMatch(/^Looks are daylight-neutral, /);
    // the world rule ("scene N is <place>") does not see a look
    expect(plan('scene 2 look moonlit').actions.map((a) => a.field)).toEqual(['look.preset']);
  });

  it('generate on a draft; a generated project says so; anything else gets the help line', () => {
    expect(plan('looks good, go ahead').actions.map((x) => x.type)).toEqual(['generate']);
    expect(plan('generate', { draft: false })).toEqual({
      reply: 'This project is already generated.',
      actions: [],
    });
    expect(plan('what a lovely day')).toEqual({ reply: MOCK_FALLBACK, actions: [] });
  });
});
