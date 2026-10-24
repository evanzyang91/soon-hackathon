// Left panel: screenplay input → POST /api/projects, project list with per-scene stage chips.
import { api } from '@shared/api';
import type { ProjectStatus } from '@shared/schema';
import { createProject, listProjects, retryStage } from './api';
import type { Director } from './director';
import { byId, h } from './dom';
import { SAMPLE_SCREENPLAY, SAMPLE_TITLE } from './sample';

type SceneJob = ProjectStatus['scenes'][number];
const STAGES = ['parse', 'world', 'actors', 'tts', 'manifest'] as const;

export function sceneReady(job: SceneJob): boolean {
  const manifest = (job.stages as Partial<SceneJob['stages']>).manifest;
  return !!job.manifestUrl && (manifest?.status ?? 'done') === 'done';
}

function busy(p: ProjectStatus) {
  if (p.parse.status === 'pending' || p.parse.status === 'running') return true;
  return p.scenes.some((s) =>
    Object.values(s.stages).some((st) => st?.status === 'pending' || st?.status === 'running'),
  );
}

export function mountProjectsPanel(director: Director) {
  const title = byId<HTMLInputElement>('pp-title');
  const text = byId<HTMLTextAreaElement>('pp-screenplay');
  const status = byId('pp-status');
  const list = byId('pp-list');
  let projects: ProjectStatus[] = [];
  let autoOpen: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let apiDown = false;

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
    const failed = st.status === 'failed';
    return h(
      'span',
      {
        class: `chip ${st.status}`,
        title: `${stage}: ${st.status}${st.note ? ` — ${st.note}` : ''}${failed ? ' (click to retry)' : ''}`,
        'data-stage': stage,
        onclick: failed
          ? (e: Event) => {
              e.stopPropagation();
              void retryStage(p.id, job.sceneIndex, stage).then(refresh, () => {});
            }
          : undefined,
      },
      stage,
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
    if (autoOpen) {
      const p = projects.find((x) => x.id === autoOpen);
      const job = p?.scenes.find(sceneReady);
      if (p && job) {
        autoOpen = null;
        open(p, job);
      }
    }
    render();
  };

  const poll = async () => {
    await refresh();
    timer = setTimeout(poll, apiDown || projects.some(busy) || autoOpen ? 1500 : 5000);
  };
  director.on((c) => {
    if (c === 'scene') render();
  });
  void poll();
  return () => timer && clearTimeout(timer);
}
