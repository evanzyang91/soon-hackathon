// Left drawer: the project list with per-scene stage chips (new projects start in the project
// chat, chat-panel.ts). The open project's cast (one row per character: build detail, kind,
// fallback, the "High detail" rebuild button) is rendered by the Scene tab through `actorRow`.
import { api } from '@shared/api';
import type { ActorBuildStatus, ActorDetail, ProjectStatus } from '@shared/schema';
import { getHealth, listProjects, rebuildActor, retryStage } from './api';
import type { Director } from './director';
import { byId, h } from './dom';
import { projectPlan, sceneThumbs } from './references';

type SceneJob = ProjectStatus['scenes'][number];
const STAGES = ['parse', 'world', 'actors', 'tts', 'manifest'] as const;

export const HIGH_DETAIL_LABEL = 'High detail (~5 min per actor)';
export const HIGH_DETAIL_TIP =
  'LHM-1B + fine-tune against the reference. About 5 minutes and ~$0.20 per actor on Modal; the current build stays until the new one lands.';

/** "LEO" → "Leo" (screenplay names are upper case). */
export const displayName = (name: string) =>
  name.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Text, chip class and tooltip of a character's rebuild status (null = no rebuild yet). */
export function rebuildChip(a: ActorBuildStatus, now = Date.now()) {
  const r = a.rebuild;
  if (!r) return null;
  const what = r.detail === 'high' ? 'high detail' : 'standard';
  if (r.status === 'running' || r.status === 'pending') {
    const since = r.startedAt ? Date.parse(r.startedAt) : NaN;
    const base = r.detail === 'high' ? `rebuilding ${displayName(a.name)} · ~5 min` : `switching ${displayName(a.name)} to standard`;
    return {
      cls: 'running',
      text: Number.isFinite(since) ? `${base} · ${clock(now - since)}` : base,
      title: r.note ?? 'queued',
    };
  }
  if (r.status === 'done') return { cls: 'done', text: `${what} ✓`, title: r.note ?? '' };
  return { cls: 'failed', text: `${what} failed`, title: r.note ?? 'failed' };
}

export function sceneReady(job: SceneJob): boolean {
  const manifest = (job.stages as Partial<SceneJob['stages']>).manifest;
  return !!job.manifestUrl && (manifest?.status ?? 'done') === 'done';
}

function busy(p: ProjectStatus) {
  if (p.parse.status === 'pending' || p.parse.status === 'running') return true;
  if (p.actors?.some((a) => a.rebuild?.status === 'running')) return true;
  // a parsed draft waits for the director (its stages stay pending until /generate)
  if (p.draft) return false;
  return p.scenes.some((s) =>
    Object.values(s.stages).some((st) => st?.status === 'pending' || st?.status === 'running'),
  );
}

export interface ProjectsPanel {
  projects(): ProjectStatus[];
  /** The project of the open scene (null when none / not listed yet). */
  current(): ProjectStatus | null;
  /** Called after every refresh (polling, a rebuild, a new project). */
  onChange(fn: () => void): () => void;
  /** One cast row: name, detail chip, kind, fallback, rebuild status, High detail / use standard. */
  actorRow(p: ProjectStatus, a: ActorBuildStatus): HTMLElement;
  /** A scene's stage chips (failed / fallback ones retry on click), as in the scene rows. */
  chips(p: ProjectStatus, job: SceneJob): HTMLElement;
  /** Opens the project's first ready scene as soon as there is one (after Generate). */
  openWhenReady(projectId: string): void;
  /** Takes a status the chat got back (POST chat / generate) before the next poll. */
  upsert(p: ProjectStatus): void;
  /** Polls fast (1.5 s) while `fn` says so (a chat waiting for its plan or a running action). */
  pollFastWhile(fn: () => boolean): void;
  /** Clicking a project's name in the list (the chat switches to its thread). */
  onPick(fn: (projectId: string) => void): void;
  /** The project whose thread the chat shows (highlighted in the list). */
  setChatProject(projectId: string | null): void;
  refresh(): Promise<void>;
}

export interface ProjectsPanelOptions {
  /** Where the list comes from (the fake chat adds its own projects); default GET /api/projects. */
  list?: () => Promise<ProjectStatus[]>;
}

