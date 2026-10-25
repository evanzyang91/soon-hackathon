// DOM bindings for web/phone.html (markup + CSS live there). No logic beyond presentation.
import type { Quat, Vec3 } from '@shared/schema';
import { drawViewfinder } from './viewfinder.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`phone.html is missing #${id}`);
  return el as T;
}

/** The connection dot: green = the laptop is there, amber = on the way / waiting, red = cut off. */
export type LinkLevel = 'ok' | 'wait' | 'bad';

/** One row of the camera popover (a shot of the scene's list). */
export interface CamMenuShot {
  id: string;
  /** "1B" */
  number: string;
  /** "Two-shot" ('' for an unnamed "Shot 1B") */
  name: string;
  /** "35 mm" */
  lens: string;
}

export interface CamMenu {
  shots: CamMenuShot[];
  /** The shot the phone is on; null = handheld. */
  current: string | null;
}

export interface CamMenuHandlers {
  /** A shot, or null for Handheld (free). */
  pick(id: string | null): void;
  /** "Add shot from here". */
  add(): void;
}

const NS = 'http://www.w3.org/2000/svg';
/** 16-unit stroke icons for the popover (the laptop's icons.ts paths). */
const ICON = {
  phone: '<rect x="4.75" y="1.75" width="6.5" height="12.5" rx="1.5"/><path d="M7.25 11.75h1.5"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
} as const;
const svgIcon = (name: keyof typeof ICON) => {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICON[name];
  return svg;
};
const span = (cls: string, content: string | Node) => {
  const el = document.createElement('span');
  el.className = cls;
  el.append(content);
  return el;
};

/** A press this long on the play button is a hold (the next line), not a tap. */
const HOLD_MS = 550;
/** A sideways drag this far on the label is a swipe (next / previous shot). */
const SWIPE_PX = 36;

