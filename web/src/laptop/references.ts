// The director's reference photos on the laptop (uploaded in the project chat): a small thumbnail
// in the Scene mode's cast row for a character built from a photo (Character.referenceImage), and
// the photo of a place next to the Marble thumbnail in the projects drawer's scene row
// (ScenePlan.worldReference). Neither is in ProjectStatus, so the project's current plan.json is
// fetched from the static route, again only when the chat revision moves (the chat is what sets
// a photo).
import { api } from '@shared/api';
import type { ProjectStatus, ScreenplayPlan } from '@shared/schema';
import { h } from './dom';

const plans = new Map<string, { key: string; plan: ScreenplayPlan | null }>();
const loading = new Set<string>();

/** The project's plan as last fetched (null until it arrives); `onLoad` runs when a newer one lands. */
export function projectPlan(p: ProjectStatus, onLoad: () => void): ScreenplayPlan | null {
  const cached = plans.get(p.id);
  const key = `${p.parse.status}:${p.chatRevision ?? 0}`;
  if (p.parse.status === 'done' && cached?.key !== key && !loading.has(p.id)) {
    loading.add(p.id);
    void fetch(api.plan(p.id), { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<ScreenplayPlan>) : null))
      .catch(() => null)
      .then((plan) => {
        plans.set(p.id, { key, plan });
        loading.delete(p.id);
        if (plan) onLoad();
      });
  }
  return cached?.plan ?? null;
}

/**
 * A character's photo: the normalised LHM reference (actors/<id>/reference.png, what the avatar
 * was built from) once the build made it, else the upload itself; a click opens the upload.
 */
export function characterPhoto(projectId: string, characterId: string, file: string): HTMLElement {
  const source = api.upload(projectId, file);
  // the upload id is the photo's sha prefix: a new photo is a new URL, never a cached old one
  const reference = `/projects/${encodeURIComponent(projectId)}/actors/${encodeURIComponent(characterId)}/reference.png?photo=${encodeURIComponent(file)}`;
  const img = h('img', { src: reference, alt: '', loading: 'lazy' });
  img.addEventListener(
    'error',
    () => img.getAttribute('src') !== source && img.setAttribute('src', source),
    {
      once: true,
    },
  );
  return h(
    'a',
    {
      class: 'ref-photo',
      href: source,
      target: '_blank',
      rel: 'noopener',
      title: 'from your photo',
      'data-testid': 'character-photo',
    },
    img,
  );
}

/** The scene row's thumbnails: the Marble world, and the director's photo of the place next to it. */
export function sceneThumbs(
  projectId: string,
  thumbnailUrl: string | undefined,
  worldReference?: { file: string },
) {
  if (!thumbnailUrl && !worldReference) return null;
  return h(
    'span',
    { class: 'scene-thumbs' },
    thumbnailUrl
      ? h('img', { class: 'scene-thumb', src: thumbnailUrl, alt: '', loading: 'lazy' })
      : null,
    worldReference
      ? h('img', {
          class: 'scene-thumb ref',
          src: api.upload(projectId, worldReference.file),
          alt: '',
          loading: 'lazy',
          title: 'your photo of the place (the world is generated from it)',
          'data-testid': 'world-photo',
        })
      : null,
  );
}
