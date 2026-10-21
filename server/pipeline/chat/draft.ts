// The chat planner's output ("draft") and the step that checks it against the project.
// Claude (planner.ts) and the offline keyword planner (mock.ts) both fill a ChatDraft; checkDraft
// turns it into proposals that exist in the plan (targets, fields, values, attachments, screenplay
// edits), and apply.ts decides what each one costs on this project.
//
// Like the other drafts in the pipeline (screenplay.ts, reprompt/draft.ts) every field is required
// and plain (no unions / optionals: structured outputs limit both); "" means "not used".
// The planner never proposes rebuild-actor / revoice / regenerate-world: those follow from the
// project's state, so apply.ts derives them.
import { z } from 'zod';
import type { Attachment, ChatMessage } from '../../../shared/chat.ts';
import type { ProjectStatus, ScreenplayPlan } from '../../../shared/schema.ts';
import { applyPatch, checkPatch, findCharacter, parseTarget, type Patch } from './patch.ts';

export const DraftAction = z.object({
  type: z
    .enum(['plan-patch', 'character-reference', 'world-reference', 'replan', 'generate'])
    .describe('the cheapest action that does what the director asked'),
  target: z
    .string()
    .describe(
      'plan-patch: "character:<id>" | "scene:<index>" | "line:<lineId>" | "project"; character-reference: "character:<id>"; world-reference: "scene:<index>"; replan / generate: ""',
    ),
  field: z
    .string()
    .describe(
      'plan-patch: the field to change (see the field list); otherwise ""',
    ),
  value: z
    .string()
    .describe(
      'plan-patch: the complete new value as text (heights in metres "1.85", booleans "true"/"false", points "x, y, z" in metres, a description is the full new description); otherwise ""',
    ),
  attachmentId: z
    .string()
    .describe('character-reference / world-reference: the id of the attached photo; otherwise ""'),
  isPano: z.boolean().describe('world-reference: true only for an equirectangular 360° panorama'),
  edits: z
    .array(z.object({ find: z.string(), replace: z.string() }))
    .describe(
      'replan: edits to the current screenplay text, applied in order; each "find" is an exact, unique passage of the current screenplay and "replace" its new text. [] for every other type',
    ),
  summary: z.string().describe('what this action does, in the director\'s words ("Leo is now 1.85 m")'),
});
export type DraftAction = z.infer<typeof DraftAction>;

export const ChatDraft = z.object({
  reply: z
    .string()
    .describe(
      '1-3 sentences to the director: what you changed, what you did not change and why, or the question you need answered',
    ),
  actions: z.array(DraftAction),
});
export type ChatDraft = z.infer<typeof ChatDraft>;

/** Everything a planner gets for one turn. */
export interface ChatContext {
  plan: ScreenplayPlan;
  status: ProjectStatus;
  /** The current screenplay text (screenplay.fountain). */
  screenplay: string;
  /** The thread before the new message (the planner sees the last ~20). */
  history: ChatMessage[];
  /** The new message; its attachments carry the hint the director (or the UI) gave them. */
  message: { text: string; attachments: Attachment[] };
  /** Photos from earlier messages that are not anyone's reference yet, newest first. */
  earlier: Attachment[];
}

export type Proposal =
  | ({ type: 'plan-patch'; summary: string } & Patch)
  | { type: 'character-reference'; characterId: string; attachment: Attachment; summary: string }
  | { type: 'world-reference'; sceneIndex: number; attachment: Attachment; isPano: boolean; summary: string }
  | { type: 'replan'; screenplay: string; summary: string }
  | { type: 'generate'; summary: string };

export const emptyDraftAction = (type: DraftAction['type'], summary = ''): DraftAction => ({
  type,
  target: '',
  field: '',
  value: '',
  attachmentId: '',
  isPano: false,
  edits: [],
  summary,
});

