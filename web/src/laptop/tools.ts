// Tools (docs/PLAN-v4.md): the drawer over the right panel that holds everything that is a tool
// rather than a step of the work, as collapsible sections. Nothing in it changed behaviour; it
// stopped competing with the three modes.
//
//   Grade      the Look panel (look-panel.ts): grade, LUT, film, atmosphere, lens / depth of
//              field, lights, presets, compare
//   Re-prompt  the Edit panel (edit-panel.ts): change the set in words, regions, history
//   Objects    the outliner: props, lights and shots you can grab in the view
//   Developer  splat quality, collider, grid, reload, the world's scale / ground / collider
//              details and which API keys the server has
//
// The Look and Edit panels decide whether they are live (keyboard undo, viewport clicks) from
// their section's `hidden`, so a section is hidden unless the drawer is open and it is expanded.
import { getHealth } from './api';
import { effectiveProps } from '../viewer/edits/model';
import { isPropRemoved } from '../viewer/manipulate/edits';
import { floorOffset } from '../viewer/transform';
import { lensLabel } from '@shared/lens';
import type { SplatQuality } from '../viewer/world';
import type { Director } from './director';
import { byId, h, isTyping } from './dom';
import { foundModelLine, whileLoading } from './found-models';
import { scaleHeadline } from './hud';
import { icon } from './icons';
import type { LookPanel } from './look-panel';
import type { Manipulation } from './manipulate';
import { storageGet, storageSet } from './storage';

export type ToolId = 'grade' | 'reprompt' | 'objects' | 'developer';
const OPEN_KEY = 'previz:tools';
const SECTIONS_KEY = 'previz:tools:sections';

export interface Tools {
  readonly isOpen: boolean;
  /** Opens the drawer (and expands `section`, scrolled into view). */
  open(section?: ToolId): void;
  close(): void;
  toggle(): void;
  /** The Grade section is showing (the Look panel's own ⌘Z is live then). */
  lookVisible(): boolean;
  onChange(fn: (open: boolean) => void): () => void;
}

export function mountTools(director: Director): Tools {
  const drawer = byId('tools');
  const button = byId<HTMLButtonElement>('top-tools');
  const details = new Map<ToolId, HTMLDetailsElement>();
  for (const d of drawer.querySelectorAll<HTMLDetailsElement>('details.tool')) details.set(d.dataset.tool as ToolId, d);
  const listeners = new Set<(open: boolean) => void>();
  let open = false;

  const saved = storageGet<ToolId[]>(SECTIONS_KEY) ?? ['grade'];
  for (const [id, d] of details) d.open = saved.includes(id);

  /** The panels inside a section are live only while it shows. */
  const sync = () => {
    const look = document.getElementById('look-panel');
    const edit = document.getElementById('edit-panel');
    if (look) look.hidden = !(open && details.get('grade')!.open);
    if (edit) edit.hidden = !(open && details.get('reprompt')!.open);
  };
  for (const d of details.values())
    d.addEventListener('toggle', () => {
      storageSet(SECTIONS_KEY, [...details].filter(([, x]) => x.open).map(([id]) => id));
      sync();
    });

  const set = (on: boolean, section?: ToolId) => {
    open = on;
    drawer.hidden = !on;
    button.classList.toggle('on', on);
    button.setAttribute('aria-expanded', String(on));
    storageSet(OPEN_KEY, on);
    if (on && section) {
      const d = details.get(section)!;
      d.open = true;
      requestAnimationFrame(() => d.scrollIntoView({ block: 'start', behavior: 'smooth' }));
    }
    sync();
    for (const fn of listeners) fn(on);
  };
  button.addEventListener('click', () => set(!open));
  byId('tools-close').addEventListener('click', () => set(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open && !isTyping(e.target) && !document.querySelector('.sheet-backdrop')) set(false);
  });
  set(storageGet<boolean>(OPEN_KEY) === true);

  mountDeveloper(director);

  return {
    get isOpen() {
      return open;
    },
    open: (section) => set(true, section),
    close: () => set(false),
    toggle: () => set(!open),
    lookVisible: () => open && details.get('grade')!.open,
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ---- Developer -------------------------------------------------------------------------------------

function mountDeveloper(director: Director) {
  const health = byId('health');
  const quality = byId<HTMLSelectElement>('hud-quality');
  const gridBtn = byId<HTMLButtonElement>('hud-grid');
  const colliderBtn = byId<HTMLButtonElement>('hud-collider');
  const world = byId('st-world');
  const worldKind = byId('st-world-kind');

  getHealth()
    .then((hlt) => {
      health.textContent = hlt.mock ? 'MOCK' : 'LIVE';
      health.className = `badge ${hlt.mock ? '' : 'live'}`;
      health.title = Object.entries(hlt.keys)
        .map(([k, v]) => `${k}: ${v ? 'key set' : 'no key'}`)
        .join('\n');
    })
    .catch(() => {});

  byId('hud-reload').addEventListener('click', () => director.reloadScene());
  gridBtn.addEventListener('click', () => {
    const rt = director.runtime;
    if (!rt) return;
    rt.grid.visible = !rt.grid.visible;
    gridBtn.classList.toggle('on', rt.grid.visible);
  });
  colliderBtn.addEventListener('click', () => {
    const c = director.runtime?.collider;
    if (!c) return;
    c.visible = !c.visible;
    colliderBtn.classList.toggle('on', c.visible);
  });
  quality.addEventListener('change', () => void director.setQuality(quality.value as SplatQuality));
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyG' && !isTyping(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) gridBtn.click();
  });

  const render = () => {
    const rt = director.runtime;
    for (const opt of quality.options) opt.disabled = !rt?.manifest.world.spz[opt.value as SplatQuality];
    quality.value = rt?.quality ?? director.quality;
    gridBtn.classList.toggle('on', !!rt?.grid.visible);
    colliderBtn.disabled = !rt?.collider;
    colliderBtn.classList.toggle('on', !!rt?.collider?.visible);
    world.replaceChildren();
    worldKind.textContent = rt ? (rt.placeholder ? 'placeholder world' : rt.manifest.world.provider === 'mock' ? 'mock world' : 'Marble world') : '';
    if (!rt) return;
    const w = rt.manifest.world;
    const rows: HTMLElement[] = [];
    if (w.caption) rows.push(h('div', { class: 'muted st-caption', title: w.caption }, w.caption));
    const cal = w.scaleCalibration;
    if (cal) {
      const ref = scaleHeadline(cal);
      rows.push(
        h(
          'details',
          { class: 'st-scale', 'data-testid': 'scale-calibration' },
          h('summary', {}, `Scale ×${cal.factor.toFixed(2)}${ref ? ` (${ref})` : ''} · ${cal.confidence}`),
          ...cal.evidence.split(' · ').map((e) => h('div', { class: 'muted' }, e)),
        ),
      );
    }
    const floor = floorOffset(w);
    if (floor) rows.push(h('div', { class: 'muted' }, `Floor raised ${(floor * 100).toFixed(0)} cm to the visible ground`));
    if (w.ground)
      rows.push(
        h(
          'div',
          {
            class: 'muted',
            'data-testid': 'ground-field',
            title: rt.ground
              ? `Each actor stands on the measured ground at its own spot. ${rt.ground.method ?? ''}`.trim()
              : 'The ground field did not load: actors stand on the median floor',
          },
          `ground field · ${Math.round((100 * w.ground.covered) / w.ground.cells)} % covered · ${w.ground.cell} m cells${rt.ground ? '' : ' (not loaded)'}`,
        ),
      );
    rows.push(h('div', { class: 'muted' }, rt.collider ? 'Collider loaded: dragged actors stay out of walls' : w.colliderGlb ? 'Collider loading…' : 'No collider: actors move freely'));
    world.append(...rows);
  };
  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      render();
      void director.runtime?.colliderReady.then(() => render());
    }
  });
  render();
}

