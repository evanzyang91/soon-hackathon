// In-memory ChatApi for `?fakechat=1` and unit tests: the server's MOCK chat planner rules
// (`mockChatReply`), draft projects whose parse is the real offline parser, simulated generation
// and world regeneration. With a real server next to it, the fake also adopts real projects (an
// open scene) so the chat can be tried on a live set; nothing it does reaches the server.
import type { Attachment, ChatAction, ChatMessage, ChatRequest, ProjectChat } from '@shared/chat';
import type { ProjectStatus, ScreenplayPlan } from '@shared/schema';
import { ensurePrepared, type ChatApi, type ChatResponse } from './chat-client';
import { DEFAULT_HEIGHT_M, findCharacter, planSummary } from './chat-model';
import { displayName } from './projects-panel';

type SceneJob = ProjectStatus['scenes'][number];

/** What a world regeneration costs (shown on the confirm card). */
export const REGEN_COST = '~5 min · 1,580 Marble credits';
export const FALLBACK_REPLY =
  'I can change characters, lines and scenes, take reference photos, and start generation.';
export const VOICE_IDS = ['nova', 'shimmer', 'coral', 'sage', 'onyx', 'ash', 'echo', 'ballad', 'alloy', 'fable'];

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const QO = `["'“‘]`;
const QC = `["'”’]`;
const END = String.raw`\s*[.!]?\s*$`;

export interface RuleInput {
  plan: ScreenplayPlan;
  /** Generated (not a draft): changes rebuild / re-voice, worlds need a confirmed regeneration. */
  live: boolean;
  text: string;
  /** The message's attachments, each with the director's hint. */
  attachments: Attachment[];
  newId?: () => string;
}

