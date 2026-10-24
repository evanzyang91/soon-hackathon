// DOM bindings for web/phone.html (markup + CSS live there). No logic beyond presentation.
import type { Quat, Vec3 } from '@shared/schema';
import type { ConnState } from './relay-client.ts';
import { drawViewfinder } from './viewfinder.ts';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`phone.html is missing #${id}`);
  return el as T;
}

const CONN_LABEL: Record<ConnState, string> = {
  idle: 'offline',
  connecting: 'connecting…',
  open: 'live',
  reconnecting: 'reconnecting…',
  closed: 'disconnected',
};

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
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let vfCtx: CanvasRenderingContext2D | null = null;

  // iOS Safari ignores user-scalable=no; stop page pinch-zoom from fighting our pinch gesture.
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
  }

  const click = (id: string) => (fn: () => void) =>
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      fn();
    });

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
    showHud(room: string) {
      start.hidden = true;
      hud.hidden = false;
      $('room').textContent = room;
    },
    /** pose=external: the native overlay replaces the page's own controls (ios/README.md). */
    hideForExternal() {
      const ids = ['joystick', 'height', 'controls', 'top-right', 'top-left', 'walk-readout'];
      for (const id of [...ids, 'hint', 'rotate']) $(id).style.display = 'none';
    },
    setConn(s: ConnState) {
      const el = $('conn');
      el.dataset.state = s;
      el.title = CONN_LABEL[s];
      $('conn-label').textContent = CONN_LABEL[s];
    },
    setPeers(laptop: boolean) {
      $('peers').textContent = laptop ? 'director connected' : 'waiting for director';
      $('peers').dataset.ok = String(laptop);
    },
    setCameraName(name: string) {
      $('cam-name').textContent = name;
    },
    setLens(label: string) {
      $('lens').textContent = label;
    },
    /** Scene clock next to the camera name ('' hides it: no scene). */
    setClock(text: string, playing: boolean) {
      const el = $('clock');
      el.hidden = !text;
      if (el.textContent !== text) el.textContent = text;
      el.dataset.playing = String(playing);
    },
    /** Bottom-right render fps + governor level. */
    setPerf(text: string) {
      const el = $('perf');
      if (el.textContent !== text) el.textContent = text;
    },
    setCaption(text: string) {
      const el = $('caption');
      el.textContent = text;
      el.hidden = !text;
    },
    setHint(text: string) {
      $('hint').textContent = text;
    },
    setAttitude(text: string) {
      $('attitude').textContent = text;
    },
    /** How far the joystick has walked the camera from its anchor ('' hides it). */
    setWalkReadout(text: string) {
      const el = $('walk-readout');
      if (el.textContent !== text) el.textContent = text;
    },
    /** ACTION (scene stopped) or CUT (the laptop is running the scene). */
    setAction(running: boolean) {
      const el = $('action');
      if (el.getAttribute('aria-pressed') === String(running)) return;
      el.setAttribute('aria-pressed', String(running));
      el.textContent = running ? 'CUT' : 'ACTION';
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
    toast(msg: string, ms = 1800) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toastEl.hidden = true), ms);
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
    onRecenter: click('recenter'),
    onShutter: click('shutter'),
    onRecord: click('record'),
    onNextCamera: click('next-cam'),
    onAction: click('action'),
    onNextLine: click('next-line'),
  };
}

export type PhoneUi = ReturnType<typeof bindUi>;
