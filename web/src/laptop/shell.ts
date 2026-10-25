// Laptop layout (docs/PLAN-v2.md §3): the right panel's four tabs — Scene, Look (look-panel.ts as
// it mounts itself), Edit (edit-panel.ts, or a placeholder until it exists), Shoot — the
// collapsible project drawer on the left, the top bar (scene title + scale badge, the look's name,
// clock + Play / Pause, an overflow menu with undo / redo / the cheatsheet), the keyboard & mouse
// cheatsheet, a 3-step first-run tour (fly → drop a camera → pair the phone; dismissible,
// remembered) and hover hints for buttons the panels render without one.
//
// The Look and Edit panels build their own tab buttons; the shell replaces them with its own
// (same data-testids: tab-look, tab-edit, tab-shoot, plus tab-scene) and shows a panel by
// setting its section's `hidden`, which is what both panels check for their keyboard / pointer
// handling.
import type { Director } from './director';
import { fmtTime, h, isTyping } from './dom';
import { icon } from './icons';
import { storageGet, storageSet } from './storage';

export type Tab = 'scene' | 'look' | 'edit' | 'shoot';

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: 'scene', label: 'Scene', hint: 'Scenes of this project, world quality, cast (High detail) and everything you can grab in the view' },
  { id: 'look', label: 'Look', hint: 'Grade, film, atmosphere, lens and lights; the phone renders the same look' },
  { id: 'edit', label: 'Edit', hint: 'Describe a change in words (re-prompt): recolour, move, add or remove things' },
  { id: 'shoot', label: 'Shoot', hint: 'Phone pairing, cameras, scene clock, takes and dialogue' },
];
const TAB_KEY = 'previz:tab';
const DRAWER_KEY = 'previz:drawer';
export const TOUR_KEY = 'previz:tour:v1';

/** Hover hints for buttons the panels render without a title (by data-testid, then id). */
const HINTS: Record<string, string> = {
  'edit-send': 'Send the prompt (Enter); the planner picks the cheapest way to do it',
  'edit-undo': "Undo the last prompt's edits",
  'edit-apply': 'Apply this region edit and save it',
  'edit-replace': 'Click the object in the view yourself instead',
  'edit-cancel': 'Drop this edit',
  'regen-go': 'Regenerate the world (takes minutes and Marble credits)',
  'regen-cancel': 'Keep the current world',
  'look-add-point': 'Add a point light in front of the view',
  'look-add-spot': 'Add a spot light in front of the view, aimed down',
  'look-add-sun': 'Add a sun (directional light)',
  'high-detail': 'Rebuild this actor at high detail',
  'standard-detail': 'Switch back to the standard build',
};

export interface ShellParts {
  /** The Edit tab exists (edit-panel.ts mounted); else a placeholder shows. */
  edit: boolean;
}

export interface Shell {
  show(tab: Tab): void;
  readonly tab: Tab;
  /** The Look panel is the visible tab. */
  lookVisible(): boolean;
  /** A short message over the viewport. */
  toast(text: string, ms?: number): void;
  /** Hooks the top bar's undo / redo buttons to the manipulation (mounted after the shell). */
  setUndo(u: { undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean }): void;
  /** Starts the tour now (the cheatsheet's "Replay the tour"). */
  tour(): void;
}

