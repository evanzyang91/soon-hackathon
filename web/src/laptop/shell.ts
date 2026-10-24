// Laptop layout (docs/PLAN-v4.md): the right panel's three modes — Scene (heading, mood, cast,
// lines, background action, location), Shots (the shot list) and Camera (phone, takes, clock) —
// with Tab cycling them; the Tools drawer over the right panel (tools.ts, T); the collapsible
// script drawer on the left ( [ ); the top bar (brand, `Project · Sc 1 · HEADING`, the look's
// name, clock + Reset + Play / Pause, Export, Tools, an overflow menu with undo / redo / the
// cheatsheet); the keyboard & mouse cheatsheet, a 3-step first-run tour (fly → add a shot → pair
// the phone; dismissible, remembered) and hover hints for buttons the panels render without one.
//
// A mode is shown by setting its pane's `hidden`.
import type { Director } from './director';
import { fmtTime, h, isTyping } from './dom';
import { icon } from './icons';
import { storageGet, storageSet } from './storage';
import type { Tools } from './tools';

export type Mode = 'scene' | 'shots' | 'camera';

const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'scene', label: 'Scene', hint: 'The scene: mood, cast and marks, lines, background action, location' },
  { id: 'shots', label: 'Shots', hint: 'The shot list: coverage, frames, lenses, notes (1–9 jump, C adds the view)' },
  { id: 'camera', label: 'Camera', hint: 'Pair the phone, record takes, the scene clock' },
];
const MODE_KEY = 'previz:mode';
const DRAWER_KEY = 'previz:drawer';
export const TOUR_KEY = 'previz:tour:v2';

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
  tools: Tools;
}

export interface Shell {
  show(mode: Mode): void;
  readonly mode: Mode;
  /** A short message over the viewport. */
  toast(text: string, ms?: number): void;
  /** Hooks the top bar's undo / redo buttons to the manipulation (mounted after the shell). */
  setUndo(u: { undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean }): void;
  /** Starts the tour now (the cheatsheet's "Replay the tour"). */
  tour(): void;
}

