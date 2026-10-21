// <project>/chat.json = ProjectChat (shared/chat.ts). Same shape as EditsStore (edits.ts): reads
// answer an empty thread while the file is absent; every write is a read-modify-write under a
// per-project in-process lock, atomic on disk, and bumps the revision. The owner (ProjectStore)
// mirrors each new revision into ProjectStatus.chatRevision so the laptop knows to refetch.
//
// The revision is bumped by action updates too (a confirmed world regeneration going running →
// done), not only by appends: the laptop's only signal is the revision.
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  ChatMessage,
  emptyChat,
  ProjectChat,
  type ChatAction,
} from '../../../shared/chat.ts';
import { exists, readJson, writeJsonAtomic } from '../fsutil.ts';

export const CHAT_FILE = 'chat.json';

export class ChatNotFound extends Error {
  readonly status = 404;
}

export const newMessageId = () => `m-${randomBytes(5).toString('hex')}`;
export const newActionId = () => `a-${randomBytes(5).toString('hex')}`;

export type ActionPatch = Partial<Pick<ChatAction, 'status' | 'note' | 'summary'>>;

export class ChatStore {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    /** Project directory for an id (throws for an invalid id). */
    private readonly projectDir: (id: string) => string,
    /** Called after every write with the new revision (mirrors ProjectStatus.chatRevision). */
    private readonly onRevision: (id: string, revision: number) => Promise<void> | void = () => {},
  ) {}

  path(id: string): string {
    return join(this.projectDir(id), CHAT_FILE);
  }

  /** The thread, or an empty one (revision 0) when nothing was said yet. */
  async read(id: string): Promise<ProjectChat> {
    const dir = this.projectDir(id);
    if (!(await exists(dir))) throw new ChatNotFound('no such project');
    const raw = await readJson(join(dir, CHAT_FILE)).catch((e) => {
      console.warn(`[chat] ${id}: unreadable ${CHAT_FILE}, starting an empty thread`, e);
      return undefined;
    });
    if (raw === undefined) return emptyChat();
    const parsed = ProjectChat.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[chat] ${id}: invalid ${CHAT_FILE}, starting an empty thread`);
      return emptyChat();
    }
    return parsed.data;
  }

  async appendMessages(id: string, messages: ChatMessage[]): Promise<ProjectChat> {
    const valid = messages.map((m) => ChatMessage.parse(m));
    return this.update(id, (chat) => ({ ...chat, messages: [...chat.messages, ...valid] }));
  }

  /** Patches one action of one message; resolves with the thread and the patched action. */
  async updateAction(
    id: string,
    messageId: string,
    actionId: string,
    patch: ActionPatch,
  ): Promise<{ chat: ProjectChat; action: ChatAction }> {
    let updated: ChatAction | undefined;
    const chat = await this.update(id, (c) => {
      const msg = c.messages.find((m) => m.id === messageId);
      const i = msg?.actions?.findIndex((a) => a.id === actionId) ?? -1;
      if (!msg?.actions || i < 0) throw new ChatNotFound(`no action ${actionId} in message ${messageId}`);
      const prev = msg.actions[i]!;
      const next = { ...prev, ...patch } as ChatAction;
      if (patch.note === undefined && 'note' in patch) delete (next as { note?: string }).note;
      msg.actions[i] = updated = next;
      return c;
    });
    return { chat, action: updated! };
  }

  /** Read-modify-write under the per-project lock; stored with revision + 1. */
  update(id: string, fn: (chat: ProjectChat) => ProjectChat | Promise<ProjectChat>): Promise<ProjectChat> {
    const key = this.path(id);
    const run = async () => {
      const current = await this.read(id);
      const next = ProjectChat.parse(await fn(structuredClone(current)));
      const saved: ProjectChat = { ...next, version: 1, revision: current.revision + 1 };
      await writeJsonAtomic(key, saved);
      await this.onRevision(id, saved.revision);
      return saved;
    };
    const prev = this.locks.get(key) ?? Promise.resolve();
    const p = prev.then(run, run);
    const tail = p.catch(() => {});
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return p;
  }
}