export function bindUi() {
  const start = $('start');
  const hud = $('hud');
  const glCanvas = $<HTMLCanvasElement>('gl');
  const vfCanvas = $<HTMLCanvasElement>('vf');
  const roomInput = $<HTMLInputElement>('room-input');
  const startButton = $<HTMLButtonElement>('start-button');
  const toastEl = $('toast');
  const flashEl = $('flash');
  const recBtn = $<HTMLButtonElement>('record');
  const recBadge = $('rec-badge');
  const camBtn = $<HTMLButtonElement>('cam');
  const menuEl = $('cam-menu');
  const label = $('cam-label');
  const playBtn = $<HTMLButtonElement>('play');
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let vfCtx: CanvasRenderingContext2D | null = null;
  /** A held toast (the first-run hint) stays up until then; others wait for it. */
  let holdUntil = 0;
  let queued: { msg: string; ms: number } | null = null;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  let menu: { data: CamMenu; on: CamMenuHandlers } | null = null;
  /** A tap outside the open popover only closes it: the click it makes is swallowed. */
  let swallowClickUntil = 0;

  // iOS Safari ignores user-scalable=no; stop page pinch-zoom from fighting our pinch gesture.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }

  const click = (id: string) => (fn: () => void) =>
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });

  const showToast = (msg: string, ms: number) => {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
  };

  // ---- the camera popover ----------------------------------------------------------------------
  const menuButton = (cls: string, testid: string, on: () => void, ...children: Node[]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.dataset.testid = testid;
    b.append(...children);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      on();
    });
    return b;
  };

  const renderMenu = () => {
    if (!menu) return;
    const { data, on } = menu;
    const list = document.createElement('div');
    list.className = 'cam-shots';
    for (const s of data.shots) {
      const b = menuButton(
        'cam-item',
        'cam-shot',
        () => (close(), on.pick(s.id)),
        span('num', s.number),
        span('name', s.name || `Shot ${s.number}`),
        span('lens', s.lens),
      );
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(s.id === data.current));
      b.dataset.id = s.id;
      list.append(b);
    }
    const handheld = menuButton(
      'cam-item',
      'cam-handheld',
      () => (close(), on.pick(null)),
      span('num', svgIcon('phone')),
      span('name', 'Handheld (free)'),
    );
    handheld.setAttribute('role', 'menuitemradio');
    handheld.setAttribute('aria-checked', String(data.current === null));
    const add = menuButton(
      'cam-item',
      'cam-add',
      () => (close(), on.add()),
      span('num', svgIcon('plus')),
      span('name', 'Add shot from here'),
    );
    add.setAttribute('role', 'menuitem');
    const scroll = menuEl.querySelector('.cam-shots')?.scrollTop ?? 0;
    const sep = document.createElement('div');
    sep.className = 'sep';
    menuEl.replaceChildren(...(data.shots.length ? [list, sep] : []), handheld, add);
    list.scrollTop = scroll;
  };

  /**
   * Anchored to the camera button: left of the column of controls it is in (landscape), else above
   * the row (portrait), clear of the shutter's ring.
   */
  const place = () => {
    const r = camBtn.getBoundingClientRect();
    const col = (camBtn.parentElement ?? camBtn).getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const m = 14;
    menuEl.style.maxHeight = `${H - 16}px`;
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    let left: number;
    let top: number;
    if (col.left - m - w >= 8) {
      left = col.left - m - w;
      top = clamp(r.bottom - h, 8, H - 8 - h);
    } else {
      left = clamp(r.left + r.width / 2 - w / 2, 8, W - 8 - w);
      top = Math.max(8, col.top - m - h);
    }
    menuEl.style.left = `${Math.round(left)}px`;
    menuEl.style.top = `${Math.round(top)}px`;
  };

  function close() {
    if (!menu) return;
    menu = null;
    menuEl.hidden = true;
    menuEl.replaceChildren();
    camBtn.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!menu) return;
      const t = e.target as Node;
      if (menuEl.contains(t) || camBtn.contains(t)) return;
      close();
      swallowClickUntil = performance.now() + 600;
    },
    { capture: true },
  );
  document.addEventListener(
    'click',
    (e) => {
      if (performance.now() < swallowClickUntil) {
        swallowClickUntil = 0;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    { capture: true },
  );
  document.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  window.addEventListener('resize', () => menu && place());

  return {
    roomInput,
    startButton,
    glCanvas,
    vfCanvas,
    stage: $('stage'),
    joystick: { zone: $('joystick'), base: $('joy-base'), knob: $('joy-knob') },
    height: { zone: $('height'), knob: $('height-knob') },

    startError(msg: string) {
      $('start-error').textContent = msg;
    },
    showHud() {
      start.hidden = true;
      hud.hidden = false;
    },
    /** The dot's colour (`level`) and blink (`state` reconnecting); `text` is its tooltip. */
    setLink(state: string, level: LinkLevel, text: string) {
      const el = $('conn');
      el.dataset.state = state;
      el.dataset.level = level;
      el.title = text;
      el.setAttribute('aria-label', text);
    },
    /** The one label: "1B · Two-shot · 35 mm" or "Handheld · 35 mm". */
    setLabel(text: string) {
      const el = $('cam-name');
      if (el.textContent !== text) el.textContent = text;
    },
    /** `?perf=1`: render fps + governor level, bottom right. */
    setPerf(text: string) {
      const el = $('perf');
      el.hidden = !text;
      if (el.textContent !== text) el.textContent = text;
    },
    setCaption(text: string) {
      const el = $('caption');
      el.textContent = text;
      el.hidden = !text;
    },
    /** The play button shows pause while the laptop runs the scene. */
    setPlaying(running: boolean) {
      if (playBtn.getAttribute('aria-pressed') === String(running)) return;
      playBtn.setAttribute('aria-pressed', String(running));
      playBtn.setAttribute('aria-label', running ? 'Stop the scene' : 'Play the scene');
    },
    setRecording(on: boolean) {
      recBtn.setAttribute('aria-pressed', String(on));
      recBadge.hidden = !on;
      if (!on) $('rec-time').textContent = '00:00';
    },
    setRecordTime(seconds: number) {
      const m = Math.floor(seconds / 60);
      const s = Math.floor(seconds % 60);
      $('rec-time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },
    setViewMode(mode: 'viewfinder' | 'webgl') {
      document.body.dataset.view = mode;
    },
    /**
     * A one-line message under the label. `hold`: nothing replaces it while it shows (the
     * first-run hint); a toast that arrives meanwhile shows after it.
     */
    toast(msg: string, ms = 1800, opts: { hold?: boolean } = {}) {
      const now = performance.now();
      if (!opts.hold && now < holdUntil) {
        queued = { msg, ms };
        if (queueTimer) clearTimeout(queueTimer);
        queueTimer = setTimeout(() => {
          queueTimer = null;
          if (queued) showToast(queued.msg, queued.ms);
          queued = null;
        }, holdUntil - now);
        return;
      }
      if (opts.hold) holdUntil = now + ms;
      showToast(msg, ms);
    },
    flash() {
      flashEl.classList.remove('go');
      void flashEl.offsetWidth; // restart the CSS animation
      flashEl.classList.add('go');
    },
    /** Viewfinder used before / without the 3D view module. */
    drawFallback(q: Quat, fovDeg: number, nudge: Vec3, note: string) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (vfCanvas.width !== Math.round(w * dpr) || vfCanvas.height !== Math.round(h * dpr)) {
        vfCanvas.width = Math.round(w * dpr);
        vfCanvas.height = Math.round(h * dpr);
        vfCtx = null;
      }
      vfCtx ??= vfCanvas.getContext('2d');
      if (!vfCtx) return;
      vfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      glCanvas.style.display = 'none';
      vfCanvas.style.display = 'block';
      drawViewfinder(vfCtx, w, h, { q, fovDeg, nudge, note });
    },

    // ---- the camera popover ----
    get camMenuOpen() {
      return !!menu;
    },
    openCamMenu(data: CamMenu, on: CamMenuHandlers) {
      menu = { data, on };
      renderMenu();
      menuEl.hidden = false;
      camBtn.setAttribute('aria-expanded', 'true');
      place();
    },
    /** The scene's shots changed while the popover is open. */
    updateCamMenu(data: CamMenu) {
      // (SceneState arrives at 4 Hz: rebuilding an unchanged list would eat a tap in progress)
      if (!menu || JSON.stringify(data) === JSON.stringify(menu.data)) return;
      menu.data = data;
      renderMenu();
      place();
    },
    closeCamMenu: close,

    onRecenter: click('recenter'),
    onShutter: click('shutter'),
    onRecord: click('record'),
    onCam: click('cam'),
    /** Tap: play / stop the scene; hold: the next line. */
    onPlay(tap: () => void, hold: () => void) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let held = false;
      const cancel = () => {
        if (timer) clearTimeout(timer);
        timer = null;
      };
      playBtn.addEventListener('pointerdown', () => {
        held = false;
        cancel();
        timer = setTimeout(() => {
          timer = null;
          held = true;
          hold();
        }, HOLD_MS);
      });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave'] as const)
        playBtn.addEventListener(ev, cancel);
      playBtn.addEventListener('contextmenu', (e) => e.preventDefault());
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (held) held = false;
        else tap();
      });
    },
    /** A sideways swipe on the label: +1 = next shot (swipe left), -1 = previous. */
    onLabelSwipe(fn: (dir: 1 | -1) => void) {
      let from: { x: number; y: number; id: number } | null = null;
      label.addEventListener('pointerdown', (e) => {
        from = { x: e.clientX, y: e.clientY, id: e.pointerId };
        label.setPointerCapture?.(e.pointerId);
      });
      label.addEventListener('pointerup', (e) => {
        if (!from || from.id !== e.pointerId) return;
        const dx = e.clientX - from.x;
        const dy = e.clientY - from.y;
        from = null;
        if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > 1.5 * Math.abs(dy)) fn(dx < 0 ? 1 : -1);
      });
      label.addEventListener('pointercancel', () => (from = null));
    },
  };
}

export type PhoneUi = ReturnType<typeof bindUi>;
