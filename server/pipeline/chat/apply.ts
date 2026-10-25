// Checked proposals (draft.ts) → ChatActions with a status, applied to the project.
//
//                         draft project                 generated ("live") project
//   plan-patch            applied                       applied, plus the follow-up its field needs:
//     description/height                                  rebuild-actor (applied: rebuildActorFromPlan)
//     voice / line text                                   revoice (applied: tts stage redone; the
//                                                           per-line sidecar keeps unchanged lines free)
//     worldPrompt/timeOfDay/interior                      regenerate-world (needs-confirm, ~5 min ·
//                                                           1,580 credits)
//     blocking / heading / name                           scene manifest rewritten (retry 'manifest')
//     dynamics (background action)                        scene manifest rewritten from the plan (the
//                                                           manifest step: world, actors and audio as
//                                                           they are); the laptop swaps the open
//                                                           scene's props when chatRevision moves
//     look.* (scene)                                      edits.json re-graded at once when the scene
//                                                           has one (look-seed.ts writeSceneLook, as
//                                                           cli look --write); else the manifest
//                                                           stage seeds the amended look
//     style.*                                             plan only (free)
//   character-reference   applied (referenceImage)      applied + rebuild-actor
//   world-reference       applied (worldReference)      applied + regenerate-world (needs-confirm)
//   replan                running → done (re-parse)     needs-confirm, with what it keeps and what not
//   generate              applied (ProjectStore.generate) skipped: already generated
//
// A follow-up is skipped when its stage has not run yet (still pending): the stage reads the
// amended plan when it runs. Every action is logged to the project's log.txt.
import type { Attachment, ChatAction, ChatMessage } from '../../../shared/chat.ts';
import type { ProjectStatus, ScreenplayPlan } from '../../../shared/schema.ts';
import { editsStoreFor } from '../edits.ts';
import { parseFountain } from '../fountain.ts';
import { exists } from '../fsutil.ts';
import { lookSeedFor, styleForPlan, writeSceneLook } from '../look-seed.ts';
import type { StageName } from '../project.ts';
import { REGEN } from '../reprompt/draft.ts';
import type { Proposal } from './draft.ts';
import { applyPatch, effectOf, type Effect } from './patch.ts';
import { castName, planCardMessage } from './plan-card.ts';
import { replanImpact } from './replan.ts';
import { newActionId, type ChatStore } from './store.ts';

export const REGEN_COST = `~${REGEN.minutes} min · ${REGEN.credits.toLocaleString('en-US')} Marble credits`;

export interface AmendResult {
  plan: ScreenplayPlan;
  before: ScreenplayPlan;
  /** Readable changed paths (plan-diff.ts). */
  changed: string[];
}

/** What the chat needs from the project store (ProjectStore implements it; tests fake it). */
export interface ChatHost {
  readonly dataDir: string;
  readonly chat: ChatStore;
  projectDir(id: string): string;
  getProject(id: string): Promise<ProjectStatus | undefined>;
  getPlan(id: string): Promise<ScreenplayPlan | undefined>;
  readScreenplay(id: string): Promise<string>;
  amendPlan(id: string, fn: (plan: ScreenplayPlan) => void): Promise<AmendResult>;
  generate(id: string): Promise<ProjectStatus>;
  retry(id: string, sceneIndex: number, stage: StageName): Promise<ProjectStatus>;
  rebuildActorFromPlan(id: string, characterId: string): Promise<ProjectStatus>;
  regenerateWorld(id: string, sceneIndex: number): Promise<ProjectStatus>;
  replan(id: string, screenplay: string): Promise<ProjectStatus>;
  logEvent(id: string, message: string): Promise<void>;
}

export interface ApplyOptions {
  /** MARBLE_DRY_RUN: a confirmed regeneration logs the Marble request instead of paying. */
  dryRun: boolean;
}

