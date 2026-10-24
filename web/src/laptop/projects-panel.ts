// Left drawer: screenplay input → POST /api/projects and the project list with per-scene stage
// chips. The open project's cast (one row per character: build detail, kind, fallback, the
// "High detail" rebuild button) is rendered by the Scene tab through `actorRow`.
import { api } from '@shared/api';
import type { ActorBuildStatus, ActorDetail, ProjectStatus } from '@shared/schema';
import {
  buildRoomWorld,
  createProject,
  getHealth,
  getRoomCapture,
  listProjects,
  rebuildActor,
  retryStage,
  type RoomCaptureStatus,
} from './api';
import type { Director } from './director';
import { byId, h } from './dom';
import { SAMPLE_SCREENPLAY, SAMPLE_TITLE } from './sample';

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
  refresh(): Promise<void>;
}

export function mountProjectsPanel(director: Director): ProjectsPanel {
  const title = byId<HTMLInputElement>('pp-title');
  const text = byId<HTMLTextAreaElement>('pp-screenplay');
  const status = byId('pp-status');
  const list = byId('pp-list');
  let projects: ProjectStatus[] = [];
  let autoOpen: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let apiDown = false;
  let modalKeys: boolean | null = null;
  const rebuildErrors = new Map<string, string>();
  /** Room scans uploaded by the iPhone app, for the open scene (`<project>:<scene>`). */
  const roomScans = new Map<string, RoomCaptureStatus>();
  const roomErrors = new Map<string, string>();
  const listeners = new Set<() => void>();
  /** project:character → the actor detail last applied to the open scene (hot-swap trigger). */
  const applied = new Map<string, string>();
  void getHealth()
    .then((hlt) => {
      modalKeys = !!hlt.keys.modal;
      render();
    })
    .catch(() => {});

  byId('pp-sample').addEventListener('click', () => {
    title.value = SAMPLE_TITLE;
    text.value = SAMPLE_SCREENPLAY;
  });

  byId('pp-generate').addEventListener('click', async () => {
    const screenplay = text.value.trim();
    if (!screenplay) {
      status.textContent = 'Paste a screenplay first.';
      return;
    }
    const btn = byId<HTMLButtonElement>('pp-generate');
    btn.disabled = true;
    status.textContent = 'Submitting…';
    try {
      const p = await createProject(screenplay, title.value.trim() || undefined);
      autoOpen = p.id;
      status.textContent = `Project ${p.id} queued.`;
      await refresh();
    } catch (err) {
      status.textContent = `Generate failed: ${err instanceof Error ? err.message : err}`;
    } finally {
      btn.disabled = false;
    }
  });

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

  /** The open scene's scanned room: what was uploaded and the button that builds the set. */
  const roomRow = (p: ProjectStatus, job: SceneJob) => {
    const key = `${p.id}:${job.sceneIndex}`;
    const scan = roomScans.get(key)?.capture;
    if (!scan) return null;
    const building = job.stages.world.status === 'running';
    const error = roomErrors.get(key);
    return h(
      'div',
      { class: 'room-scan', 'data-testid': 'room-scan' },
      h(
        'span',
        { class: 'muted small', title: `Uploaded ${new Date(scan.createdAt).toLocaleString()}` },
        `Scanned room: ${scan.room.area.toFixed(1)} m², ${scan.video.seconds.toFixed(0)} s video`,
      ),
      h(
        'button',
        {
          class: 'small',
          disabled: building || p.mock ? '' : undefined,
          title: p.mock
            ? 'MOCK project: building needs a live project'
            : 'Turns the scan into this scene\'s world (Marble video, ~5 min, ~1,600 credits). The current world is kept as world.prev-<k>.',
          onclick: (e: Event) => {
            e.stopPropagation();
            roomErrors.delete(key);
            void buildRoomWorld(p.id, job.sceneIndex).then(refresh, (err) => {
              roomErrors.set(key, err instanceof Error ? err.message : String(err));
              render();
            });
          },
        },
        building ? 'Building…' : 'Build set from scanned room',
      ),
      error ? h('div', { class: 'error small' }, error) : null,
    );
  };

  const render = () => {
    list.replaceChildren();
    if (apiDown) {
      list.append(h('div', { class: 'muted' }, 'Pipeline API unavailable — retrying…'));
      return;
    }
    if (!projects.length) {
      list.append(h('div', { class: 'muted' }, 'No projects yet. Paste a screenplay above.'));
      return;
    }
    for (const p of projects) {
      const scenes = h('div', { class: 'scenes' });
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
            job.thumbnailUrl
              ? h('img', { class: 'scene-thumb', src: job.thumbnailUrl, alt: '', loading: 'lazy' })
              : null,
            h('span', { class: 'chips' }, ...STAGES.map((s) => chip(p, job, s))),
          ),
        );
        if (current) {
          const row = roomRow(p, job);
          if (row) scenes.append(row);
        }
      }
      list.append(
        h(
          'div',
          { class: 'project', 'data-testid': 'project', 'data-id': p.id },
          h(
            'div',
            { class: 'project-head' },
            h('strong', {}, p.title || p.id),
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
      projects = (await listProjects()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      apiDown = false;
    } catch {
      apiDown = true;
    }
    // the open scene's room scan (the iPhone app uploads it while the laptop is open)
    if (director.projectId !== null && director.sceneIndex !== null) {
      const key = `${director.projectId}:${director.sceneIndex}`;
      try {
        roomScans.set(key, await getRoomCapture(director.projectId, director.sceneIndex));
      } catch {
        roomScans.delete(key);
      }
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
    await refresh();
    timer = setTimeout(poll, apiDown || projects.some(busy) || autoOpen ? 1500 : 5000);
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
    refresh,
  };
}