export function mountShell(director: Director, parts: ShellParts): Shell {
  const { tools } = parts;
  const right = document.getElementById('right')!;
  const panes: Record<Mode, HTMLElement> = {
    scene: document.getElementById('pane-scene')!,
    shots: document.getElementById('pane-shots')!,
    camera: document.getElementById('pane-camera')!,
  };

  // ---- modes -----------------------------------------------------------------------------------
  const nav = h('nav', { class: 'shell-tabs tabs', role: 'tablist', 'aria-label': 'Modes' });
  const buttons = new Map<Mode, HTMLButtonElement>();
  for (const t of MODES) {
    const b = h('button', { type: 'button', class: 'tab', role: 'tab', 'data-tab': t.id, 'data-testid': `tab-${t.id}`, title: `${t.hint} (Tab)`, onclick: () => show(t.id) }, t.label);
    buttons.set(t.id, b);
    nav.append(b);
  }
  right.prepend(nav);
  let current: Mode = 'scene';
  function show(mode: Mode) {
    current = mode;
    storageSet(MODE_KEY, mode);
    for (const t of MODES) {
      panes[t.id].hidden = t.id !== mode;
      const b = buttons.get(t.id)!;
      b.classList.toggle('on', t.id === mode);
      b.setAttribute('aria-selected', String(t.id === mode));
    }
    right.scrollTop = 0;
  }
  // older layouts' tab names: the Shoot tab is the Camera mode now; Look / Edit live in Tools
  const saved = storageGet<string>(MODE_KEY) ?? (storageGet<string>('previz:tab') === 'shoot' ? 'camera' : null);
  show(MODES.some((t) => t.id === saved) ? (saved as Mode) : 'scene');

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
  const resetBtn = document.getElementById('top-reset') as HTMLButtonElement;
  const playBtn = document.getElementById('top-play') as HTMLButtonElement;
  const clock = document.getElementById('top-clock')!;
  const lookBadge = document.getElementById('top-look') as HTMLButtonElement;
  const undoBtn = document.getElementById('top-undo') as HTMLButtonElement;
  const redoBtn = document.getElementById('top-redo') as HTMLButtonElement;
  // popover menus (Export, ⋯): one open at a time, closed by a click elsewhere or Escape
  const menus: { btn: HTMLButtonElement; menu: HTMLElement }[] = [
    { btn: document.getElementById('top-more') as HTMLButtonElement, menu: document.getElementById('top-menu')! },
    { btn: document.getElementById('top-export') as HTMLButtonElement, menu: document.getElementById('export-menu')! },
  ];
  const setMenu = (m: (typeof menus)[number] | null) => {
    for (const x of menus) {
      const open = x === m;
      x.menu.hidden = !open;
      x.btn.setAttribute('aria-expanded', String(open));
      x.btn.classList.toggle('on', open);
    }
  };
  for (const m of menus) {
    m.btn.addEventListener('click', () => setMenu(m.menu.hidden ? m : null));
    m.menu.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a')) setMenu(null);
    });
  }
  document.addEventListener('pointerdown', (e) => {
    if (!(e.target as HTMLElement | null)?.closest('.top-pop')) setMenu(null);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMenu(null);
  });
  resetBtn.addEventListener('click', () => director.resetScene());
  playBtn.addEventListener('click', () => director.togglePlay());
  lookBadge.addEventListener('click', () => tools.open('grade'));
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
    resetBtn.disabled = !rt;
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
      // the text stays "look: <name>" (tests and scripts read it); the label part is muted
      lookBadge.replaceChildren(h('span', { class: 'look-badge-label' }, 'look: '), h('span', { class: 'look-badge-name' }, look.name));
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
    if (c === 'reset') toast('Scene reset');
  });
  tools.onChange(() => renderUndo());
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
    else if (e.code === 'KeyT') {
      e.preventDefault();
      tools.toggle();
    } else if (e.key === 'Tab') {
      // Tab steps through the modes (Shift+Tab back); the Tools drawer gives way
      e.preventDefault();
      const i = MODES.findIndex((m) => m.id === current);
      const next = MODES[(i + (e.shiftKey ? MODES.length - 1 : 1)) % MODES.length]!.id;
      tools.close();
      if (document.activeElement instanceof HTMLElement && right.contains(document.activeElement)) document.activeElement.blur();
      show(next);
    }
  });

  // ---- tour --------------------------------------------------------------------------------------
  const tourParam = new URLSearchParams(location.search).get('tour');
  const startTour = (force = false) => {
    if (!force && storageGet<string>(TOUR_KEY)) return;
    tools.close();
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
    get mode() {
      return current;
    },
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
    'Work',
    [
      ['Tab · Shift+Tab', 'next mode · previous (Scene, Shots, Camera)'],
      ['1 – 9', 'go to shot 1A … 1I (the phone follows)'],
      ['C', 'add the view as a shot (frame grabbed)'],
      ['F', 'grab the selected shot’s frame again'],
      ['Space', 'play / pause the scene clock'],
      ['0', 'reset the scene: clock to 0:00, everyone back on their marks'],
      ['R', 'record a take'],
      ['V', 'view through the phone'],
      ['T', 'tools: grade, re-prompt, objects, developer'],
      ['[', 'script drawer'],
      ['?', 'this sheet'],
    ],
  ],
  [
    'Fly & look',
    [
      ['W A S D · Q / E', 'fly · down / up (Shift: faster)'],
      ['drag empty space · right-drag', 'look around'],
      ['double-click', 'mouselook (Esc leaves)'],
      ['wheel', 'zoom (changes the lens)'],
      ['Alt + click', 'focus on what is under the cursor'],
      ['moving the view', 'leaves the selected shot (its frame guide goes)'],
    ],
  ],
  [
    'Marks & objects',
    [
      ['click', 'select an actor, prop, light or shot'],
      ['drag', 'move it on the floor (actors stop at walls)'],
      ['Shift + drag', 'raise / lower'],
      ['yellow ring', 'turn (Shift: 15° steps)'],
      ['orange knob', 'scale a prop · a light’s radius'],
      ['green point', 'a shot’s focus distance (depth of field on)'],
      ['← ↑ → ↓', 'nudge 5 cm (Shift: 50 cm)'],
      ['⌫ / Delete', 'delete a prop, light or shot'],
      ['click the set', 'select a region of it: recolour, hide, move'],
      ['⌘Z · ⇧⌘Z', 'undo · redo'],
      ['Esc', 'deselect · close Tools'],
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
      h('div', { class: 'muted small' }, 'Every change in the view syncs to the paired phone. Tools › Grade has its own undo while it is open; ⌘Z undoes whichever changed last.'),
    ),
  );
  return backdrop;
}

// ---- tour ----------------------------------------------------------------------------------------

interface Step {
  title: string;
  text: string;
  target: () => HTMLElement | null;
  mode?: Mode;
}

const STEPS: Step[] = [
  {
    title: 'Fly',
    text: 'W A S D to fly, Q / E down / up, Shift for speed. Drag empty space (or right-drag) to look around, wheel to zoom. Drag an actor to move their mark.',
    target: () => document.getElementById('stage'),
  },
  {
    title: 'Add a shot',
    text: 'Found a frame? Press C or Add shot: the view becomes the next shot with a frame grab. 1–9 jump between shots; the phone attaches to the one you pick.',
    target: () => document.getElementById('shots-add'),
    mode: 'shots',
  },
  {
    title: 'Pair the phone',
    text: 'Scan this QR with your phone (same Wi-Fi) and tap Start. It becomes the handheld camera on the selected shot; record takes here.',
    target: () => document.getElementById('ph-qr'),
    mode: 'camera',
  },
];

function runTour(show: (m: Mode) => void, done: () => void) {
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
    if (step.mode) show(step.mode);
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
