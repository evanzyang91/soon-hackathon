// One chat turn (POST /api/projects/:id/chat): store the director's message, ask the planner,
// apply what is free, store the answer. Turns of one project run one at a time, so a planner
// always reads the plan the previous turn left.
import { randomBytes } from 'node:crypto';
import type { Attachment, ChatMessage, ChatRequest, ProjectChat } from '../../../shared/chat.ts';
import type { ProjectStatus } from '../../../shared/schema.ts';
import { env } from '../../env.ts';
import { applyProposals, unassignedPhotos, type ChatHost } from './apply.ts';
import { checkDraft, type ChatContext } from './draft.ts';
import { planChat, ChatPlannerError, type ChatPlannerCall } from './planner.ts';
import { readAttachment } from './uploads.ts';

export class ChatRequestError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface ChatTurnOptions {
  /** Offline planner; default: a MOCK project, MOCK=1 or no Anthropic key. */
  mock?: boolean;
  /** Planner test seam. */
  call?: ChatPlannerCall;
  dryRun?: boolean;
}

export interface ChatTurnResult {
  chat: ProjectChat;
  status: ProjectStatus;
  /** Resolves when background work the turn started (a draft re-plan) has finished. */
  settled: Promise<void>;
}

const turnLocks = new WeakMap<object, Map<string, Promise<unknown>>>();
function serialized<T>(host: object, id: string, fn: () => Promise<T>): Promise<T> {
  let locks = turnLocks.get(host);
  if (!locks) turnLocks.set(host, (locks = new Map()));
  const prev = locks.get(id) ?? Promise.resolve();
  const p = prev.then(fn, fn);
  const tail = p.catch(() => {});
  locks.set(id, tail);
  void tail.then(() => {
    if (locks!.get(id) === tail) locks!.delete(id);
  });
  return p;
}

const msgId = () => `m-${randomBytes(5).toString('hex')}`;

export function chatTurn(
  host: ChatHost,
  id: string,
  req: ChatRequest,
  o: ChatTurnOptions = {},
): Promise<ChatTurnResult> {
  return serialized(host, id, () => runTurn(host, id, req, o));
}

async function runTurn(
  host: ChatHost,
  id: string,
  req: ChatRequest,
  o: ChatTurnOptions,
): Promise<ChatTurnResult> {
  const st = await host.getProject(id);
  if (!st) throw new ChatRequestError(404, 'no such project');
  const text = req.text.trim();
  const projectDir = host.projectDir(id);
  const attachments: Attachment[] = [];
  for (const ref of req.attachments ?? []) {
    const a = await readAttachment(projectDir, ref.id);
    if (!a)
      throw new ChatRequestError(
        400,
        `no upload ${ref.id} in this project (POST /api/projects/${id}/uploads first)`,
      );
    const hint = ref.hint?.trim().slice(0, 120);
    if (!attachments.some((x) => x.id === a.id)) attachments.push(hint ? { ...a, hint } : a);
  }
  if (!text && !attachments.length)
    throw new ChatRequestError(400, 'say something or attach a photo');

  const before = await host.chat.read(id);
  const user: ChatMessage = {
    id: msgId(),
    at: new Date().toISOString(),
    role: 'user',
    text,
    ...(attachments.length ? { attachments } : {}),
  };
  await host.chat.appendMessages(id, [user]);
  await host.logEvent(
    id,
    `chat: director: "${text.slice(0, 200)}"${attachments.length ? ` + ${attachments.length} photo(s) ${attachments.map((a) => a.id).join(', ')}` : ''}`,
  );

  const answer = async (m: Omit<ChatMessage, 'id' | 'at' | 'role'>) => {
    const msg: ChatMessage = { id: msgId(), at: new Date().toISOString(), role: 'assistant', ...m };
    await host.chat.appendMessages(id, [msg]);
    return msg;
  };

  const plan = await host.getPlan(id);
  if (st.parse.status !== 'done' || !plan) {
    const why =
      st.parse.status === 'failed'
        ? `The screenplay could not be planned (${st.parse.note ?? 'unknown error'}). Retry the parse or paste the screenplay again.`
        : 'I am still reading the screenplay; send that again in a moment.';
    await answer({ text: why, source: 'pipeline' });
    return {
      chat: await host.chat.read(id),
      status: (await host.getProject(id))!,
      settled: Promise.resolve(),
    };
  }

  const ctx: ChatContext = {
    plan,
    status: st,
    screenplay: await host.readScreenplay(id).catch(() => ''),
    history: before.messages,
    message: { text, attachments },
    earlier: unassignedPhotos(before.messages, plan).filter(
      (a) => !attachments.some((x) => x.id === a.id),
    ),
  };
  const mock = o.mock ?? (st.mock || env.mock || (!env.keys.anthropic && !o.call));
  let settled: Promise<void> = Promise.resolve();
  try {
    const r = await planChat({
      ctx,
      projectDir,
      mock,
      call: o.call,
      log: (m) => void host.logEvent(id, `chat: ${m}`),
    });
    const { proposals, problems } = checkDraft(r.draft, ctx);
    const applied = await applyProposals(host, id, proposals, {
      dryRun: o.dryRun ?? env.marbleDryRun,
    });
    const extra = [
      problems.length ? `Not done: ${problems.join('; ')}.` : '',
      r.unseen.length ? `I could not look at ${r.unseen.join('; ')}.` : '',
    ].filter(Boolean);
    const msg = await answer({
      text: [r.draft.reply.trim(), ...extra].filter(Boolean).join(' '),
      ...(applied.actions.length ? { actions: applied.actions } : {}),
      ...(r.source === 'claude' ? { costUsd: Math.round(r.usage.costUsd * 1e6) / 1e6 } : {}),
      source: r.source,
    });
    if (problems.length) await host.logEvent(id, `chat: not applied — ${problems.join('; ')}`);
    if (applied.after)
      settled = applied
        .after(msg.id)
        .catch((e) => console.error(`[${id}] chat follow-up failed:`, e));
  } catch (e) {
    const why =
      e instanceof ChatPlannerError
        ? e.message
        : `the planner is unreachable (${(e as Error).message.slice(0, 160)})`;
    await host.logEvent(id, `chat: planner FAILED ${why}`);
    await answer({ text: `Sorry, ${why}. Nothing was changed.`, source: mock ? 'mock' : 'claude' });
  }
  return { chat: await host.chat.read(id), status: (await host.getProject(id))!, settled };
}