/** Applies screenplay edits in order; each `find` must occur exactly as written. */
export function editScreenplay(text: string, edits: DraftAction['edits']): { text: string; problems: string[] } {
  let out = text;
  const problems: string[] = [];
  for (const e of edits) {
    if (!e.find) {
      problems.push('an edit had nothing to find');
      continue;
    }
    const at = out.indexOf(e.find);
    if (at < 0) {
      problems.push(`"${e.find.slice(0, 60)}" is not in the screenplay`);
      continue;
    }
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return { text: out, problems };
}

/**
 * Draft → proposals that exist in this project. Whatever cannot be applied is dropped with a
 * problem the reply then mentions, so the director never sees a card for a change that did not
 * happen. Later patches of the same field win.
 */
export function checkDraft(draft: ChatDraft, ctx: ChatContext): { proposals: Proposal[]; problems: string[] } {
  const proposals: Proposal[] = [];
  const problems: string[] = [];
  const photos = [...ctx.message.attachments, ...ctx.earlier];
  const photo = (id: string): Attachment | undefined => {
    if (id) return photos.find((a) => a.id === id);
    // an unnamed photo is unambiguous only when exactly one came with this message
    return ctx.message.attachments.length === 1 ? ctx.message.attachments[0] : undefined;
  };
  // patches are checked one after another against the plan as it will be
  const plan = structuredClone(ctx.plan);
  for (const a of draft.actions) {
    if (a.type === 'plan-patch') {
      const p = checkPatch(plan, a.target, a.field, a.value);
      if ('error' in p) {
        problems.push(`${a.target} ${a.field}: ${p.error}`);
        continue;
      }
      const dup = proposals.findIndex((x) => x.type === 'plan-patch' && x.targetKey === p.targetKey && x.field === p.field);
      if (dup >= 0) proposals.splice(dup, 1);
      proposals.push({ type: 'plan-patch', summary: a.summary.trim() || `${p.targetKey} ${p.field}`, ...p });
      // checkPatch validated it on a copy; keep the running plan in step for the next one
      applyPatch(plan, p);
    } else if (a.type === 'character-reference') {
      const ref = a.target.replace(/^character:/i, '');
      const c = findCharacter(ctx.plan, ref);
      const att = photo(a.attachmentId);
      if (!c) problems.push(`no character "${ref}" for the photo`);
      else if (!att) problems.push(`no attached photo${a.attachmentId ? ` ${a.attachmentId}` : ''} for ${c.id}`);
      else {
        for (let i = proposals.length - 1; i >= 0; i--) {
          const x = proposals[i]!;
          if (x.type === 'character-reference' && x.characterId === c.id) proposals.splice(i, 1);
        }
        proposals.push({ type: 'character-reference', characterId: c.id, attachment: att, summary: a.summary.trim() || `Photo of ${c.id}` });
      }
    } else if (a.type === 'world-reference') {
      const t = parseTarget(ctx.plan, a.target.startsWith('scene:') ? a.target : `scene:${a.target}`);
      const att = photo(a.attachmentId);
      if ('error' in t || t.kind !== 'scene') problems.push(`world-reference: ${'error' in t ? t.error : 'needs a scene'}`);
      else if (!att) problems.push(`no attached photo${a.attachmentId ? ` ${a.attachmentId}` : ''} for scene ${t.index}`);
      else
        proposals.push({
          type: 'world-reference',
          sceneIndex: t.index,
          attachment: att,
          isPano: a.isPano,
          summary: a.summary.trim() || `Photo for scene ${t.index + 1}`,
        });
    } else if (a.type === 'replan') {
      const { text, problems: p } = editScreenplay(ctx.screenplay, a.edits);
      problems.push(...p.map((x) => `re-plan: ${x}`));
      if (text.trim() === ctx.screenplay.trim()) {
        problems.push('re-plan: the screenplay did not change');
        continue;
      }
      proposals.push({ type: 'replan', screenplay: text, summary: a.summary.trim() || 'Re-plan from the amended screenplay' });
    } else if (!proposals.some((x) => x.type === 'generate')) {
      proposals.push({ type: 'generate', summary: a.summary.trim() || 'Start generation' });
    }
  }
  return { proposals, problems };
}