export interface RuleResult {
  reply: string;
  actions: ChatAction[];
  plan: ScreenplayPlan;
  /** The draft's generation starts. */
  generate: boolean;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The MOCK planner rules (WP4 implements the same on the server). */
export function mockChatReply(input: RuleInput): RuleResult {
  let n = 0;
  const newId = input.newId ?? (() => `a${++n}`);
  const plan = structuredClone(input.plan);
  const { live } = input;
  const text = input.text.trim();
  const actions: ChatAction[] = [];
  const notes: string[] = [];
  let generate = false;

  const name = (id: string) => displayName(plan.characters.find((c) => c.id === id)?.name ?? id);
  const linesOf = (characterId: string) =>
    plan.scenes.flatMap((s) => [...s.dialogue].sort((a, b) => a.order - b.order).filter((d) => d.characterId === characterId));
  const sceneByWord = (word: string) => {
    const w = word.toLowerCase();
    return plan.scenes.find((s) => s.heading.toLowerCase().includes(w) || s.slug.includes(w));
  };
  const rebuild = (characterId: string, why: string) => {
    if (live) actions.push({ type: 'rebuild-actor', id: newId(), characterId, summary: `Rebuilding ${name(characterId)} ${why}`, status: 'applied' });
  };
  const regen = (index: number, what: string) =>
    actions.push({ type: 'regenerate-world', id: newId(), sceneIndex: index, summary: `Regenerate scene ${index + 1}'s world ${what}`, status: 'needs-confirm', cost: REGEN_COST });

  // ---- attachments: whose photo, which set ------------------------------------------------------
  for (const a of input.attachments) {
    const [kind, ref = ''] = (a.hint ?? '').split(':');
    let character = kind === 'character' ? findCharacter(plan, ref) : undefined;
    let scene = kind === 'scene' ? plan.scenes[Number(ref) - 1] : undefined;
    if (!a.hint) {
      const who = /\bthis is\s+(?:the\s+)?([\p{L}][\p{L}'’-]*)/iu.exec(text)?.[1];
      const where = /\buse this for\s+(?:scene\s+(\d+)|(?:the\s+)?([\p{L}-]+))/iu.exec(text);
      if (who) character = findCharacter(plan, who);
      if (!character && who) scene = sceneByWord(who);
      if (where) scene = where[1] ? plan.scenes[Number(where[1]) - 1] : sceneByWord(where[2]!);
    }
    if (character) {
      character.referenceImage = a.file;
      actions.push({
        type: 'character-reference',
        id: newId(),
        characterId: character.id,
        attachmentId: a.id,
        summary: `${name(character.id)} is built from this photo`,
        status: 'applied',
      });
      rebuild(character.id, 'from the photo');
    } else if (scene) {
      const isPano = a.width >= a.height * 1.9;
      scene.worldReference = { file: a.file, isPano };
      actions.push({
        type: 'world-reference',
        id: newId(),
        sceneIndex: scene.index,
        attachmentId: a.id,
        isPano,
        summary: `Scene ${scene.index + 1} (${scene.heading}) is built from this ${isPano ? 'panorama' : 'photo'}`,
        status: 'applied',
        ...(live ? { note: 'Takes effect when the world is regenerated.' } : {}),
      });
      if (live) regen(scene.index, 'from the photo');
    } else notes.push(`I couldn't tell who or what ${a.name ?? 'the photo'} shows: pick a target on its chip, or say “this is Maya” / “use this for scene 2”.`);
  }

  // ---- text ---------------------------------------------------------------------------------------
  const patch = (target: string, field: string, before: unknown, after: unknown, summary: string, effect?: string) =>
    actions.push({ type: 'plan-patch', id: newId(), target, field, before, after, summary, status: 'applied', ...(effect ? { effect } : {}) });
  const revoice = (lineIds: string[]) => {
    if (live && lineIds.length)
      actions.push({ type: 'revoice', id: newId(), lineIds, summary: `Re-voicing ${lineIds.length} line${lineIds.length === 1 ? '' : 's'}`, status: 'applied' });
  };
  const setLine = (lineId: string, words: string) => {
    for (const s of plan.scenes) {
      const line = s.dialogue.find((d) => d.id === lineId);
      if (!line) continue;
      const before = line.text;
      line.text = words;
      patch(`line:${lineId}`, 'text', before, words, `${name(line.characterId)}'s line in scene ${s.index + 1} now reads “${words}”`, live ? 're-voices 1 line' : undefined);
      revoice([lineId]);
      return true;
    }
    return false;
  };

  let matched = false;
  const byName = [...plan.characters].sort((a, b) => b.name.length - a.name.length);
  // make <Name> taller / shorter / older / <adjectives>
  for (const c of byName) {
    const m = new RegExp(`^make\\s+(?:${escapeRe(c.name)}|${escapeRe(c.id)})\\s+(.+?)${END}`, 'i').exec(text);
    if (!m) continue;
    matched = true;
    const parts = m[1]!.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean);
    const adjectives: string[] = [];
    for (const part of parts) {
      const hm = /^(?:a (?:bit|little) |much |slightly )?(taller|shorter)$/i.exec(part);
      if (hm) {
        const before = c.heightMeters ?? DEFAULT_HEIGHT_M;
        const after = Math.round(Math.min(2.3, Math.max(0.9, before + (hm[1]!.toLowerCase() === 'taller' ? 0.1 : -0.1))) * 100) / 100;
        c.heightMeters = after;
        patch(`character:${c.id}`, 'heightMeters', before, after, `${name(c.id)} is now ${after.toFixed(2)} m`, live ? `rebuilds ${name(c.id)}` : undefined);
      } else adjectives.push(part);
    }
    if (adjectives.length) {
      const before = c.description;
      c.description = `${before.replace(/[\s.]+$/, '')}. ${cap(adjectives.join(', '))}.`;
      patch(`character:${c.id}`, 'description', before, c.description, `${name(c.id)} is now ${adjectives.join(' and ')}`, live ? `rebuilds ${name(c.id)}` : undefined);
    }
    rebuild(c.id, `(${parts.join(', ')})`);
    break;
  }

  if (!matched) {
    // line <id>: '…'
    const byId = new RegExp(`^line\\s+([\\w-]+)\\s*(?::|is|should be|becomes|=)?\\s*${QO}(.+)${QC}${END}`, 'i').exec(text);
    // <Name>'s line N is '…' / <Name>'s second line is '…'
    const nth = new RegExp(`^(.+?)['’]s\\s+(?:line\\s+(\\d+)|(${ORDINALS.join('|')}|last)\\s+line)\\s*(?:is|should be|becomes|=|:)\\s*${QO}(.+)${QC}${END}`, 'i').exec(text);
    // <Name> says '…'
    const says = new RegExp(`^(.+?)\\s+says\\s*:?\\s*${QO}(.+)${QC}${END}`, 'i').exec(text);
    const voice = /^(.+?)['’]s\s+voice\b(.*)$/i.exec(text);
    const scene = /^scene\s+(\d+)\s+(?:is|should be|becomes)\s+(.+?)\s*[.!]?\s*$/i.exec(text);
    if (byId) {
      matched = setLine(byId[1]!, byId[2]!);
      if (!matched) notes.push(`There is no line ${byId[1]}.`);
      matched = true;
    } else if (nth || says) {
      matched = true;
      const c = findCharacter(plan, (nth ?? says)![1]!);
      if (!c) notes.push(`I don't know ${(nth ?? says)![1]}; the characters are ${plan.characters.map((x) => displayName(x.name)).join(', ')}.`);
      else {
        const lines = linesOf(c.id);
        const k = nth ? (nth[2] ? Number(nth[2]) : nth[3]!.toLowerCase() === 'last' ? lines.length : ORDINALS.indexOf(nth[3]!.toLowerCase()) + 1) : 1;
        const line = lines[k - 1];
        if (line) setLine(line.id, (nth ? nth[4] : says![2])!);
        else notes.push(`${name(c.id)} has ${lines.length} line${lines.length === 1 ? '' : 's'}.`);
      }
    } else if (voice) {
      const c = findCharacter(plan, voice[1]!);
      const id = VOICE_IDS.find((v) => new RegExp(`\\b${v}\\b`, 'i').test(voice[2]!));
      if (c) {
        matched = true;
        if (!id) notes.push(`Pick one of the voices: ${VOICE_IDS.join(', ')}.`);
        else {
          const before = c.voice.id;
          c.voice = { ...c.voice, id };
          patch(`character:${c.id}`, 'voice.id', before, id, `${name(c.id)} now speaks with the ${id} voice`, live ? `re-voices ${name(c.id)}'s lines` : undefined);
          revoice(linesOf(c.id).map((l) => l.id));
        }
      }
    } else if (scene) {
      matched = true;
      const s = plan.scenes[Number(scene[1]) - 1];
      if (!s) notes.push(`There are ${plan.scenes.length} scenes.`);
      else {
        const words = scene[2]!;
        const before = s.worldPrompt;
        s.worldPrompt = `${cap(words)}. ${before}`.slice(0, 600);
        patch(`scene:${s.index + 1}`, 'worldPrompt', before, s.worldPrompt, `Scene ${s.index + 1} is now ${words}`, live ? 'needs a new world' : 'the world is generated from it');
        if (live) regen(s.index, `as ${words}`);
      }
    }
  }

  if (!matched && !actions.length && /\b(generate|go ahead|build it|start)\b/i.test(text)) {
    matched = true;
    if (live) notes.push('This project is already generated. Tell me what to change and I rebuild what it touches.');
    else {
      generate = true;
      actions.push({ type: 'generate', id: newId(), summary: `Generating ${plan.scenes.length} scenes: worlds, actors and voices`, status: 'applied' });
    }
  }

  // the cards carry the details; the reply says what happened in a sentence
  const confirm = actions.some((a) => a.status === 'needs-confirm');
  const applied = actions.filter((a) => a.status === 'applied');
  let reply = generate
    ? `${applied[0]!.summary}. The first scene opens as soon as it is ready.`
    : applied.length === 1 && !confirm
      ? `${applied[0]!.summary}.`
      : applied.length
        ? `Done: ${applied.length} change${applied.length === 1 ? '' : 's'}.`
        : '';
  if (confirm) reply += `${reply ? ' ' : ''}The new world waits for your go (${REGEN_COST}).`;
  if (notes.length) reply += `${reply ? ' ' : ''}${notes.join(' ')}`;
  if (!reply) reply = FALLBACK_REPLY;
  return { reply, actions, plan, generate };
}

// ---- FakeChatApi --------------------------------------------------------------------------------

export interface FakeOptions {
  /** The offline parser (server/pipeline/fountain.ts mockPlan in the browser; any plan in tests). */
  makePlan(screenplay: string, title?: string): ScreenplayPlan | Promise<ScreenplayPlan>;
  /** Image preparation before "upload" (default: chat-client's canvas PNG). */
  prepare?(image: Blob, name?: string): Promise<{ blob: Blob; name: string; width?: number; height?: number }>;
  /** A real server whose projects are listed and adopted when the chat opens one. */
  real?: Pick<ChatApi, 'listProjects' | 'getPlan' | 'fileUrl'> | null;
  /** "Thinking" time of POST chat, ms. */
  latencyMs?: number;
  /** One simulated pipeline step, ms. */
  stepMs?: number;
}

interface FakeProject {
  status: ProjectStatus;
  plan: ScreenplayPlan | null;
  chat: ProjectChat;
  uploads: Map<string, Attachment>;
  /** upload file → object URL */
  urls: Map<string, string>;
  /** a real project the fake took over (its status comes from the server) */
  adopted: boolean;
  /** scene indexes whose world the fake is "regenerating" */
  regenerating: Set<number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clone = <T>(v: T): T => structuredClone(v);

export class FakeChatApi implements ChatApi {
  readonly fake = true;
  private projects = new Map<string, FakeProject>();
  private seq = 0;

  constructor(private opts: FakeOptions) {}

  private now = () => new Date().toISOString();
  private id = (p: string) => `${p}${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  private get latency() {
    return this.opts.latencyMs ?? 700;
  }
  private get step() {
    return this.opts.stepMs ?? 900;
  }

  private append(p: FakeProject, m: Omit<ChatMessage, 'id' | 'at'>) {
    const msg: ChatMessage = { id: this.id('m'), at: this.now(), ...m };
    p.chat.messages.push(msg);
    this.bump(p);
    return msg;
  }
  private bump(p: FakeProject) {
    p.chat.revision++;
    p.status.chatRevision = p.chat.revision;
  }
  private response(p: FakeProject): ChatResponse {
    return { chat: clone(p.chat), status: clone(this.statusOf(p)) };
  }
  private statusOf(p: FakeProject): ProjectStatus {
    if (!p.regenerating.size) return p.status;
    const s = clone(p.status);
    for (const job of s.scenes)
      if (p.regenerating.has(job.sceneIndex)) job.stages.world = { status: 'running', note: 'fake chat: regenerating' };
    return s;
  }

  private async project(id: string): Promise<FakeProject> {
    const p = this.projects.get(id);
    if (p) return p;
    const real = this.opts.real;
    const status = real ? (await real.listProjects().catch(() => [])).find((x) => x.id === id) : undefined;
    if (!real || !status) throw new Error(`no such project (fake chat): ${id}`);
    // adopt: the real plan, a thread that starts with its plan card; the project is live
    const plan = status.parse.status === 'done' ? await real.getPlan(id).catch(() => null) : null;
    const adopted: FakeProject = {
      status: { ...status, draft: false },
      plan,
      chat: { version: 1, revision: 0, messages: [] },
      uploads: new Map(),
      urls: new Map(),
      adopted: true,
      regenerating: new Set(),
    };
    this.projects.set(id, adopted);
    if (plan) this.append(adopted, { role: 'assistant', text: planSummary(plan), planCard: true, source: 'mock' });
    return adopted;
  }

  async listProjects(): Promise<ProjectStatus[]> {
    const real = this.opts.real ? await this.opts.real.listProjects().catch(() => []) : [];
    const out = real.map((s) => {
      const p = this.projects.get(s.id);
      if (!p) return s;
      p.status = { ...s, draft: false, chatRevision: p.chat.revision };
      return clone(this.statusOf(p));
    });
    for (const p of this.projects.values()) if (!p.adopted) out.push(clone(this.statusOf(p)));
    return out;
  }

  async getPlan(id: string) {
    const p = await this.project(id);
    if (!p.plan) throw new Error('not parsed yet (fake chat)');
    return clone(p.plan);
  }

  fileUrl(id: string, file: string) {
    const url = this.projects.get(id)?.urls.get(file);
    if (url) return url;
    return this.opts.real ? this.opts.real.fileUrl(id, file) : file;
  }

  async getChat(id: string) {
    return clone((await this.project(id)).chat);
  }

  async uploadImage(id: string, image: File | Blob, name?: string): Promise<Attachment> {
    const p = await this.project(id);
    const prep = this.opts.prepare ?? ensurePrepared;
    const ready = await prep(image, name ?? (image instanceof File ? image.name : undefined));
    const key = this.id('u').padEnd(16, '0').slice(0, 16);
    const att: Attachment = {
      id: key,
      kind: 'image',
      file: `uploads/${key}.png`,
      name: ready.name,
      width: ('width' in ready && ready.width) || 1,
      height: ('height' in ready && ready.height) || 1,
      bytes: ready.blob.size,
    };
    p.uploads.set(att.id, att);
    if (typeof URL.createObjectURL === 'function') p.urls.set(att.file, URL.createObjectURL(ready.blob));
    return clone(att);
  }

  private create(screenplay: string, title: string | undefined, draft: boolean) {
    const id = this.id('fake-');
    const status: ProjectStatus = {
      id,
      title: title || 'Untitled',
      createdAt: this.now(),
      mock: true,
      parse: { status: 'running' },
      scenes: [],
      draft,
      chatRevision: 0,
    };
    const p: FakeProject = { status, plan: null, chat: { version: 1, revision: 0, messages: [] }, uploads: new Map(), urls: new Map(), adopted: false, regenerating: new Set() };
    this.projects.set(id, p);
    this.append(p, { role: 'user', text: screenplay });
    void (async () => {
      await sleep(this.step);
      try {
        const plan = await this.opts.makePlan(screenplay, title);
        p.plan = plan;
        p.status.title = title || plan.title;
        p.status.parse = { status: 'done' };
        p.status.scenes = plan.scenes.map((s) => ({
          sceneIndex: s.index,
          slug: s.slug,
          heading: s.heading,
          stages: {
            parse: { status: 'done' },
            world: { status: 'pending' },
            actors: s.characterIds.length ? { status: 'pending' } : { status: 'skipped', note: 'no characters' },
            tts: s.dialogue.length ? { status: 'pending' } : { status: 'skipped', note: 'no dialogue' },
            manifest: { status: 'pending' },
          },
        }));
        this.append(p, { role: 'assistant', text: planSummary(plan), planCard: true, source: 'mock' });
        if (!draft) this.runGeneration(p);
      } catch (err) {
        p.status.parse = { status: 'failed', note: err instanceof Error ? err.message : String(err) };
      }
    })();
    return clone(status);
  }

  // attachments cannot exist before the project does (uploads are per project), so the ids are
  // ignored here as on the server; the panel sends them as the first chat message instead
  async createDraft(screenplay: string, title?: string) {
    return this.create(screenplay, title, true);
  }

  async createProject(screenplay: string, title?: string) {
    return this.create(screenplay, title, false);
  }

  /** world / actors / tts run, then the manifest; a fake project has nothing to open. */
  private runGeneration(p: FakeProject) {
    p.status.draft = false;
    const set = (job: SceneJob, stage: keyof SceneJob['stages'], status: 'running' | 'done', note?: string) => {
      if (job.stages[stage].status === 'skipped') return;
      job.stages[stage] = { status, ...(note ? { note } : {}) };
    };
    p.status.scenes.forEach((job, i) => {
      void (async () => {
        await sleep(this.step * i * 0.5);
        for (const st of ['world', 'actors', 'tts'] as const) set(job, st, 'running');
        await sleep(this.step);
        set(job, 'tts', 'done');
        await sleep(this.step);
        set(job, 'actors', 'done', 'mannequin (fake chat)');
        await sleep(this.step);
        set(job, 'world', 'done');
        set(job, 'manifest', 'done', 'fake chat: nothing to open');
      })();
    });
  }

  async generate(id: string) {
    const p = await this.project(id);
    if (p.status.draft && p.status.parse.status === 'done') this.runGeneration(p);
    return clone(this.statusOf(p));
  }

  async send(id: string, req: ChatRequest): Promise<ChatResponse> {
    const p = await this.project(id);
    if (!p.plan) throw new Error('The plan is not ready yet.');
    const attachments = (req.attachments ?? []).map((r) => {
      const a = p.uploads.get(r.id);
      if (!a) throw new Error(`unknown attachment ${r.id} (HTTP 400)`);
      return { ...a, ...(r.hint ? { hint: r.hint } : {}) };
    });
    this.append(p, { role: 'user', text: req.text, ...(attachments.length ? { attachments } : {}) });
    await sleep(this.latency);
    const live = !p.status.draft;
    const out = mockChatReply({ plan: p.plan, live, text: req.text, attachments, newId: () => this.id('a') });
    p.plan = out.plan;
    if (out.generate) this.runGeneration(p);
    this.append(p, { role: 'assistant', text: out.reply, actions: out.actions, source: 'mock', costUsd: 0 });
    return this.response(p);
  }

  async confirm(id: string, messageId: string, actionId: string): Promise<ChatResponse> {
    const p = await this.project(id);
    const action = p.chat.messages.find((m) => m.id === messageId)?.actions?.find((a) => a.id === actionId);
    if (!action) throw new Error('no such action (HTTP 404)');
    if (action.status !== 'needs-confirm') return this.response(p);
    action.status = 'running';
    this.bump(p);
    const index = 'sceneIndex' in action ? action.sceneIndex : null;
    if (index != null) p.regenerating.add(index);
    void (async () => {
      await sleep(this.step * 4);
      action.status = 'done';
      action.note = 'New world in place (fake chat: nothing was generated).';
      if (index != null) p.regenerating.delete(index);
      this.bump(p);
    })();
    return this.response(p);
  }
}

/** The fake the laptop uses for `?fakechat=1`: the real offline parser, real projects adopted. */
export function createFakeChatApi(real: ChatApi): FakeChatApi {
  return new FakeChatApi({
    // the offline parser is plain TS; only the fake pulls it into the page
    makePlan: async (text, title) => (await import('../../../server/pipeline/fountain.ts')).mockPlan(text, { title }),
    real,
  });
}