// ---- Objects ---------------------------------------------------------------------------------------

type Ref = NonNullable<Director['selection']>;

/** The outliner of what can be grabbed in the view: click selects, × deletes (undoable). */
export function mountObjects(director: Director, look: LookPanel, manip: Manipulation) {
  const objects = byId('st-objects');
  const selected = (r: Ref) => director.selection?.type === r.type && director.selection.id === r.id;
  const objectRow = (r: Ref, name: string, kind: string, deletable = true) =>
    h(
      'div',
      { class: `st-object${selected(r) ? ' selected' : ''}`, 'data-testid': 'object-row', 'data-type': r.type, 'data-id': r.id },
      h('button', { type: 'button', class: 'link', title: 'Select in the view', onclick: () => director.select(selected(r) ? null : r) }, name),
      h('span', { class: 'muted small' }, kind),
      deletable ? h('button', { type: 'button', class: 'icon', title: `Delete (⌫ in the view; ⌘Z brings it back)`, 'aria-label': 'Delete', onclick: () => manip.manipulator.remove(r) }, icon('close')) : null,
    );

  const render = () => {
    const rt = director.runtime;
    objects.replaceChildren();
    if (!rt) {
      objects.append(h('div', { class: 'empty' }, 'Open a scene first.'));
      return;
    }
    const doc = rt.edits;
    const groups: [string, HTMLElement[]][] = [];
    const props = [...rt.dynamics.items.map((i) => i.element), ...(doc ? effectiveProps(doc.edits).added : [])].filter((el) => !isPropRemoved(doc, el.id));
    // an imported / generated model says where it came from (the file name or the prompt)
    const kindOf = (el: (typeof props)[number]) =>
      !el.model ? el.kind : el.kind !== 'model' ? `${el.kind} · found model` : `model · ${el.model.file.startsWith('props/') ? 'generated' : (el.model.source ?? 'imported')}`;
    // a found model adds its source, licence and choices under its row (found-models.ts)
    groups.push([
      'Props',
      props.flatMap((el) => {
        const found = foundModelLine(director, el, render);
        return [objectRow({ type: 'prop', id: el.id }, el.label || el.kind, kindOf(el)), ...(found ? [found] : [])];
      }),
    ]);
    whileLoading(director, props, render);
    const lights = look.session.look?.lights ?? [];
    groups.push(['Lights', lights.map((l) => objectRow({ type: 'light', id: l.id }, l.name, `${l.kind}${l.enabled ? '' : ' · off'}`))]);
    groups.push(['Shots', director.cameras.map((c) => objectRow({ type: 'camera', id: c.id }, c.name, c.id === director.activeCameraId ? 'on the phone' : lensLabel(c.fovDeg)))]);
    for (const [title, rows] of groups) {
      objects.append(h('div', { class: 'st-group' }, title));
      if (rows.length) objects.append(...rows);
      else objects.append(h('div', { class: 'muted small' }, title === 'Lights' ? 'None — add one under Grade › Lights.' : title === 'Shots' ? 'None — add one with C.' : 'None.'));
    }
    objects.append(h('div', { class: 'muted small st-tip' }, 'Click anything in the view to select it; click the set to select a region of it.'));
  };

  let soon: ReturnType<typeof setTimeout> | null = null;
  const renderSoon = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      render();
    }, 120);
  };
  let lookOff: (() => void) | null = null;
  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      lookOff?.();
      lookOff = director.runtime?.look.onChange(() => renderSoon()) ?? null;
      render();
    }
    if (c === 'cameras' || c === 'undo' || c === 'selection') renderSoon();
  });
  render();
}