export interface Applied {
  actions: ChatAction[];
  /** Work to start once the assistant message holding `actions` is stored (a draft re-plan). */
  after?: (messageId: string) => Promise<void>;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function regenNote(st: ProjectStatus, o: ApplyOptions): string | undefined {
  if (st.mock) return 'MOCK project: the mock world is used, no credits are spent';
  if (o.dryRun)
    return 'dry run (MARBLE_DRY_RUN): the Marble request is logged, no credits are spent';
  return undefined;
}

const stageOf = (st: ProjectStatus, n: number, stage: StageName) =>
  st.scenes[n]?.stages[stage]?.status ?? 'pending';

async function logAction(host: ChatHost, id: string, a: ChatAction): Promise<void> {
  const where =
    a.type === 'plan-patch'
      ? ` ${a.target} ${a.field}`
      : 'characterId' in a
        ? ` ${a.characterId}`
        : 'sceneIndex' in a
          ? ` scene ${a.sceneIndex}`
          : '';
  await host.logEvent(
    id,
    `chat: ${a.type}${where} — ${a.summary} [${a.status}${a.note ? `: ${a.note}` : ''}]`,
  );
}

/** Applies what is free, proposes what costs; resolves with the actions for the assistant message. */
export async function applyProposals(
  host: ChatHost,
  id: string,
  proposals: Proposal[],
  o: ApplyOptions,
): Promise<Applied> {
  const st0 = await host.getProject(id);
  if (!st0) throw new Error(`no project ${id}`);
  const draft = !!st0.draft;
  const actions: ChatAction[] = [];
  let after: Applied['after'];

  // 1. every plan change of the message in one amendment (one plan.json write, one revision)
  const changes = proposals.filter(
    (
      p,
    ): p is Extract<Proposal, { type: 'plan-patch' | 'character-reference' | 'world-reference' }> =>
      p.type === 'plan-patch' || p.type === 'character-reference' || p.type === 'world-reference',
  );
  const results = new Map<Proposal, { before?: unknown; after?: unknown; error?: string }>();
  if (changes.length) {
    try {
      await host.amendPlan(id, (plan) => {
        for (const p of changes) {
          try {
            if (p.type === 'plan-patch') results.set(p, applyPatch(plan, p));
            else if (p.type === 'character-reference') {
              const c = plan.characters.find((x) => x.id === p.characterId);
              if (!c) throw new Error(`no character ${p.characterId}`);
              results.set(p, { before: c.referenceImage, after: p.attachment.file });
              c.referenceImage = p.attachment.file;
            } else {
              const s = plan.scenes[p.sceneIndex];
              if (!s) throw new Error(`no scene ${p.sceneIndex}`);
              results.set(p, { before: s.worldReference?.file, after: p.attachment.file });
              s.worldReference = { file: p.attachment.file, isPano: p.isPano };
            }
          } catch (e) {
            results.set(p, { error: errMsg(e) });
          }
        }
      });
    } catch (e) {
      for (const p of changes) results.set(p, { error: errMsg(e) });
    }
  }

  const plan = (await host.getPlan(id))!;
  const st = (await host.getProject(id))!;
  const name = (cid: string) => castName(plan.characters.find((c) => c.id === cid)?.name ?? cid);
  // follow-ups collected over the whole message, then issued once each
  const rebuild = new Set<string>();
  const revoice = new Map<number, Set<string>>();
  const regen = new Set<number>();
  const manifest = new Set<number>();
  // scenes re-graded by this message (several look fields of one scene: one rewrite, final plan)
  const regraded = new Map<number, string>();
  const voiceLines = (n: number, lineIds: string[]) => {
    const set = revoice.get(n) ?? new Set<string>();
    for (const l of lineIds) set.add(l);
    revoice.set(n, set);
  };
  const scenesWith = (cid: string) =>
    plan.scenes.filter((s) => s.characterIds.includes(cid)).map((s) => s.index);

  for (const p of proposals) {
    if (
      p.type === 'plan-patch' ||
      p.type === 'character-reference' ||
      p.type === 'world-reference'
    ) {
      const r = results.get(p) ?? {};
      const failed = r.error !== undefined;
      const status = failed ? 'failed' : 'applied';
      const note = r.error;
      let effect: Effect = 'none';
      if (p.type === 'plan-patch') effect = effectOf(p);
      else effect = p.type === 'character-reference' ? 'actor' : 'world';
      let effectText: string | undefined;
      if (!failed && !draft) {
        if (effect === 'actor') {
          const cid =
            p.type === 'plan-patch'
              ? (p.target as { id: string }).id
              : (p as { characterId: string }).characterId;
          const started = scenesWith(cid).some((n) => stageOf(st, n, 'actors') !== 'pending');
          if (started) rebuild.add(cid);
          effectText = started ? `rebuilds ${name(cid)}` : `used when ${name(cid)} is built`;
        } else if (effect === 'voice' && p.type === 'plan-patch') {
          const t = p.target;
          const lines =
            t.kind === 'line'
              ? [{ n: t.sceneIndex, ids: [t.id] }]
              : t.kind === 'character'
                ? plan.scenes
                    .map((s) => ({
                      n: s.index,
                      ids: s.dialogue.filter((l) => l.characterId === t.id).map((l) => l.id),
                    }))
                    .filter((x) => x.ids.length)
                : [];
          const count = lines.reduce((k, x) => k + x.ids.length, 0);
          const started = lines.filter((x) => stageOf(st, x.n, 'tts') !== 'pending');
          for (const x of started) voiceLines(x.n, x.ids);
          effectText = started.length
            ? `re-voices ${plural(count, 'line')}`
            : 'used when the lines are voiced';
        } else if (effect === 'world') {
          const n =
            p.type === 'plan-patch'
              ? (p.target as { index: number }).index
              : (p as { sceneIndex: number }).sceneIndex;
          const started = stageOf(st, n, 'world') !== 'pending';
          if (started) regen.add(n);
          effectText = started ? 'needs a new world' : 'used when the world is generated';
        } else if (effect === 'look' && p.type === 'plan-patch') {
          const n = (p.target as { index: number }).index;
          if (!regraded.has(n)) regraded.set(n, await regrade(host, id, plan, n, p.summary));
          effectText = regraded.get(n);
        } else if (effect === 'manifest' && p.type === 'plan-patch') {
          const t = p.target;
          const ns =
            t.kind === 'scene' ? [t.index] : t.kind === 'character' ? scenesWith(t.id) : [];
          for (const n of ns) if (stageOf(st, n, 'manifest') === 'done') manifest.add(n);
          effectText = p.field === 'dynamics' ? 'updates the background action' : 'updates the scene';
        }
      }
      if (p.type === 'plan-patch')
        actions.push({
          type: 'plan-patch',
          id: newActionId(),
          target: p.targetKey,
          field: p.field,
          ...(r.before !== undefined ? { before: r.before } : {}),
          after: r.after ?? p.value,
          summary: p.summary,
          status,
          ...(effectText ? { effect: effectText } : {}),
          ...(note ? { note } : {}),
        });
      else if (p.type === 'character-reference')
        actions.push({
          type: 'character-reference',
          id: newActionId(),
          characterId: p.characterId,
          attachmentId: p.attachment.id,
          summary: p.summary,
          status,
          ...(note ? { note } : {}),
        });
      else
        actions.push({
          type: 'world-reference',
          id: newActionId(),
          sceneIndex: p.sceneIndex,
          attachmentId: p.attachment.id,
          isPano: p.isPano,
          summary: p.summary,
          status,
          ...(note ? { note } : effectText ? { note: effectText } : {}),
        });
    } else if (p.type === 'generate') {
      if (!draft) {
        actions.push({
          type: 'generate',
          id: newActionId(),
          summary: p.summary,
          status: 'skipped',
          note: 'This project is already generated.',
        });
      } else if (proposals.some((x) => x.type === 'replan')) {
        // starts after the re-plan (in `after`), so the new plan is what gets generated
        actions.push({
          type: 'generate',
          id: newActionId(),
          summary: p.summary,
          status: 'running',
          note: 'after the re-plan',
        });
      } else {
        try {
          await host.generate(id);
          actions.push({
            type: 'generate',
            id: newActionId(),
            summary: p.summary,
            status: 'applied',
          });
        } catch (e) {
          actions.push({
            type: 'generate',
            id: newActionId(),
            summary: p.summary,
            status: 'failed',
            note: errMsg(e),
          });
        }
      }
    } else if (p.type === 'replan') {
      const impact = replanImpact(
        plan,
        parseFountain(p.screenplay).scenes.map((s) => s.heading),
      );
      if (draft) {
        actions.push({
          type: 'replan',
          id: newActionId(),
          screenplay: p.screenplay,
          summary: p.summary,
          status: 'running',
          note: 're-planning the screenplay',
        });
      } else {
        const what = [
          `${plural(impact.keep, 'scene')} keep their world`,
          impact.fresh
            ? `${plural(impact.fresh, 'new scene')} need${impact.fresh === 1 ? 's' : ''} a world`
            : '',
          impact.dropped ? `${plural(impact.dropped, 'scene')} set aside` : '',
        ].filter(Boolean);
        actions.push({
          type: 'replan',
          id: newActionId(),
          screenplay: p.screenplay,
          summary: p.summary,
          status: 'needs-confirm',
          cost: impact.fresh
            ? `~${REGEN.minutes} min · ${(impact.fresh * REGEN.credits).toLocaleString('en-US')} Marble credits`
            : 'no new worlds',
          note: `Re-plans every scene from the amended screenplay: ${what.join(', ')}; lines are re-voiced; actors, photos and amendments of kept characters stay.${regenNote(st, o) && impact.fresh ? ` ${regenNote(st, o)}.` : ''}`,
        });
      }
    }
  }

  // 2. follow-ups on a generated project
  for (const cid of rebuild) {
    const base = {
      type: 'rebuild-actor' as const,
      id: newActionId(),
      characterId: cid,
      summary: `Rebuild ${name(cid)}`,
    };
    try {
      await host.rebuildActorFromPlan(id, cid);
      actions.push({ ...base, status: 'applied' });
    } catch (e) {
      actions.push({ ...base, status: 'failed', note: errMsg(e) });
    }
  }
  if (revoice.size) {
    const lineIds = [...revoice.values()].flatMap((s) => [...s]);
    const notes: string[] = [];
    for (const n of revoice.keys()) {
      try {
        if (stageOf(st, n, 'tts') === 'running')
          notes.push(
            `scene ${n + 1} is being voiced right now; its lines follow the new text on the next run`,
          );
        await host.retry(id, n, 'tts');
      } catch (e) {
        notes.push(`scene ${n + 1}: ${errMsg(e)}`);
      }
    }
    const failed = notes.some((x) => !x.includes('right now'));
    actions.push({
      type: 'revoice',
      id: newActionId(),
      lineIds,
      summary: `Re-voice ${plural(lineIds.length, 'line')}`,
      status: failed ? 'failed' : 'applied',
      ...(notes.length ? { note: notes.join('; ') } : {}),
    });
  }
  for (const n of regen) {
    const scene = plan.scenes[n]!;
    const running = stageOf(st, n, 'world') === 'running';
    const note = [
      running ? 'a world for this scene is being made right now; confirm when it is done' : '',
      regenNote(st, o) ?? '',
    ]
      .filter(Boolean)
      .join('; ');
    actions.push({
      type: 'regenerate-world',
      id: newActionId(),
      sceneIndex: n,
      summary: `Regenerate scene ${n + 1}'s world (${scene.heading})`,
      status: 'needs-confirm',
      cost: REGEN_COST,
      ...(note ? { note } : {}),
    });
  }
  for (const n of manifest) await host.retry(id, n, 'manifest').catch(() => undefined);

  for (const a of actions) await logAction(host, id, a);

  const replan = actions.find(
    (a): a is Extract<ChatAction, { type: 'replan' }> =>
      a.type === 'replan' && a.status === 'running',
  );
  if (replan) {
    const gen = actions.find((a) => a.type === 'generate' && a.status === 'running');
    after = async (messageId) => {
      await runReplan(host, id, messageId, replan.id, replan.screenplay!, { replanned: true });
      if (gen) {
        try {
          await host.generate(id);
          await host.chat.updateAction(id, messageId, gen.id, { status: 'done', note: undefined });
        } catch (e) {
          await host.chat.updateAction(id, messageId, gen.id, {
            status: 'failed',
            note: errMsg(e),
          });
        }
      }
    };
  }
  return { actions, ...(after ? { after } : {}) };
}

/**
 * A scene look patch on a scene that already has its look (edits.json): the grade follows the plan
 * now, through the same path as `cli look --write`; without one the manifest stage seeds it.
 */
async function regrade(
  host: ChatHost,
  id: string,
  plan: ScreenplayPlan,
  n: number,
  summary: string,
): Promise<string> {
  const edits = editsStoreFor(host);
  try {
    if (!(await exists(edits.path(id, n)))) return 'used when the scene opens';
    const saved = await writeSceneLook(
      edits,
      id,
      n,
      lookSeedFor(plan.scenes[n]!, styleForPlan(plan)),
      `chat: ${summary}`,
    );
    return `re-grades the scene: ${saved.look.name}`;
  } catch (e) {
    return `the scene's grade was not rewritten (${errMsg(e)})`;
  }
}

/** Re-plans, then records the outcome on the action and appends the new plan card. */
async function runReplan(
  host: ChatHost,
  id: string,
  messageId: string,
  actionId: string,
  screenplay: string,
  o: { replanned: boolean },
): Promise<void> {
  try {
    const st = await host.replan(id, screenplay);
    const plan = (await host.getPlan(id))!;
    const note = `${plural(plan.scenes.length, 'scene')}, ${plural(plan.characters.length, 'character')}`;
    await host.chat.updateAction(id, messageId, actionId, { status: 'done', note });
    await host.chat.appendMessages(id, [
      planCardMessage(plan, {
        replanned: o.replanned,
        draft: !!st.draft,
        source: st.mock ? 'mock' : 'claude',
      }),
    ]);
    await host.logEvent(id, `chat: replan done — ${note}`);
  } catch (e) {
    await host.chat.updateAction(id, messageId, actionId, { status: 'failed', note: errMsg(e) });
    await host.logEvent(id, `chat: replan FAILED ${errMsg(e)}`);
  }
}

export class ConfirmError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Polls the in-memory status until the stage has settled (done / failed / skipped). A stage that
 * was already settled when asked counts as settled at once.
 */
export async function waitForStage(
  host: Pick<ChatHost, 'getProject'>,
  id: string,
  n: number,
  stage: StageName,
  o: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ status: string; note?: string }> {
  const until = Date.now() + (o.timeoutMs ?? 45 * 60_000);
  for (;;) {
    const s = (await host.getProject(id))?.scenes[n]?.stages[stage];
    if (!s) return { status: 'failed', note: `no scene ${n}` };
    if (s.status !== 'pending' && s.status !== 'running') return s;
    if (Date.now() > until)
      return { status: 'failed', note: 'still running after the wait; see the project status' };
    await new Promise((r) => setTimeout(r, o.intervalMs ?? 500));
  }
}

/**
 * Runs one needs-confirm action (regenerate-world or replan): running at once, done / failed when
 * the work finishes (`settled`). Confirming an action that is already running or done is a no-op;
 * a failed one may be confirmed again. `decline` marks it skipped and runs nothing.
 */
export async function confirmAction(
  host: ChatHost,
  id: string,
  messageId: string,
  actionId: string,
  o: { decline?: boolean; waitIntervalMs?: number } = {},
): Promise<{ settled: Promise<void> }> {
  const chat = await host.chat.read(id);
  const msg: ChatMessage | undefined = chat.messages.find((m) => m.id === messageId);
  const action = msg?.actions?.find((a) => a.id === actionId);
  if (!msg || !action) throw new ConfirmError(404, `no action ${actionId} in message ${messageId}`);
  if (action.type !== 'regenerate-world' && action.type !== 'replan')
    throw new ConfirmError(409, `a ${action.type} action needs no confirmation`);
  if (o.decline) {
    if (action.status === 'skipped') return { settled: Promise.resolve() };
    if (action.status !== 'needs-confirm' && action.status !== 'failed')
      throw new ConfirmError(409, `the action is ${action.status}; it can no longer be declined`);
    // the plan change that asked for it stays; only the expensive step does not run
    const note =
      action.type === 'replan'
        ? 'declined: the plan stays as it is'
        : 'declined: the current world stays (the plan keeps the change for a later regeneration)';
    await host.chat.updateAction(id, messageId, actionId, { status: 'skipped', note });
    await host.logEvent(id, `chat: declined ${action.type} — ${action.summary}`);
    return { settled: Promise.resolve() };
  }
  if (action.status === 'running' || action.status === 'done')
    return { settled: Promise.resolve() };
  if (action.status !== 'needs-confirm' && action.status !== 'failed')
    throw new ConfirmError(409, `the action is ${action.status}`);
  await host.chat.updateAction(id, messageId, actionId, { status: 'running', note: undefined });
  await host.logEvent(id, `chat: confirmed ${action.type} — ${action.summary}`);
  if (action.type === 'replan') {
    return {
      settled: runReplan(
        host,
        id,
        messageId,
        actionId,
        action.screenplay ?? (await host.readScreenplay(id)),
        { replanned: true },
      ),
    };
  }
  const n = action.sceneIndex;
  try {
    await host.regenerateWorld(id, n);
  } catch (e) {
    await host.chat.updateAction(id, messageId, actionId, { status: 'failed', note: errMsg(e) });
    await host.logEvent(id, `chat: regenerate scene ${n} FAILED ${errMsg(e)}`);
    return { settled: Promise.resolve() };
  }
  const settled = (async () => {
    const s = await waitForStage(host, id, n, 'world', { intervalMs: o.waitIntervalMs });
    const failed = s.status !== 'done' || /regeneration failed/i.test(s.note ?? '');
    await host.chat.updateAction(id, messageId, actionId, {
      status: failed ? 'failed' : 'done',
      ...(s.note ? { note: s.note } : { note: undefined }),
    });
    await host.logEvent(
      id,
      `chat: regenerate scene ${n} ${failed ? 'FAILED' : 'done'}${s.note ? ` — ${s.note}` : ''}`,
    );
  })().catch((e) => console.error(`[${id}] chat confirm watch failed:`, e));
  return { settled };
}

/** Photos in the thread nobody uses as a reference yet, newest first (the planner may assign them). */
export function unassignedPhotos(messages: ChatMessage[], plan: ScreenplayPlan): Attachment[] {
  const used = new Set([
    ...plan.characters.flatMap((c) => (c.referenceImage ? [c.referenceImage] : [])),
    ...plan.scenes.flatMap((s) => (s.worldReference ? [s.worldReference.file] : [])),
  ]);
  const seen = new Set<string>();
  const out: Attachment[] = [];
  for (const m of [...messages].reverse()) {
    if (m.role !== 'user') continue;
    for (const a of m.attachments ?? []) {
      if (used.has(a.file) || seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  }
  return out;
}
