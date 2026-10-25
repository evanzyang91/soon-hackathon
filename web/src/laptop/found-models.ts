// Found models in the laptop UI (docs/PLAN-v4.md "Found models"): a background prop that carries a
// found model (DynamicElement.model on a procedural kind) gets one quiet line under its row in
// Scene › Background and Tools › Objects: where the model came from and its licence (the
// attribution CC-BY asks for), what the viewer made of it (loading, not used and why), and two
// choices: "Use primitive" / "Use found model" and, when the model faces the wrong way,
// "Turn around".
//
// The choices are remembered in this browser per project and scene (localStorage): there is no
// scene-edit field for them yet, so the phone keeps drawing the model the server found.
import type { DynamicElement } from '@shared/schema';
import { setFlippedIds, setFoundModelFlip, setFoundModelUse, setPrimitiveIds, type FoundInfo } from '../viewer/found-model';
import type { Director } from './director';
import { h } from './dom';
import { storageGet, storageSet } from './storage';

interface Choices {
  primitive: string[];
  flipped: string[];
}

const key = (d: Director) => `previz:found-models:${d.projectId ?? ''}:${d.sceneIndex ?? ''}`;
const read = (d: Director): Choices => ({ primitive: [], flipped: [], ...(storageGet<Choices>(key(d)) ?? {}) });

/** Applies the choices remembered for the open scene (call when a scene loads). */
export function loadFoundChoices(d: Director) {
  const c = read(d);
  setPrimitiveIds(c.primitive);
  setFlippedIds(c.flipped);
}

function remember(d: Director, id: string, field: keyof Choices, on: boolean) {
  const c = read(d);
  c[field] = on ? [...new Set([...c[field], id])] : c[field].filter((x) => x !== id);
  storageSet(key(d), c);
}

/** What the viewer made of element `id`'s found model, from its prop in the scene. */
export function foundInfo(d: Director, id: string): FoundInfo | undefined {
  let info: FoundInfo | undefined;
  d.runtime?.scene.traverse((o) => {
    if (!info && o.userData.dynamicId === id && o.userData.found) info = o.userData.found as FoundInfo;
  });
  return info;
}

/** "Velociraptor 1+motions by Kapi777 (Sketchfab) · CC-BY-4.0": the line its licence asks for. */
export function attributionLine(el: DynamicElement): string {
  const m = el.model!;
  const who = m.attribution ?? m.source ?? m.file.split('/').slice(-2).join('/');
  return m.license ? `${who} · ${m.license}` : who;
}

/**
 * The line under a background prop's row, or null when the prop has no found model (kind 'model'
 * props are the director's own imports and say so in their kind). `changed` re-renders the list.
 */
export function foundModelLine(d: Director, el: DynamicElement, changed: () => void): HTMLElement | null {
  if (!el.model || el.kind === 'model') return null;
  const info = foundInfo(d, el.id);
  const choices = read(d);
  const primitive = choices.primitive.includes(el.id);
  const flipped = choices.flipped.includes(el.id);
  const status =
    !info || info.status === 'loading'
      ? 'Found model loading…'
      : info.status === 'ready'
        ? null
        : `Found model not used: ${info.reason ?? info.status}`;
  const button = (label: string, title: string, onclick: () => void, testid: string) =>
    h('button', { type: 'button', class: 'found-btn', title, 'data-testid': testid, onclick }, label);
  const actions: HTMLElement[] = [];
  if (info?.status === 'ready') {
    actions.push(
      primitive
        ? button('Use found model', 'Draw the found model again', () => {
            setFoundModelUse(el.id, true);
            remember(d, el.id, 'primitive', false);
            changed();
          }, 'found-use-model')
        : button('Use primitive', 'Draw the simple built-in body instead (remembered in this browser)', () => {
            setFoundModelUse(el.id, false);
            remember(d, el.id, 'primitive', true);
            changed();
          }, 'found-use-primitive'),
    );
    if (!primitive)
      actions.push(
        button('Turn around', 'The model faces the wrong way: turn it 180°', () => {
          setFoundModelFlip(el.id, !flipped);
          remember(d, el.id, 'flipped', !flipped);
          changed();
        }, 'found-turn'),
      );
  }
  return h(
    'div',
    { class: 'found-line muted small', 'data-testid': 'found-model-line', 'data-id': el.id, 'data-status': info?.status ?? 'loading' },
    h('span', { class: 'found-src', title: [attributionLine(el), status].filter(Boolean).join('\n') }, status ?? attributionLine(el)),
    ...actions,
  );
}

const watching = new WeakSet<() => void>();

/** Renders `render` again once no found model of `elements` is still loading (polls for 30 s at most). */
export function whileLoading(d: Director, elements: DynamicElement[], render: () => void) {
  const pending = () => elements.some((el) => el.model && el.kind !== 'model' && (foundInfo(d, el.id)?.status ?? 'loading') === 'loading');
  if (watching.has(render) || !pending()) return;
  watching.add(render);
  let tries = 0;
  const tick = () => {
    if (++tries > 60 || !pending()) {
      watching.delete(render);
      render();
      return;
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 500);
}