export function mountShell(director: Director, parts: ShellParts): Shell {
  const right = document.getElementById('right')!;
  const paneScene = document.getElementById('pane-scene')!;
  const paneShoot = document.getElementById('pane-shoot')!;
  const lookSection = document.getElementById('look-panel');
  let editSection = document.getElementById('edit-panel');
  if (!editSection || !parts.edit) {
    // contract for WP G: mountEditPanel(el, director) fills an element like this one
    editSection = h(
      'section',
      { class: 'card grow edit-panel', id: 'edit-panel', 'data-testid': 'edit-panel' },
      h('h2', {}, 'Edit'),
      h('div', { class: 'muted' }, 'Edit coming online'),
      h('div', { class: 'muted small' }, 'Re-prompting ("make the bench red", "move Leo closer") lands here. Meanwhile, click anything in the view to move, recolour or hide it.'),
    );
    right.append(editSection);
  }

  // ---- tabs ------------------------------------------------------------------------------------
  // the panels' own tab rows go; the shell's replaces them (same test ids)
  for (const old of right.querySelectorAll('.right-tabs')) old.remove();
  const nav = h('nav', { class: 'shell-tabs', role: 'tablist', 'aria-label': 'Panels' });
  const buttons = new Map<Tab, HTMLButtonElement>();
  for (const t of TABS) {
    const b = h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': t.id, 'data-testid': `tab-${t.id}`, title: t.hint, onclick: () => show(t.id) }, t.label);
    buttons.set(t.id, b);
    nav.append(b);
  }
  right.prepend(nav);
  const sections: Record<Tab, HTMLElement | null> = { scene: paneScene, look: lookSection, edit: editSection, shoot: paneShoot };
  let current: Tab = 'shoot';
  function show(tab: Tab) {
    current = tab;
    storageSet(TAB_KEY, tab);
    for (const t of TABS) {
      const s = sections[t.id];
      if (s) s.hidden = t.id !== tab;
      const b = buttons.get(t.id)!;
      b.classList.toggle('on', t.id === tab);
      b.setAttribute('aria-selected', String(t.id === tab));
    }
    right.scrollTop = 0;
  }
  // any other child the panels left behind (e.g. a stray card) belongs to no tab
  for (const c of [...right.children] as HTMLElement[]) if (c !== nav && !Object.values(sections).includes(c)) c.hidden = true;
  const legacy = storageGet<string>('previz:rightTab');
  const saved = storageGet<Tab>(TAB_KEY) ?? (storageGet<boolean>('previz:edit-tab') ? 'edit' : legacy === 'look' ? 'look' : null);
  show(saved && TABS.some((t) => t.id === saved) ? saved : 'shoot');

  // ---- drawer ----------------------------------------------------------------------------------
  const drawerBtn = document.getElementById('drawer-toggle') as HTMLButtonElement;
  const setDrawer = (open: boolean) => {
    document.body.classList.toggle('drawer-closed', !open);
    drawerBtn.setAttribute('aria-expanded', String(open));
    drawerBtn.classList.toggle('on', open);
    storageSet(DRAWER_KEY, open ? 'open' : 'closed');
    // the viewport resizes with the grid (ResizeObserver in main.ts)
  };
  drawerBtn.addEventListener('click', () => setDrawer(document.body.classList.contains('drawer-closed')));
  setDrawer(storageGet<string>(DRAWER_KEY) !== 'closed');

  // ---- top bar ---------------------------------------------------------------------------------
  const playBtn = document.getElementById('top-play') as HTMLButtonElement;
  const clock = document.getElementById('top-clock')!;
  const lookBadge = document.getElementById('top-look') as HTMLButtonElement;
  const undoBtn = document.getElementById('top-undo') as HTMLButtonElement;
  const redoBtn = document.getElementById('top-redo') as HTMLButtonElement;
  // undo / redo / the cheatsheet sit in an overflow menu (their shortcuts work without it)
  const moreBtn = document.getElementById('top-more') as HTMLButtonElement;
  const menu = document.getElementById('top-menu')!;
  const setMenu = (open: boolean) => {
    menu.hidden = !open;
    moreBtn.setAttribute('aria-expanded', String(open));
    moreBtn.classList.toggle('on', open);
  };
  moreBtn.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) setMenu(false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !(e.target as HTMLElement | null)?.closest('.top-more')) setMenu(false);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) setMenu(false);
  });
  playBtn.addEventListener('click', () => director.togglePlay());
  lookBadge.addEventListener('click', () => show('look'));
  let undoApi: Parameters<Shell['setUndo']>[0] | null = null;
  undoBtn.addEventListener('click', () => undoApi?.undo());
  redoBtn.addEventListener('click', () => undoApi?.redo());
  const renderUndo = () => {
    undoBtn.disabled = !undoApi?.canUndo();
    redoBtn.disabled = !undoApi?.canRedo();
    const l = director.undo.labels;
    undoBtn.title = l.undo ? `Undo ${l.undo} (⌘Z)` : 'Undo (⌘Z)';
    redoBtn.title = l.redo ? `Redo ${l.redo} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
  };
  const renderClock = () => {
    const rt = director.runtime;
    playBtn.disabled = !rt;
    const playing = !!rt?.playing;
    const label = playing ? 'Pause' : 'Play';
    if (playBtn.getAttribute('aria-label') !== label) {
      playBtn.setAttribute('aria-label', label);
      playBtn.replaceChildren(icon(playing ? 'pause' : 'play'));
    }
    playBtn.classList.toggle('on', playing);
    clock.textContent = fmtTime(rt?.time ?? 0);
  };
  let offLook: (() => void) | null = null;
  const renderLook = () => {
    const look = director.runtime?.getLook();
    const named = !!look && look.name !== 'Default';
    lookBadge.hidden = !named;
    if (named && lookBadge.dataset.name !== look.name) {
      lookBadge.dataset.name = look.name;
      lookBadge.replaceChildren(h('span', { class: 'look-badge-label' }, 'Look'), h('span', { class: 'look-badge-name' }, look.name));
    }
    renderUndo();
  };
  director.on((c) => {
    if (c === 'clock' || c === 'scene') renderClock();
    if (c === 'scene') {
      offLook?.();
      offLook = director.runtime?.look.onChange(() => renderLook()) ?? null;
      renderLook();
    }
    if (c === 'undo' || c === 'scene') renderUndo();
  });
  renderClock();
  renderLook();

  // ---- toast -----------------------------------------------------------------------------------
  const toastEl = document.getElementById('hud-toast')!;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  const toast = (text: string, ms = 2400) => {
    toastEl.textContent = text;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
  };

  // ---- cheatsheet --------------------------------------------------------------------------------
  const sheet = buildCheatsheet(() => {
    closeSheet();
    startTour(true);
  });
  const openSheet = () => {
    document.body.append(sheet);
    (sheet.querySelector('button') as HTMLButtonElement | null)?.focus();
  };
  const closeSheet = () => sheet.remove();
  sheet.addEventListener('click', (e) => e.target === sheet && closeSheet());
  document.getElementById('top-help')!.addEventListener('click', () => (sheet.isConnected ? closeSheet() : openSheet()));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet.isConnected) {
      closeSheet();
      e.stopPropagation();
      return;
    }
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '?') {
      e.preventDefault();
      if (sheet.isConnected) closeSheet();
      else openSheet();
    } else if (e.key === '[') setDrawer(document.body.classList.contains('drawer-closed'));
  });

  // ---- tour --------------------------------------------------------------------------------------
  const tourParam = new URLSearchParams(location.search).get('tour');
  const startTour = (force = false) => {
    if (!force && storageGet<string>(TOUR_KEY)) return;
    runTour(show, () => storageSet(TOUR_KEY, 'done'));
  };
  // automation (Playwright, the look checks) never sees it unless ?tour=1 asks; ?tour=force replays
  const autoTour = tourParam === 'force' || (!navigator.webdriver && tourParam !== '0') || tourParam === '1';
  if (autoTour) {
    let started = false;
    const go = () => {
      if (started) return;
      started = true;
      startTour(tourParam === 'force');
    };
    const off = director.on((c) => {
      if (c === 'scene' && director.runtime) {
        off();
        setTimeout(go, 600);
      }
    });
    setTimeout(go, 4000);
  }

  // ---- hover hints -------------------------------------------------------------------------------
  const hint = () => {
    for (const b of document.querySelectorAll<HTMLButtonElement>('button:not([title])')) {
      const key = b.dataset.testid ?? b.id;
      const text = HINTS[key] ?? (b.textContent?.trim() === '×' ? 'Remove' : null);
      if (text) b.title = text;
    }
  };
  let hintTimer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (hintTimer) return;
    hintTimer = setTimeout(() => {
      hintTimer = null;
      hint();
    }, 150);
  }).observe(document.body, { childList: true, subtree: true });
  hint();

  return {
    show,
    get tab() {
      return current;
    },
    lookVisible: () => !!lookSection && !lookSection.hidden,
    toast,
    setUndo: (u) => {
      undoApi = u;
      renderUndo();
    },
    tour: () => startTour(true),
  };
}

// ---- cheatsheet ----------------------------------------------------------------------------------

const KEYS: [string, [string, string][]][] = [
  [
    'Fly & view',
    [
      ['W A S D · Q / E', 'fly · down / up (Shift: faster)'],
      ['drag empty space · right-drag', 'look around'],
      ['double-click', 'mouselook (Esc leaves)'],
      ['wheel', 'zoom (field of view)'],
      ['V', 'view through the phone'],
      ['G', 'ground grid'],
      ['[', 'projects drawer'],
    ],
  ],
  [
    'Select & move',
    [
      ['click', 'select an actor, prop, light or camera'],
      ['drag', 'move it on the floor (actors stop at walls)'],
      ['Shift + drag', 'raise / lower'],
      ['yellow ring', 'turn (Shift: 15° steps)'],
      ['orange knob', 'scale a prop · a light’s radius'],
      ['green point', 'a camera’s focus distance (depth of field on)'],
      ['← ↑ → ↓', 'nudge 5 cm (Shift: 50 cm)'],
      ['⌫ / Delete', 'delete a prop, light or camera'],
      ['click the world', 'select a region of splats: recolour, hide, move'],
      ['⌘Z · ⇧⌘Z', 'undo · redo'],
      ['Esc', 'deselect'],
    ],
  ],
  [
    'Shoot',
    [
      ['Space', 'play / pause the scene clock'],
      ['C', 'drop a camera at the view'],
      ['1 – 9', 'jump to a camera'],
      ['R', 'record a take'],
      ['Alt + click', 'focus on what is under the cursor'],
      ['?', 'this sheet'],
    ],
  ],
];

function buildCheatsheet(onTour: () => void): HTMLElement {
  const close = h('button', { type: 'button', class: 'icon sheet-close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => backdrop.remove() }, icon('close'));
  const cols = KEYS.map(([title, rows]) =>
    h(
      'section',
      { class: 'sheet-col' },
      h('h3', {}, title),
      ...rows.map(([k, v]) => h('div', { class: 'sheet-row' }, h('kbd', {}, k), h('span', {}, v))),
    ),
  );
  const backdrop = h(
    'div',
    { class: 'sheet-backdrop', 'data-testid': 'cheatsheet' },
    h(
      'div',
      { class: 'sheet', role: 'dialog', 'aria-label': 'Keyboard and mouse' },
      h('div', { class: 'sheet-head' }, h('h2', {}, 'Keyboard & mouse'), h('span', { class: 'spacer' }), h('button', { type: 'button', class: 'small', title: 'Show the three-step tour again', 'data-testid': 'replay-tour', onclick: onTour }, 'Replay the tour'), close),
      h('div', { class: 'sheet-cols' }, ...cols),
      h('div', { class: 'muted small' }, 'Every change in the view syncs to the paired phone. The Look tab has its own undo while it is open; ⌘Z undoes whichever changed last.'),
    ),
  );
  return backdrop;
}

// ---- tour ----------------------------------------------------------------------------------------

interface Step {
  title: string;
  text: string;
  target: () => HTMLElement | null;
  tab?: Tab;
}

const STEPS: Step[] = [
  {
    title: 'Fly',
    text: 'W A S D to fly, Q / E down / up, Shift for speed. Drag empty space (or right-drag) to look around, wheel to zoom. Click an actor, prop or light to move it.',
    target: () => document.getElementById('stage'),
  },
  {
    title: 'Drop a camera',
    text: 'Found a shot? Press C or Drop: a camera lands at your view. Drag its frustum in the view to adjust it; the phone attaches to the active camera.',
    target: () => document.getElementById('cam-drop'),
    tab: 'shoot',
  },
  {
    title: 'Pair the phone',
    text: 'Scan this QR with your phone (same Wi-Fi) and tap Start. It becomes the handheld camera, and its view shows up in the corner of yours.',
    target: () => document.getElementById('ph-qr'),
    tab: 'shoot',
  },
];

function runTour(show: (t: Tab) => void, done: () => void) {
  document.querySelector('.coach')?.remove();
  document.querySelector('.coach-ring')?.remove();
  let i = 0;
  const ring = h('div', { class: 'coach-ring' });
  const card = h('div', { class: 'coach', role: 'dialog', 'data-testid': 'coach' });
  const finish = () => {
    card.remove();
    ring.remove();
    window.removeEventListener('resize', place);
    window.removeEventListener('keydown', onKey, true);
    done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      finish();
    }
  };
  function place() {
    const step = STEPS[i]!;
    const t = step.target();
    const r = t?.getBoundingClientRect();
    const cw = card.offsetWidth || 300;
    const ch = card.offsetHeight || 150;
    if (!r || (!r.width && !r.height)) {
      ring.hidden = true;
      Object.assign(card.style, { left: `${(innerWidth - cw) / 2}px`, top: `${innerHeight / 3}px` });
      return;
    }
    ring.hidden = false;
    Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
    let left: number;
    let top: number;
    if (r.width > innerWidth * 0.4) {
      // a big target (the viewport): the card sits inside it, near the top
      left = r.left + (r.width - cw) / 2;
      top = r.top + Math.min(90, r.height * 0.15);
    } else {
      // beside it, on the side with room (panels are on the right)
      left = r.left - cw - 18 > 8 ? r.left - cw - 18 : r.right + 18;
      top = r.top + r.height / 2 - ch / 2;
    }
    card.style.left = `${Math.max(8, Math.min(innerWidth - cw - 8, left))}px`;
    card.style.top = `${Math.max(48, Math.min(innerHeight - ch - 8, top))}px`;
  }
  function render() {
    const step = STEPS[i]!;
    if (step.tab) show(step.tab);
    const last = i === STEPS.length - 1;
    card.replaceChildren(
      h('div', { class: 'coach-step muted small' }, `${i + 1} / ${STEPS.length}`),
      h('h3', {}, step.title),
      h('p', {}, step.text),
      h(
        'div',
        { class: 'row' },
        h('button', { type: 'button', class: 'small', title: 'Hide the tour (it will not show again; ? → Replay the tour)', 'data-testid': 'coach-skip', onclick: finish }, 'Skip tour'),
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            type: 'button',
            class: 'primary',
            'data-testid': 'coach-next',
            title: last ? 'Finish the tour' : 'Next step',
            onclick: () => {
              if (last) return finish();
              i++;
              render();
            },
          },
          last ? 'Done' : 'Next ›',
        ),
      ),
    );
    requestAnimationFrame(place);
  }
  document.body.append(ring, card);
  window.addEventListener('resize', place);
  window.addEventListener('keydown', onKey, true);
  render();
}