export function mountProjectsPanel(director: Director, opts: ProjectsPanelOptions = {}): ProjectsPanel {
  const list = byId('pp-list');
  const lister = opts.list ?? listProjects;
  let projects: ProjectStatus[] = [];
  let autoOpen: string | null = null;
  let chatProject: string | null = null;
  const fast = new Set<() => boolean>();
  const pickers = new Set<(id: string) => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let apiDown = false;
  let modalKeys: boolean | null = null;
  const rebuildErrors = new Map<string, string>();
  const listeners = new Set<() => void>();
  /** project:character → the actor detail last applied to the open scene (hot-swap trigger). */
  const applied = new Map<string, string>();
  void getHealth()
    .then((hlt) => {
      modalKeys = !!hlt.keys.modal;
      render();
    })
    .catch(() => {});

  const open = (p: ProjectStatus, job: SceneJob) => {
    const url = job.manifestUrl ?? api.manifest(p.id, job.sceneIndex);
    void director.openScene(p.id, job.sceneIndex, url);
  };

  const chip = (p: ProjectStatus, job: SceneJob, stage: (typeof STAGES)[number]) => {
    const st = (job.stages as Partial<SceneJob['stages']>)[stage];
    if (!st) return null;
    // done-but-fallback (mannequin / beeps while keys are set) can be retried to upgrade it
    const fallback = st.status === 'done' && /fallback/.test(st.note ?? '');
    const retryable = st.status === 'failed' || fallback;
    return h(
      'span',
      {
        class: `chip ${st.status}${fallback ? ' fallback' : ''}`,
        title: `${stage}: ${st.status}${st.note ? ` — ${st.note}` : ''}${retryable ? ' (click to retry)' : ''}`,
        'data-stage': stage,
        onclick: retryable
          ? (e: Event) => {
              e.stopPropagation();
              void retryStage(p.id, job.sceneIndex, stage).then(refresh, () => {});
            }
          : undefined,
      },
      stage,
    );
  };

  const chips = (p: ProjectStatus, job: SceneJob) =>
    h('span', { class: 'chips' }, ...STAGES.map((s) => chip(p, job, s)));

  const rebuild = (p: ProjectStatus, a: ActorBuildStatus, detail: ActorDetail) => {
    const key = `${p.id}:${a.characterId}`;
    rebuildErrors.delete(key);
    void rebuildActor(p.id, a.characterId, detail)
      .then(refresh)
      .catch((err: unknown) => {
        rebuildErrors.set(key, err instanceof Error ? err.message : String(err));
        render();
        for (const fn of listeners) fn();
      });
  };

  const actorRow = (p: ProjectStatus, a: ActorBuildStatus) => {
    const running = a.rebuild?.status === 'running' || a.rebuild?.status === 'pending';
    const chip = rebuildChip(a);
    const why = p.mock
      ? 'MOCK project: rebuilds need a live project'
      : modalKeys === false
        ? 'Modal keys are not set'
        : null;
    const error = rebuildErrors.get(`${p.id}:${a.characterId}`);
    const failed = a.rebuild?.status === 'failed';
    const kind = a.kind === 'splat-sequence' ? 'splat' : a.kind === 'glb-humanoid' ? 'mannequin' : 'not built';
    return h(
      'div',
      { class: 'actor-row', 'data-testid': 'actor-row', 'data-character': a.characterId },
      h('span', { class: 'actor-name', title: a.characterId }, displayName(a.name)),
      h(
        'span',
        {
          class: `chip detail ${a.detail}`,
          'data-testid': 'actor-detail',
          title: a.detail === 'high' ? 'LHM-1B + fine-tune against the reference' : 'LHM-500M (the standard build)',
        },
        a.detail,
      ),
      h('span', { class: 'actor-kind muted small' }, kind),
      a.fallback ? h('span', { class: 'chip done fallback', title: 'Offline stand-in; retry the actors stage to upgrade it' }, 'fallback') : null,
      chip
        ? h('span', { class: `chip ${chip.cls}`, 'data-testid': 'rebuild-status', title: chip.title }, chip.text)
        : null,
      a.detail !== 'high' || running || failed
        ? h(
            'button',
            {
              class: 'small',
              type: 'button',
              'data-testid': 'high-detail',
              title: why ? `${HIGH_DETAIL_TIP}\n(${why})` : HIGH_DETAIL_TIP,
              disabled: running || !!why,
              onclick: (e: Event) => {
                e.stopPropagation();
                rebuild(p, a, 'high');
              },
            },
            failed && a.rebuild?.detail === 'high' ? 'Retry high detail' : HIGH_DETAIL_LABEL,
          )
        : h(
            'button',
            {
              class: 'small link-ish',
              type: 'button',
              'data-testid': 'standard-detail',
              title: 'Switch back to the standard build (kept on disk; no GPU)',
              disabled: !!why,
              onclick: (e: Event) => {
                e.stopPropagation();
                rebuild(p, a, 'standard');
              },
            },
            'use standard',
          ),
      failed && a.rebuild?.note ? h('div', { class: 'error small actor-note' }, a.rebuild.note) : null,
      error ? h('div', { class: 'error small actor-note' }, error) : null,
    );
  };

  const render = () => {
    list.replaceChildren();
    if (apiDown) {
      list.append(h('div', { class: 'muted' }, 'Pipeline API unavailable — retrying…'));
      return;
    }
    if (!projects.length) {
      list.append(h('div', { class: 'muted' }, 'No projects yet. Paste a screenplay in the chat.'));
      return;
    }
    for (const p of projects) {
      const scenes = h('div', { class: 'scenes' });
      const plan = projectPlan(p, render);
      for (const job of p.scenes) {
        const ready = sceneReady(job);
        const current = director.projectId === p.id && director.sceneIndex === job.sceneIndex;
        scenes.append(
          h(
            'div',
            {
              class: `scene-row${ready ? ' ready' : ''}${current ? ' current' : ''}`,
              'data-testid': 'scene-row',
              'data-project': p.id,
              'data-scene': job.sceneIndex,
              title: ready ? 'Open scene' : 'Not ready yet',
              onclick: ready ? () => open(p, job) : undefined,
            },
            h('span', { class: 'scene-idx' }, job.sceneIndex + 1),
            h('span', { class: 'scene-slug', title: job.slug }, job.heading ?? job.slug),
            sceneThumbs(p.id, job.thumbnailUrl, plan?.scenes[job.sceneIndex]?.worldReference),
            chips(p, job),
          ),
        );
      }
      list.append(
        h(
          'div',
          { class: `project${chatProject === p.id ? ' chatting' : ''}`, 'data-testid': 'project', 'data-id': p.id },
          h(
            'div',
            {
              class: 'project-head',
              'data-testid': 'project-head',
              title: 'Open this project in the chat',
              onclick: () => {
                for (const fn of pickers) fn(p.id);
              },
            },
            h('strong', {}, p.title || p.id),
            p.draft ? h('span', { class: 'badge warn', title: 'Planned, not generated yet: Generate in the chat' }, 'DRAFT') : null,
            p.mock ? h('span', { class: 'badge' }, 'MOCK') : null,
            h('span', { class: `chip ${p.parse.status}`, title: p.parse.note ?? '' }, 'parse'),
          ),
          p.parse.status === 'failed' && p.parse.note
            ? h('div', { class: 'error small' }, p.parse.note)
            : null,
          scenes,
          p.actors?.length
            ? h(
                'div',
                { class: 'muted small project-cast', title: 'Builds and High detail: the Scene tab of an open scene' },
                `Cast: ${p.actors.map((a) => displayName(a.name)).join(', ')}`,
              )
            : null,
        ),
      );
    }
  };

  const refresh = async () => {
    try {
      projects = (await lister()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      apiDown = false;
    } catch {
      apiDown = true;
    }
    // a finished rebuild rewrote the manifests: swap that actor in the open scene
    const current = projects.find((x) => x.id === director.projectId);
    for (const a of current?.actors ?? []) {
      const key = `${current!.id}:${a.characterId}`;
      const sig = `${a.detail}:${a.rebuild?.status ?? ''}:${a.rebuild?.startedAt ?? ''}`;
      const prev = applied.get(key);
      applied.set(key, sig);
      if (prev !== undefined && prev !== sig && a.rebuild?.status === 'done') void director.refreshActors();
    }
    if (autoOpen) {
      const p = projects.find((x) => x.id === autoOpen);
      const job = p?.scenes.find(sceneReady);
      if (p && job) {
        autoOpen = null;
        open(p, job);
      }
    }
    render();
    for (const fn of listeners) fn();
  };

  const poll = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    await refresh();
    const hurry = apiDown || projects.some(busy) || !!autoOpen || [...fast].some((fn) => fn());
    timer = setTimeout(poll, hurry ? 1500 : 5000);
  };
  director.on((c) => {
    if (c === 'scene') render();
  });
  void poll();
  window.addEventListener('pagehide', () => timer && clearTimeout(timer));
  return {
    projects: () => projects,
    current: () => projects.find((p) => p.id === director.projectId) ?? null,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actorRow,
    chips,
    openWhenReady: (id) => {
      autoOpen = id;
      void poll();
    },
    upsert: (p) => {
      const i = projects.findIndex((x) => x.id === p.id);
      if (i >= 0) projects[i] = p;
      else projects = [p, ...projects];
      render();
      for (const fn of listeners) fn();
    },
    pollFastWhile: (fn) => {
      fast.add(fn);
    },
    onPick: (fn) => {
      pickers.add(fn);
    },
    setChatProject: (id) => {
      if (chatProject === id) return;
      chatProject = id;
      render();
    },
    refresh,
  };
}
