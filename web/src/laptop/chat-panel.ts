// Project chat (docs/PLAN-v2.md "Project chat"): the screenplay box is the first message of a
// conversation about the project. Send plans it (a draft: nothing is generated yet) and the plan
// card shows the scenes and the cast; the director amends it in words, attaches photos of people
// and places, and presses Generate. After generation the same thread continues: changes rebuild an
// actor, re-voice lines, or wait for a confirmed world regeneration.
//
// Where it lives: with no scene open the chat fills the viewport (big and readable, the first
// thing a new director sees); once a scene opens it moves into the projects drawer above the list,
// and the drawer widens over the viewport while the chat has focus, so the four right tabs and the
// viewport keep their room. One DOM node moves between the two places, so a half-typed message,
// its attachments and the scroll position survive the move.
//
// The thread is server state (GET chat, refetched when ProjectStatus.chatRevision changes, on the
// projects panel's polling); what the panel adds locally is the optimistic user message and the
// "thinking" placeholder while a request runs, and — for a server that has no thread for a project
// (one created by the pre-chat Generate) — the screenplay bubble and the plan card from plan.json.
import type { Attachment, ChatAction, ChatMessage, ProjectChat } from '@shared/chat';
import type { Character, ProjectStatus, ScenePlan, ScreenplayPlan } from '@shared/schema';
import { api } from '@shared/api';
import { prepareImage, type ChatApi, type ChatResponse, type PreparedImage } from './chat-client';
import {
  ACTION_LABEL,
  STATUS_LABEL,
  excerpt,
  findCharacter,
  fmtUsd,
  hasRunning,
  heightLabel,
  hintLabel,
  lastPlanCardId,
  patchDiff,
  planSummary,
  startedGeneration,
  targetOptions,
  type TargetOption,
} from './chat-model';
import type { Director } from './director';
import { byId, h } from './dom';
import { displayName, sceneReady, type ProjectsPanel } from './projects-panel';
import { SAMPLE_SCREENPLAY, SAMPLE_TITLE } from './sample';
import { storageGet, storageSet } from './storage';
import './chat-panel.css';

const CHAT_KEY = 'previz:chat-project';
/** ChatRequest allows 12 attachments per message. */
const MAX_ATTACHMENTS = 12;
const PAPERCLIP =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m20.5 11.2-8 8a5.2 5.2 0 0 1-7.4-7.4l8.4-8.4a3.4 3.4 0 0 1 4.9 4.9l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/></svg>';
const EXAMPLES = [
  'make Theo older and taller',
  "Maya's second line is 'I let it go.'",
  'scene 2 is a diner',
  'a photo + “this is Maya”',
];

/** An image in the composer: prepared (≤ 1600 px PNG) as soon as it is attached. */
interface Draft {
  key: string;
  name: string;
  url: string;
  image: PreparedImage | null;
  error: string | null;
  /** ChatRequest hint: "" | "character:<id>" | "scene:<n>" */
  hint: string;
}

interface Thread {
  chat: ProjectChat | null;
  plan: ScreenplayPlan | null;
  /** chatRevision the plan was last fetched for (-1: never) */
  planTried: number;
  planStamp: number;
  loadingChat: boolean;
  loadingPlan: boolean;
}

/** The optimistic user message + thinking text while a request runs. */
interface Pending {
  text: string;
  images: { url: string; hint: string }[];
  status: string;
}

export interface ChatPanel {
  /** The project whose thread is shown (null: a new project). */
  readonly projectId: string | null;
  select(projectId: string | null): void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function mountChatPanel(
  director: Director,
  projects: ProjectsPanel,
  chat: ChatApi,
): ChatPanel {
  const left = byId('left');
  const projectsCard = byId('pp-card');
  const home = h('div', { id: 'chat-home', 'data-testid': 'chat-home' });
  byId('hud-empty').after(home);

  // ---- DOM ------------------------------------------------------------------------------------
  const root = h('section', {
    class: 'card chat',
    tabindex: '-1',
    'data-testid': 'chat',
    'aria-label': 'Project chat',
  });
  const headTitle = h('span', { class: 'chat-title', 'data-testid': 'chat-title' });
  const headBadges = h('span', { class: 'chat-badges' });
  const newBtn = h(
    'button',
    {
      type: 'button',
      class: 'small',
      'data-testid': 'chat-new',
      title: 'Start a new project (paste another screenplay)',
    },
    '+ New',
  );
  const thread = h('div', {
    class: 'chat-thread',
    role: 'log',
    'aria-live': 'polite',
    'data-testid': 'chat-thread',
  });
  const chipsRow = h('div', { class: 'chat-attachments', 'data-testid': 'chat-attachments' });
  const titleInput = h('input', {
    class: 'chat-title-input',
    placeholder: 'Title (optional)',
    'data-testid': 'title',
    title: 'Project title (optional)',
  });
  const sampleBtn = h(
    'button',
    {
      type: 'button',
      class: 'small',
      'data-testid': 'sample',
      title: 'Fill in the sample screenplay (The Last Bus)',
    },
    'Sample',
  );
  const newRow = h('div', { class: 'chat-newrow' }, titleInput, sampleBtn);
  const input = h('textarea', {
    class: 'chat-input',
    rows: 3,
    spellcheck: 'false',
    'data-testid': 'screenplay',
    'aria-label': 'Message',
  });
  const fileInput = h('input', {
    type: 'file',
    accept: 'image/png,image/jpeg,image/webp,image/*',
    multiple: true,
    hidden: true,
    'data-testid': 'chat-file',
  });
  const attachBtn = h('button', {
    type: 'button',
    class: 'icon-btn',
    'data-testid': 'chat-attach',
    title: 'Attach photos of the people or places (or drop / paste them here)',
  });
  attachBtn.innerHTML = PAPERCLIP;
  const hint = h('span', { class: 'chat-hint muted small' });
  const generateBtn = h(
    'button',
    { type: 'button', class: 'generate', 'data-testid': 'generate' },
    'Generate',
  );
  const sendBtn = h(
    'button',
    { type: 'button', class: 'primary', 'data-testid': 'chat-send' },
    'Send',
  );
  const composer = h(
    'div',
    { class: 'chat-composer' },
    newRow,
    chipsRow,
    input,
    h(
      'div',
      { class: 'chat-tools' },
      attachBtn,
      fileInput,
      hint,
      h('span', { class: 'spacer' }),
      generateBtn,
      sendBtn,
    ),
  );
  const dropZone = h('div', { class: 'chat-drop', hidden: true }, 'Drop photos to attach');
  root.append(
    h(
      'div',
      { class: 'chat-head' },
      h('h2', {}, 'Chat'),
      headTitle,
      headBadges,
      h('span', { class: 'spacer' }),
      newBtn,
    ),
    thread,
    composer,
    dropZone,
  );

  // ---- state ----------------------------------------------------------------------------------
  let selected: string | null = null;
  let drafts: Draft[] = [];
  let menuFor: string | null = null;
  let creating = false;
  let newError: string | null = null;
  let docked: boolean | null = null;
  let keySeq = 0;
  const threads = new Map<string, Thread>();
  const pending = new Map<string, Pending>();
  const errors = new Map<string, string>();
  /** screenplays sent from this page (the first bubble when the server has no thread) */
  const screenplays = new Map<string, string>();
  /** photos attached to the first message: sent once the draft is parsed */
  const firstAttach = new Map<string, Draft[]>();
  const generateAfterFirst = new Set<string>();
  const generating = new Set<string>();
  const confirming = new Set<string>();
  const expanded = new Set<string>();

  const thr = (id: string): Thread => {
    let t = threads.get(id);
    if (!t)
      threads.set(
        id,
        (t = {
          chat: null,
          plan: null,
          planTried: -1,
          planStamp: 0,
          loadingChat: false,
          loadingPlan: false,
        }),
      );
    return t;
  };
  const project = () =>
    selected ? (projects.projects().find((p) => p.id === selected) ?? null) : null;
  const sending = () => creating || (!!selected && pending.has(selected));
  const preparing = () => drafts.some((d) => !d.image && !d.error);
  const parsing = (p: ProjectStatus) =>
    p.parse.status === 'pending' || p.parse.status === 'running';

  // ---- placement: the empty viewport, or the drawer once a scene is open ------------------------
  const place = () => {
    const homeMode = !director.runtime && !director.loading && !director.error;
    if (docked === !homeMode) return;
    docked = !homeMode;
    if (homeMode) home.append(root);
    else left.insertBefore(root, projectsCard);
    home.hidden = !homeMode;
    document.body.classList.toggle('chat-docked', docked);
    if (!docked) document.body.classList.remove('chat-wide');
    grow();
    renderAll(true);
  };

  // ---- loading ----------------------------------------------------------------------------------
  const loadChat = async (id: string) => {
    const t = thr(id);
    if (t.loadingChat) return;
    t.loadingChat = true;
    try {
      const c = await chat.getChat(id);
      if (!t.chat || c.revision >= t.chat.revision) t.chat = c;
    } catch (err) {
      errors.set(id, `Could not load the chat: ${message(err)}`);
    } finally {
      t.loadingChat = false;
      renderAll();
    }
  };
  const loadPlan = async (id: string, rev: number) => {
    const t = thr(id);
    if (t.loadingPlan) return;
    t.loadingPlan = true;
    t.planTried = rev;
    try {
      t.plan = await chat.getPlan(id);
      t.planStamp++;
    } catch (err) {
      errors.set(id, `Could not load the plan: ${message(err)}`);
    } finally {
      t.loadingPlan = false;
      renderAll();
      void flushFirst(id);
    }
  };
  /** Refetch what the project's status says changed; called after every projects refresh. */
  const sync = () => {
    const p = project();
    if (p) {
      const t = thr(p.id);
      const rev = p.chatRevision ?? 0;
      if (p.parse.status === 'done' && t.planTried !== rev) void loadPlan(p.id, rev);
      // an empty thread (revision 0, or a server without chat) is not fetched at all
      if (rev > 0 && !pending.has(p.id) && (t.chat?.revision !== rev || hasRunning(t.chat)))
        void loadChat(p.id);
      if (p.parse.status === 'failed' && firstAttach.delete(p.id)) generateAfterFirst.delete(p.id);
      void flushFirst(p.id);
    }
    renderAll();
  };

  const accept = (id: string, res: ChatResponse) => {
    const t = thr(id);
    if (!t.chat || res.chat.revision >= t.chat.revision) t.chat = res.chat;
    projects.upsert(res.status);
  };

  // ---- actions ------------------------------------------------------------------------------------
  const select = (id: string | null) => {
    if (selected === id) return;
    selected = id;
    menuFor = null;
    newError = null;
    storageSet(CHAT_KEY, id);
    projects.setChatProject(id);
    sync();
    renderAll(true);
  };

  /** character hints picked before the plan existed name the cue; the plan knows the id */
  const resolveHint = (hintValue: string, plan: ScreenplayPlan | null) => {
    const [kind, ref = ''] = hintValue.split(':');
    if (kind !== 'character' || !plan) return hintValue;
    const c = findCharacter(plan, ref);
    return c ? `character:${c.id}` : hintValue;
  };

  const sendMessage = async (id: string, text: string, images: Draft[]): Promise<boolean> => {
    const t = thr(id);
    const p: Pending = {
      text,
      images: images.map((d) => ({ url: d.url, hint: d.hint })),
      status: 'Thinking…',
    };
    pending.set(id, p);
    errors.delete(id);
    renderAll(true);
    try {
      const uploaded: Attachment[] = [];
      for (const [i, d] of images.entries()) {
        p.status = `Uploading photo ${i + 1} of ${images.length}…`;
        renderAll();
        uploaded.push(await chat.uploadImage(id, d.image!.blob, d.image!.name));
      }
      p.status = 'Thinking…';
      renderAll();
      const refs = uploaded.map((u, i) => {
        const value = resolveHint(images[i]!.hint, t.plan);
        return value ? { id: u.id, hint: value } : { id: u.id };
      });
      const res = await chat.send(id, { text, ...(refs.length ? { attachments: refs } : {}) });
      accept(id, res);
      if (startedGeneration(res.chat.messages.at(-1))) projects.openWhenReady(id);
      // the thread shows the server's copies now; the local previews can go
      setTimeout(() => images.forEach((d) => URL.revokeObjectURL(d.url)), 60_000);
      return true;
    } catch (err) {
      errors.set(id, `Not sent: ${message(err)}`);
      return false;
    } finally {
      pending.delete(id);
      renderAll(true);
    }
  };

  const startGenerate = async (id: string) => {
    if (generating.has(id)) return;
    generating.add(id);
    errors.delete(id);
    renderAll();
    try {
      projects.upsert(await chat.generate(id));
      projects.openWhenReady(id);
    } catch (err) {
      errors.set(id, `Generate failed: ${message(err)}`);
    } finally {
      generating.delete(id);
      renderAll();
    }
  };

  const confirmAction = async (id: string, messageId: string, actionId: string) => {
    confirming.add(actionId);
    errors.delete(id);
    renderAll();
    try {
      accept(id, await chat.confirm(id, messageId, actionId));
    } catch (err) {
      errors.set(id, `Not confirmed: ${message(err)}`);
    } finally {
      confirming.delete(actionId);
      renderAll();
    }
  };

  /** The first message's photos go out as the second message, once the plan exists (uploads need the project). */
  const flushing = new Set<string>();
  const flushFirst = async (id: string) => {
    const queued = firstAttach.get(id);
    const p = projects.projects().find((x) => x.id === id);
    if (
      !queued ||
      !p ||
      p.parse.status !== 'done' ||
      !thr(id).plan ||
      flushing.has(id) ||
      pending.has(id)
    )
      return;
    flushing.add(id);
    firstAttach.delete(id);
    const ok = await sendMessage(id, '', queued);
    if (ok && generateAfterFirst.delete(id)) await startGenerate(id);
    // not sent: the photos go back into the composer (with their targets) to try again
    if (!ok && selected === id && !drafts.length) {
      drafts = queued;
      renderComposer();
    }
    flushing.delete(id);
  };

  const createNew = async (mode: 'send' | 'generate', screenplay: string) => {
    if (!screenplay) {
      newError = 'Paste a screenplay first (or press Sample).';
      renderAll();
      input.focus();
      return;
    }
    const images = drafts.filter((d) => d.image);
    // the pre-chat Generate (everything at once) unless photos have to reach the plan first
    const draft = mode === 'send' || images.length > 0;
    creating = true;
    newError = null;
    renderAll();
    try {
      const title = titleInput.value.trim() || undefined;
      const st = draft
        ? await chat.createDraft(screenplay, title)
        : await chat.createProject(screenplay, title);
      screenplays.set(st.id, screenplay);
      input.value = '';
      titleInput.value = '';
      drafts = [];
      grow();
      if (images.length) {
        firstAttach.set(st.id, images);
        if (mode === 'generate') generateAfterFirst.add(st.id);
      }
      projects.upsert(st);
      select(st.id);
      if (!draft) projects.openWhenReady(st.id);
      else void projects.refresh();
    } catch (err) {
      newError = `Could not create the project: ${message(err)}`;
    } finally {
      creating = false;
      renderAll(true);
    }
  };

  const submit = async (mode: 'send' | 'generate') => {
    if (sending()) return;
    if (preparing()) {
      flash('Wait a moment: the photos are still being prepared.');
      return;
    }
    const text = input.value.trim();
    const p = project();
    if (!p) return createNew(mode, text);
    const images = drafts.filter((d) => d.image);
    if (text || images.length) {
      if (parsing(p)) return flash('The plan is still being read; send this in a moment.');
      const keep = { text: input.value, drafts };
      input.value = '';
      drafts = drafts.filter((d) => !d.image);
      grow();
      const ok = await sendMessage(p.id, text, images);
      if (!ok && !input.value.trim()) {
        // give the message back so it can be sent again
        input.value = keep.text;
        drafts = keep.drafts;
        grow();
      }
      if (!ok) return renderAll();
    } else if (mode === 'send') return;
    const now = project();
    if (mode === 'generate' && now?.draft) await startGenerate(now.id);
    input.focus();
  };

  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  const flash = (text: string) => {
    hint.textContent = text;
    hint.classList.add('warn');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashTimer = null;
      renderComposer();
    }, 3500);
  };

  // ---- attachments --------------------------------------------------------------------------------
  const addFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (drafts.length >= MAX_ATTACHMENTS) {
        flash(`At most ${MAX_ATTACHMENTS} photos per message.`);
        break;
      }
      if (f.type && !f.type.startsWith('image/')) {
        flash(`${f.name || 'That file'} is not an image.`);
        continue;
      }
      const d: Draft = {
        key: `d${++keySeq}`,
        name: f.name || 'Pasted image',
        url: URL.createObjectURL(f),
        image: null,
        error: null,
        hint: '',
      };
      drafts.push(d);
      void prepareImage(f, f.name || 'pasted.png').then(
        (img) => {
          d.image = img;
          URL.revokeObjectURL(d.url);
          d.url = URL.createObjectURL(img.blob);
          renderComposer();
        },
        (err: unknown) => {
          d.error = message(err);
          renderComposer();
        },
      );
    }
    renderComposer();
  };
  const removeDraft = (d: Draft) => {
    drafts = drafts.filter((x) => x !== d);
    URL.revokeObjectURL(d.url);
    if (menuFor === d.key) menuFor = null;
    renderComposer();
  };

  // ---- render ---------------------------------------------------------------------------------------
  const renderHead = () => {
    const p = project();
    headTitle.textContent = p ? p.title || p.id : 'New project';
    headTitle.title = p ? p.id : '';
    const state = !p
      ? null
      : p.parse.status === 'failed'
        ? h('span', { class: 'badge bad' }, 'PARSE FAILED')
        : parsing(p)
          ? h('span', { class: 'badge' }, 'PLANNING')
          : p.draft
            ? h(
                'span',
                {
                  class: 'badge warn',
                  title: 'Planned, not generated: nothing has been spent yet',
                },
                'DRAFT',
              )
            : null;
    headBadges.replaceChildren(
      ...[
        state,
        chat.fake
          ? h(
              'span',
              {
                class: 'badge warn',
                title: 'In-memory chat (?fakechat=1): nothing reaches the server',
              },
              'FAKE CHAT',
            )
          : null,
      ].filter((x): x is HTMLSpanElement => !!x),
    );
    newBtn.hidden = !p;
  };

  const img = (src: string, cls: string, title = '') =>
    h('img', { class: cls, src, alt: '', title, loading: 'lazy', draggable: 'false' });

  const userBubble = (
    p: ProjectStatus | null,
    m: Pick<ChatMessage, 'id' | 'text' | 'attachments'>,
    first: boolean,
    plan: ScreenplayPlan | null,
  ) => {
    const lines = m.text.split('\n');
    const long = lines.length > 14 || m.text.length > 1200;
    const open = expanded.has(m.id);
    const shown = long && !open ? `${lines.slice(0, 8).join('\n').slice(0, 700)}\n…` : m.text;
    return h(
      'div',
      { class: `msg user${first ? ' script' : ''}`, 'data-testid': 'msg-user' },
      m.text ? h('div', { class: 'msg-text' }, shown) : null,
      long
        ? h(
            'button',
            {
              type: 'button',
              class: 'link-btn small',
              onclick: () => {
                if (open) expanded.delete(m.id);
                else expanded.add(m.id);
                renderThread();
              },
            },
            open ? 'Show less' : `Show all ${lines.length} lines`,
          )
        : null,
      m.attachments?.length
        ? h(
            'div',
            { class: 'msg-images' },
            ...m.attachments.map((a) =>
              h(
                'figure',
                { class: 'msg-image' },
                img(p ? chat.fileUrl(p.id, a.file) : a.file, 'msg-thumb', a.name ?? ''),
                a.hint ? h('figcaption', {}, hintLabel(a.hint, plan) ?? a.hint) : null,
              ),
            ),
          )
        : null,
    );
  };

  const charRow = (p: ProjectStatus, c: Character) =>
    h(
      'div',
      { class: 'plan-char', 'data-testid': 'plan-character', 'data-character': c.id },
      c.referenceImage
        ? img(
            chat.fileUrl(p.id, c.referenceImage),
            'plan-avatar',
            'Reference photo: the actor is built from it',
          )
        : h(
            'span',
            {
              class: 'plan-avatar mono',
              title: 'No reference photo: the actor is generated from the description',
            },
            displayName(c.name).charAt(0),
          ),
      h(
        'div',
        { class: 'plan-main' },
        h(
          'div',
          { class: 'plan-line' },
          h('b', {}, displayName(c.name)),
          h(
            'span',
            {
              class: 'plan-tag',
              'data-testid': 'plan-height',
              title: 'Standing height: the actor is scaled to it',
            },
            heightLabel(c),
          ),
          h(
            'span',
            { class: 'plan-tag voice', title: `Voice (${c.voice.gender})` },
            `voice ${c.voice.id}`,
          ),
          c.referenceImage ? h('span', { class: 'plan-tag ref' }, 'photo') : null,
        ),
        h('div', { class: 'plan-desc', title: c.description }, excerpt(c.description, 150)),
      ),
    );

  const sceneRow = (p: ProjectStatus, s: ScenePlan) => {
    const job = p.scenes.find((j) => j.sceneIndex === s.index);
    const ready = !!job && sceneReady(job);
    const ref = s.worldReference ? chat.fileUrl(p.id, s.worldReference.file) : null;
    const thumb = job?.thumbnailUrl ?? ref;
    return h(
      'div',
      {
        class: `plan-scene${ready ? ' ready' : ''}${director.projectId === p.id && director.sceneIndex === s.index ? ' current' : ''}`,
        'data-testid': 'plan-scene',
        'data-scene': s.index,
        title: ready ? 'Open this scene' : `World prompt: ${s.worldPrompt}`,
        onclick: ready
          ? () =>
              void director.openScene(p.id, s.index, job.manifestUrl ?? api.manifest(p.id, s.index))
          : undefined,
      },
      h(
        'span',
        { class: 'plan-thumb-wrap' },
        thumb
          ? img(thumb, 'plan-thumb')
          : h('span', { class: 'plan-thumb empty' }, String(s.index + 1)),
        ref && thumb === ref
          ? h(
              'span',
              { class: 'plan-thumb-tag' },
              s.worldReference!.isPano ? '360° photo' : 'photo',
            )
          : null,
      ),
      h(
        'div',
        { class: 'plan-main' },
        h(
          'div',
          { class: 'plan-line' },
          h('span', { class: 'plan-num' }, s.index + 1),
          h('b', { class: 'plan-heading' }, s.heading),
          h('span', { class: `plan-tod ${s.timeOfDay}` }, s.timeOfDay),
        ),
        h('div', { class: 'plan-desc', title: s.worldPrompt }, excerpt(s.worldPrompt, 160)),
        job && !p.draft ? projects.chips(p, job) : null,
      ),
    );
  };

  const planCard = (p: ProjectStatus, plan: ScreenplayPlan) => {
    const n = plan.scenes.length;
    const busy = generating.has(p.id) || pending.has(p.id);
    return h(
      'div',
      { class: 'plan-card', 'data-testid': 'plan-card' },
      h(
        'div',
        { class: 'plan-head' },
        h('strong', {}, plan.title),
        h(
          'span',
          { class: 'muted small' },
          `${n} scene${n === 1 ? '' : 's'} · ${plan.characters.length} character${plan.characters.length === 1 ? '' : 's'}`,
        ),
      ),
      h(
        'div',
        { class: 'plan-cols' },
        h(
          'div',
          { class: 'plan-section' },
          h('h3', {}, 'Cast'),
          ...plan.characters.map((c) => charRow(p, c)),
        ),
        h(
          'div',
          { class: 'plan-section' },
          h('h3', {}, 'Scenes'),
          ...plan.scenes.map((s) => sceneRow(p, s)),
        ),
      ),
      p.draft
        ? h(
            'div',
            { class: 'plan-foot' },
            h(
              'button',
              {
                type: 'button',
                class: 'generate big',
                'data-testid': 'plan-generate',
                disabled: busy,
                title: 'Build the worlds (Marble), the actors and the voices',
                onclick: () => void startGenerate(p.id),
              },
              generating.has(p.id) ? 'Starting…' : `Generate ${n} scene${n === 1 ? '' : 's'}`,
            ),
            h(
              'span',
              { class: 'muted small' },
              'Worlds, actors and voices. Change anything first: say it, or attach photos.',
            ),
          )
        : null,
    );
  };

  const actionCard = (
    p: ProjectStatus,
    m: ChatMessage,
    a: ChatAction,
    atts: Map<string, Attachment>,
  ) => {
    const cost = 'cost' in a ? a.cost : undefined;
    const effect = a.type === 'plan-patch' ? a.effect : undefined;
    const diff = patchDiff(a);
    const att = 'attachmentId' in a ? atts.get(a.attachmentId) : undefined;
    const busy = confirming.has(a.id);
    return h(
      'div',
      {
        class: `action-card ${a.status}`,
        'data-testid': 'action-card',
        'data-type': a.type,
        'data-status': a.status,
      },
      h(
        'div',
        { class: 'action-head' },
        h('span', { class: 'action-kind' }, ACTION_LABEL[a.type]),
        h(
          'span',
          { class: `chat-status ${a.status}`, 'data-testid': 'action-status' },
          STATUS_LABEL[a.status],
        ),
        h('span', { class: 'spacer' }),
        cost ? h('span', { class: 'action-cost', title: 'Time and Marble credits' }, cost) : null,
      ),
      h(
        'div',
        { class: 'action-body' },
        att ? img(chat.fileUrl(p.id, att.file), 'action-thumb', att.name ?? '') : null,
        h(
          'div',
          { class: 'action-main' },
          h('div', { class: 'action-summary' }, a.summary),
          diff ? h('div', { class: 'action-diff' }, diff) : null,
          effect ? h('div', { class: 'action-effect' }, `→ ${effect}`) : null,
          a.note ? h('div', { class: 'action-note' }, a.note) : null,
        ),
      ),
      a.status === 'needs-confirm'
        ? h(
            'div',
            { class: 'action-confirm' },
            h(
              'button',
              {
                type: 'button',
                class: 'primary',
                'data-testid': 'action-confirm',
                disabled: busy,
                title: `${a.summary}${cost ? ` (${cost})` : ''}`,
                onclick: () => void confirmAction(p.id, m.id, a.id),
              },
              busy ? 'Starting…' : 'Confirm',
            ),
            h('span', { class: 'muted small' }, 'Nothing is spent until you confirm.'),
          )
        : null,
    );
  };

  const assistantBubble = (
    p: ProjectStatus,
    m: ChatMessage,
    plan: ScreenplayPlan | null,
    latestPlan: string | null,
    atts: Map<string, Attachment>,
  ) =>
    h(
      'div',
      { class: 'msg assistant', 'data-testid': 'msg-assistant' },
      h(
        'div',
        { class: 'msg-meta' },
        h('span', { class: 'msg-who' }, 'Previz'),
        m.source && m.source !== 'local'
          ? h('span', { class: 'msg-source', title: 'Which planner answered' }, m.source)
          : null,
        m.costUsd
          ? h('span', { title: 'Planner and vision cost of this answer' }, fmtUsd(m.costUsd))
          : null,
      ),
      m.text ? h('div', { class: 'msg-text' }, m.text) : null,
      m.planCard
        ? !plan
          ? h('div', { class: 'muted small' }, 'Loading the plan…')
          : m.id === latestPlan
            ? planCard(p, plan)
            : h(
                'div',
                { class: 'plan-compact muted small' },
                `Plan: ${planSummary(plan)} The current plan is further down.`,
              )
        : null,
      ...(m.actions ?? []).map((a) => actionCard(p, m, a, atts)),
    );

  const thinking = (text: string) =>
    h(
      'div',
      { class: 'msg assistant thinking', 'data-testid': 'chat-thinking' },
      h('div', { class: 'msg-meta' }, h('span', { class: 'msg-who' }, 'Previz')),
      h('div', { class: 'msg-text' }, text, h('span', { class: 'dots' }, h('i'), h('i'), h('i'))),
    );

  const errorBubble = (text: string, onClose: () => void) =>
    h(
      'div',
      { class: 'msg assistant error-msg', 'data-testid': 'chat-error', role: 'alert' },
      h('div', { class: 'msg-text' }, text),
      h('button', { type: 'button', class: 'icon', title: 'Dismiss', onclick: onClose }, '×'),
    );

  /** The thread as shown: the server's messages, or the local first exchange when it has none. */
  const messagesOf = (p: ProjectStatus, t: Thread): ChatMessage[] => {
    const out = [...(t.chat?.messages ?? [])];
    const sp = screenplays.get(p.id);
    if (!out.length && sp)
      out.push({ id: 'local-screenplay', at: p.createdAt, role: 'user', text: sp });
    if (t.plan && !out.some((m) => m.planCard)) {
      const at = out.findIndex((m) => m.role === 'user') + 1;
      out.splice(at, 0, {
        id: 'local-plan',
        at: p.createdAt,
        role: 'assistant',
        text: planSummary(t.plan),
        planCard: true,
        source: 'local',
      });
    }
    return out;
  };

  const hero = () =>
    h(
      'div',
      { class: 'chat-hero', 'data-testid': 'chat-hero' },
      h('h1', {}, 'Previz Stage'),
      h(
        'p',
        {},
        'Paste a screenplay to start a project. I plan the scenes and the cast; change anything in words, attach photos of the people and places, then Generate.',
      ),
      h(
        'div',
        { class: 'chat-examples' },
        ...EXAMPLES.map((x) => h('span', { class: 'chat-example' }, x)),
      ),
    );

  let lastKey = '';
  const renderThread = (force = false) => {
    const p = project();
    const t = p ? thr(p.id) : null;
    const key = JSON.stringify([
      selected,
      docked,
      p,
      t?.chat?.revision,
      t?.chat?.messages.length,
      t?.planStamp,
      p ? pending.get(p.id) : null,
      p ? errors.get(p.id) : null,
      newError,
      creating,
      [...expanded],
      [...confirming],
      [...generating],
      director.projectId,
      director.sceneIndex,
    ]);
    if (!force && key === lastKey) return;
    lastKey = key;
    const atEnd = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
    const top = thread.scrollTop;
    const items: (HTMLElement | null)[] = [];
    root.classList.toggle('blank', !p && !creating && !newError);
    if (!p) {
      items.push(hero());
      if (creating) items.push(thinking('Reading the screenplay'));
      if (newError) items.push(errorBubble(newError, () => ((newError = null), renderThread())));
    } else {
      const msgs = messagesOf(p, t!);
      const latest = lastPlanCardId(msgs);
      const atts = new Map<string, Attachment>();
      for (const m of msgs) for (const a of m.attachments ?? []) atts.set(a.id, a);
      const firstUser = msgs.find((m) => m.role === 'user')?.id;
      for (const m of msgs)
        items.push(
          m.role === 'user'
            ? userBubble(p, m, m.id === firstUser && m.text.length > 200, t!.plan)
            : assistantBubble(p, m, t!.plan, latest, atts),
        );
      const local = pending.get(p.id);
      if (local)
        items.push(
          userBubble(
            null,
            {
              id: 'local-pending',
              text: local.text,
              attachments: local.images.map((im, i) => ({
                id: `local-${i}`,
                kind: 'image',
                file: im.url,
                width: 1,
                height: 1,
                bytes: 0,
                ...(im.hint ? { hint: im.hint } : {}),
              })),
            },
            false,
            t!.plan,
          ),
          thinking(local.status.replace(/…$/, '')),
        );
      else if (parsing(p)) items.push(thinking('Reading the screenplay'));
      if (p.parse.status === 'failed')
        items.push(
          errorBubble(
            `The screenplay could not be planned: ${p.parse.note ?? 'parse failed'}`,
            () => {},
          ),
        );
      const err = errors.get(p.id);
      if (err) items.push(errorBubble(err, () => (errors.delete(p.id), renderThread())));
    }
    thread.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
    thread.scrollTop = force || atEnd ? thread.scrollHeight : top;
  };

  const optionButton = (o: TargetOption, d: Draft) =>
    h(
      'button',
      {
        type: 'button',
        role: 'option',
        class: `att-option${o.value === d.hint ? ' on' : ''}`,
        'aria-selected': String(o.value === d.hint),
        'data-testid': 'attach-target-option',
        'data-value': o.value,
        onclick: () => {
          d.hint = o.value;
          menuFor = null;
          renderComposer();
        },
      },
      o.label,
    );

  const targetMenu = (d: Draft) => {
    const opts = targetOptions(
      project() ? thr(selected!).plan : null,
      project() ? '' : input.value,
    );
    const group = (g: TargetOption['group'], label: string) => {
      const list = opts.filter((o) => o.group === g);
      return list.length
        ? [h('div', { class: 'att-group' }, label), ...list.map((o) => optionButton(o, d))]
        : [];
    };
    return h(
      'div',
      {
        class: 'att-menu',
        role: 'listbox',
        'data-testid': 'attach-target-menu',
        'aria-label': 'What the photo shows',
      },
      h('div', { class: 'att-menu-title' }, 'This photo is…'),
      optionButton(opts[0]!, d),
      ...group('character', 'A character · the actor is built from it'),
      ...group('scene', 'A scene’s set · the world is built from it'),
      opts.length === 1
        ? h(
            'div',
            { class: 'muted small att-empty' },
            'Characters and scenes show up once the plan exists; you can also say “this is Maya”.',
          )
        : null,
    );
  };

  const chipEl = (d: Draft) => {
    const plan = selected ? thr(selected).plan : null;
    const label = hintLabel(resolveHint(d.hint, plan), plan);
    return h(
      'div',
      { class: `att-chip${d.error ? ' bad' : ''}`, 'data-testid': 'attachment-chip' },
      d.error ? null : img(d.url, 'att-thumb'),
      h(
        'div',
        { class: 'att-main' },
        h(
          'div',
          { class: 'att-name', title: d.name },
          d.image ? `${d.name} · ${d.image.width}×${d.image.height}` : d.name,
        ),
        d.error
          ? h('div', { class: 'error small att-error' }, d.error)
          : !d.image
            ? h('div', { class: 'muted small' }, 'Preparing…')
            : h(
                'button',
                {
                  type: 'button',
                  class: `att-target${d.hint ? ' set' : ''}`,
                  'data-testid': 'attach-target',
                  'aria-haspopup': 'listbox',
                  'aria-expanded': String(menuFor === d.key),
                  title: 'Who or what the photo shows (or say it in the message)',
                  onclick: () => {
                    menuFor = menuFor === d.key ? null : d.key;
                    renderComposer();
                  },
                },
                label ? `For ${label}` : 'For: no target',
                h('span', { class: 'caret' }, '▾'),
              ),
      ),
      h(
        'button',
        {
          type: 'button',
          class: 'icon att-remove',
          title: 'Remove this photo',
          onclick: () => removeDraft(d),
        },
        '×',
      ),
      menuFor === d.key ? targetMenu(d) : null,
    );
  };

  const renderComposer = () => {
    const p = project();
    const isNew = !p;
    const busy = sending();
    // the screenplay box is taller than the message box: re-measure when the mode flips
    if (root.classList.contains('new') !== isNew) {
      root.classList.toggle('new', isNew);
      grow();
    }
    newRow.hidden = !isNew;
    chipsRow.replaceChildren(...drafts.map(chipEl));
    chipsRow.hidden = !drafts.length;
    input.placeholder = isNew
      ? 'Paste a screenplay (Fountain or plain text)…'
      : docked
        ? 'Ask for a change, or attach a photo…'
        : p.draft || parsing(p)
          ? 'Change the plan in words: “make Theo taller”, “scene 2 is a diner”… or attach a photo'
          : 'Ask for a change: “Maya’s second line is ‘I let it go.’”, “scene 2 is a diner”… or attach a photo';
    // read-only, not disabled: a disabled field drops focus (and the widened drawer with it)
    input.readOnly = busy;
    input.classList.toggle('busy', busy);
    sendBtn.disabled = busy || preparing();
    sendBtn.title = isNew
      ? 'Plan the scenes and the cast first; nothing is generated yet (⌘Enter)'
      : 'Send (Enter)';
    const draftLike = isNew || !!p.draft;
    generateBtn.hidden = !draftLike;
    generateBtn.disabled = busy || preparing() || (!!p && (generating.has(p.id) || parsing(p)));
    generateBtn.title = isNew
      ? 'Plan and build everything now: worlds, actors and voices (skips the conversation)'
      : 'Build the worlds, actors and voices (sends what you typed first)';
    if (!flashTimer) {
      hint.classList.remove('warn');
      hint.textContent = isNew
        ? '⌘Enter sends · drop or paste photos'
        : 'Enter sends · Shift+Enter new line · drop or paste photos';
    }
  };

  const renderAll = (force = false) => {
    renderHead();
    renderThread(force);
    renderComposer();
  };

  // ---- composer behaviour -----------------------------------------------------------------------
  const grow = () => {
    const max = docked ? 200 : Math.max(180, Math.round(window.innerHeight * 0.38));
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight + 2, max)}px`;
  };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // a screenplay is typed with Enter; once there is a project, Enter sends (Shift+Enter: newline)
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      void submit('send');
    } else if (project() && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      void submit('send');
    }
  });
  input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!e.clipboardData?.types.includes('text/plain')) e.preventDefault();
    addFiles(files);
  });
  sendBtn.addEventListener('click', () => void submit('send'));
  generateBtn.addEventListener('click', () => void submit('generate'));
  attachBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    addFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });
  sampleBtn.addEventListener('click', () => {
    titleInput.value = SAMPLE_TITLE;
    input.value = SAMPLE_SCREENPLAY;
    grow();
    input.focus();
  });
  newBtn.addEventListener('click', () => {
    select(null);
    input.focus();
  });
  // the target menu closes on a click elsewhere and on Escape
  document.addEventListener('pointerdown', (e) => {
    if (!menuFor) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest('.att-menu, .att-target')) return;
    menuFor = null;
    renderComposer();
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuFor) {
      menuFor = null;
      renderComposer();
      e.stopPropagation();
    }
  });

  // drag and drop: the whole chat (and the empty viewport around it) takes photos
  const hasFiles = (e: DragEvent) =>
    !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  for (const el of [home, root]) {
    el.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || (el === home && docked)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth++;
      dropZone.hidden = false;
    });
    el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer!.dropEffect = 'copy';
    });
    el.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      e.stopPropagation();
      if (--dragDepth <= 0) {
        dragDepth = 0;
        dropZone.hidden = true;
      }
    });
    el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      dropZone.hidden = true;
      addFiles([...e.dataTransfer!.files]);
    });
  }
  // a photo dropped anywhere else must not navigate away from the director
  for (const ev of ['dragover', 'drop'] as const)
    window.addEventListener(ev, (e) => {
      if (hasFiles(e)) e.preventDefault();
    });

  // the docked chat widens over the viewport while it is in use, until something outside the
  // drawer is used (focus alone would collapse it whenever a pressed button turns disabled)
  const setWide = (on: boolean) => document.body.classList.toggle('chat-wide', on && !!docked);
  root.addEventListener('focusin', () => setWide(true));
  root.addEventListener('pointerdown', () => setWide(true));
  for (const ev of ['pointerdown', 'focusin'] as const)
    document.addEventListener(ev, (e) => {
      if (!left.contains(e.target as Node | null)) setWide(false);
    });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menuFor && docked) {
      setWide(false);
      (document.activeElement as HTMLElement | null)?.blur();
    }
  });

  // ---- wiring -------------------------------------------------------------------------------------
  projects.onPick((id) => select(id));
  projects.pollFastWhile(() => {
    const p = project();
    if (!p) return false;
    return pending.has(p.id) || parsing(p) || firstAttach.has(p.id) || hasRunning(thr(p.id).chat);
  });
  let restored = false;
  projects.onChange(() => {
    if (!restored && projects.projects().length) {
      restored = true;
      // a draft in progress comes back after a reload (a live project reopens with its scene)
      const id = storageGet<string>(CHAT_KEY);
      const p = id ? projects.projects().find((x) => x.id === id) : undefined;
      if (p?.draft && selected === null && !input.value.trim()) select(p.id);
    }
    sync();
  });
  director.on((c) => {
    if (c === 'scene' || c === 'loading') place();
    if (c === 'scene') {
      const id = director.projectId;
      // the open scene's project is the thread, unless a new screenplay is being written
      if (id && id !== selected && !(selected === null && (input.value.trim() || drafts.length)))
        select(id);
      else renderThread();
    }
  });
  window.addEventListener('resize', grow);

  place();
  renderAll(true);
  return {
    get projectId() {
      return selected;
    },
    select,
  };
}
