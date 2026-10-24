// Right panel "Look" tab: grade / film / atmosphere / lens / lights for the open scene, with
// presets, reset per group, undo / redo (50 steps), hold-to-compare and a look name. Every change
// renders on the next frame, is saved to scene-<n>/edits.json 300 ms after the last change
// (viewer/look/session.ts) and reaches the phone: the live look in SceneState at ≤ 10 Hz while
// unsaved, then `editsRevision` once it is on disk (the phone re-fetches the file).
//
// Lens: "click to focus" sets the focus distance from a splat raycast at the clicked pixel (Pick
// focus, or Alt+click on the viewport). A dropped camera can carry its own depth of field (stored
// next to the cameras on this laptop); the phone attached to it gets that lens in the live look.
import * as THREE from 'three';
import { Light, Look } from '@shared/look';
import type { SceneState } from '@shared/protocol';
import { LightGizmos } from '../viewer/look/gizmos';
import { clampFocus, focalLengthMm, FOCUS_MAX_M, FOCUS_MIN_M, viewDepth } from '../viewer/look/lens';
import { MAX_SPLAT_LIGHTS } from '../viewer/look/lights';
import {
  applyFullPreset,
  applyLutPreset,
  FULL_PRESETS,
  LUT_LABELS,
  resetGroup,
  type LookGroup,
} from '../viewer/look/presets';
import { LookSession } from '../viewer/look/session';
import type { SceneRuntime } from '../viewer/world';
import type { Director } from './director';
import { h, isTyping } from './dom';
import { GIZMO_LAYER } from './gizmos';
import { storageGet, storageSet } from './storage';

type Dof = Look['dof'];
/**
 * Live look pacing: the director's heartbeat (every 250 ms, director.ts) carries the live look
 * anyway, so one extra send goes out midway between heartbeats: 8 Hz in total (≤ 10 Hz), and
 * none when a heartbeat is due within 60 ms.
 */
const HEARTBEAT_MS = 250;
const LIVE_LOOK_SPACING_MS = HEARTBEAT_MS / 2;
const HEARTBEAT_GRACE_MS = 60;
const TAB_KEY = 'previz:rightTab';

// ---- slider specs ------------------------------------------------------------------------------

interface SliderSpec {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  get(l: Look): number;
  set(l: Look, v: number): Look;
  fmt(v: number): string;
  hint?: string;
}

const signed = (v: number, d = 2) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const field = <K extends keyof Look>(key: K, label: string, min: number, max: number, step: number, fmt: (v: number) => string, hint?: string): SliderSpec => ({
  key: String(key),
  label,
  min,
  max,
  step,
  hint,
  get: (l) => l[key] as number,
  set: (l, v) => ({ ...l, [key]: v }),
  fmt,
});

const GRADE: SliderSpec[] = [
  field('exposure', 'Exposure', -3, 3, 0.05, (v) => `${signed(v)} st`, 'Stops of light (×2 per stop)'),
  field('contrast', 'Contrast', 0.5, 2, 0.01, (v) => v.toFixed(2), 'Around mid grey'),
  field('saturation', 'Saturation', 0, 2, 0.01, (v) => v.toFixed(2)),
  field('temperature', 'Temperature', -1, 1, 0.01, signed, '− cool … + warm (white balance)'),
  field('tint', 'Tint', -1, 1, 0.01, signed, '− green … + magenta'),
  field('shadows', 'Shadows', -1, 1, 0.01, signed, 'Lift or crush the dark tones'),
  field('highlights', 'Highlights', -1, 1, 0.01, signed, 'Brighten or hold back the bright tones'),
];
const FILM: SliderSpec[] = [
  field('lutStrength', 'LUT strength', 0, 1, 0.01, pct),
  field('vignette', 'Vignette', 0, 1, 0.01, pct),
  field('grain', 'Grain', 0, 1, 0.01, pct, 'Animated film grain, strongest in the mid tones'),
  field('bloom', 'Bloom', 0, 1, 0.01, pct, 'Glow around bright lights'),
];
const FOG_DENSITY: SliderSpec = {
  key: 'fog.density',
  label: 'Fog',
  min: 0,
  max: 1,
  step: 0.01,
  get: (l) => l.fog.density,
  set: (l, v) => ({ ...l, fog: { ...l.fog, density: v } }),
  fmt: pct,
  hint: 'Every splat fades toward the fog colour with its distance from the camera',
};
const SKY_STRENGTH: SliderSpec = {
  key: 'skyTint.strength',
  label: 'Sky tint',
  min: 0,
  max: 1,
  step: 0.01,
  get: (l) => l.skyTint.strength,
  set: (l, v) => ({ ...l, skyTint: { ...l.skyTint, strength: v } }),
  fmt: pct,
  hint: 'Recolours far splats above the horizon (luminance kept)',
};
const AMBIENT: SliderSpec = field('ambient', 'Scene light', 0, 1, 0.01, pct, '100% = the world as captured; lower it to let the Look lights carry the scene');

// focus distance and f-stop sliders run on a log scale
const logSpec = (key: string, label: string, lo: number, hi: number, get: (d: Dof) => number, set: (d: Dof, v: number) => Dof, fmt: (v: number) => string): LensSpec => ({
  key,
  label,
  lo,
  hi,
  get,
  set,
  fmt,
});
interface LensSpec {
  key: string;
  label: string;
  lo: number;
  hi: number;
  get(d: Dof): number;
  set(d: Dof, v: number): Dof;
  fmt(v: number): string;
}
const toLog = (v: number, lo: number, hi: number) => Math.log(v / lo) / Math.log(hi / lo);
const fromLog = (t: number, lo: number, hi: number) => lo * (hi / lo) ** t;
const FOCUS: LensSpec = logSpec('dof.focusDistance', 'Focus', FOCUS_MIN_M, FOCUS_MAX_M, (d) => d.focusDistance, (d, v) => ({ ...d, focusDistance: clampFocus(v) }), (v) => (v < 10 ? `${v.toFixed(2)} m` : `${v.toFixed(0)} m`));
const FSTOP: LensSpec = logSpec('dof.fStop', 'Aperture', 0.95, 22, (d) => d.fStop, (d, v) => ({ ...d, fStop: Math.min(22, Math.max(0.95, v)) }), (v) => `f/${v < 10 ? v.toFixed(1) : v.toFixed(0)}`);

// light sliders (per light)
interface LightSpec {
  key: keyof Light;
  label: string;
  min: number;
  max: number;
  step: number;
  fmt(v: number): string;
}
const LIGHT_SLIDERS: LightSpec[] = [
  { key: 'intensity', label: 'Intensity', min: 0, max: 20, step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: 'radius', label: 'Radius', min: 0.5, max: 40, step: 0.1, fmt: (v) => `${v.toFixed(1)} m` },
  { key: 'coneDeg', label: 'Cone', min: 5, max: 120, step: 1, fmt: (v) => `${v.toFixed(0)}°` },
];
const LIGHT_NAMES = ['Key', 'Fill', 'Back', 'Practical'];
const LIGHT_COLORS: Record<Light['kind'], string> = { point: '#ffd2a1', spot: '#fff1d6', sun: '#ffe3b8' };

// ---- mount -------------------------------------------------------------------------------------

export interface LookPanel {
  session: LookSession;
  /** The phone's look right now (scene look + the active camera's lens override). */
  phoneLook(): Look | null;
  /** A dropped camera's own lens, when it has one (the viewport's focus point edits it through here). */
  cameraLens(id: string): Look['dof'] | null;
  /** Replaces a camera's own lens (only cameras that already have one; the Look tab turns it on). */
  setCameraLens(id: string, dof: Look['dof']): void;
}

export function mountLookPanel(director: Director): LookPanel {
  const right = document.getElementById('right');
  if (!right) throw new Error('#right missing from index.html');

  // ---- tabs (Shoot = the existing cards, Look = this panel) ------------------------------------
  const shootCards = [...right.children] as HTMLElement[];
  const section = h('section', { class: 'card grow look-panel', id: 'look-panel', 'data-testid': 'look-panel' });
  const tabs = h('div', { class: 'right-tabs', role: 'tablist' });
  const tabBtn = (id: 'shoot' | 'look', label: string) =>
    h('button', { type: 'button', class: 'tab', 'data-tab': id, 'data-testid': `tab-${id}`, role: 'tab', onclick: () => showTab(id) }, label);
  const shootTab = tabBtn('shoot', 'Shoot');
  const lookTab = tabBtn('look', 'Look');
  tabs.append(shootTab, lookTab);
  right.prepend(tabs);
  right.append(section);
  let activeTab: 'shoot' | 'look' = storageGet<'shoot' | 'look'>(TAB_KEY) === 'look' ? 'look' : 'shoot';
  function showTab(id: 'shoot' | 'look') {
    activeTab = id;
    storageSet(TAB_KEY, id);
    for (const c of shootCards) c.hidden = id !== 'shoot';
    section.hidden = id !== 'look';
    shootTab.classList.toggle('on', id === 'shoot');
    lookTab.classList.toggle('on', id === 'look');
  }
  showTab(activeTab);

  // ---- session + phone link --------------------------------------------------------------------
  /** When the last SceneState carrying the live look went out (ours or the heartbeat's). */
  let lastLookSent = -Infinity;
  /** When the director last broadcast on its own (its heartbeat); -∞ until seen. */
  let lastHeartbeat = -Infinity;
  let ownSend = false;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  const send = (force: boolean) => {
    ownSend = true;
    try {
      director.broadcast(force);
    } finally {
      ownSend = false;
    }
  };
  const broadcast = (force: boolean) => {
    if (broadcastTimer) clearTimeout(broadcastTimer);
    broadcastTimer = null;
    if (force) return send(true);
    const now = performance.now();
    const at = Math.max(now, lastLookSent + LIVE_LOOK_SPACING_MS);
    // the heartbeat is about to carry the latest look anyway (it runs a little late, so "near a
    // heartbeat" counts on both sides of its nominal time)
    if (Number.isFinite(lastHeartbeat)) {
      const phase = (at - lastHeartbeat) % HEARTBEAT_MS;
      if (phase < HEARTBEAT_GRACE_MS || phase > HEARTBEAT_MS - HEARTBEAT_GRACE_MS) return;
    }
    if (at <= now) send(false);
    else broadcastTimer = setTimeout(() => broadcast(false), at - now);
  };
  const session = new LookSession({ onChange: () => render(), onBroadcast: broadcast });

  // per-camera lens overrides: { [cameraId]: dof }, kept next to the cameras (laptop storage)
  let overrides: Record<string, Dof> = {};
  const overridesKey = () => `previz:lens:${director.projectId}:${director.sceneIndex}`;
  const activeOverride = (): Dof | null =>
    (director.activeCameraId && overrides[director.activeCameraId]) || null;
  const saveOverrides = () => storageSet(overridesKey(), overrides);
  const phoneLook = (): Look | null => {
    const look = session.look;
    if (!look) return null;
    const o = activeOverride();
    return o ? { ...look, dof: o } : look;
  };

  director.decorateState = (state: SceneState) => {
    if (!ownSend) lastHeartbeat = performance.now();
    if (!session.sceneLook) return;
    if (session.status !== 'offline' && session.status !== 'loading') state.editsRevision = session.revision;
    if (session.liveLook || activeOverride()) {
      const look = phoneLook();
      if (look) {
        state.look = look as unknown as Record<string, unknown>;
        lastLookSent = performance.now();
      }
    }
  };

  const gizmos = new LightGizmos(GIZMO_LAYER);
  let selectedLight: string | null = null;
  let runtime: SceneRuntime | null = null;
  let offLook: (() => void) | null = null;

  const attach = (rt: SceneRuntime | null) => {
    if (rt === runtime) return;
    offLook?.();
    offLook = null;
    gizmos.group.removeFromParent();
    runtime = rt;
    if (!rt || !director.projectId || director.sceneIndex == null) {
      session.close();
      build();
      return;
    }
    overrides = storageGet<Record<string, Dof>>(overridesKey()) ?? {};
    rt.scene.add(gizmos.group);
    // the phone's view (PiP, view-from-phone, stills from the phone) uses the active camera's lens
    rt.look.viewLook = (camera) =>
      camera === director.phoneCamera || camera === director.shotCamera ? (phoneLook() ?? rt.getLook()) : rt.getLook();
    offLook = rt.look.onChange((look) => {
      gizmos.set(look.lights, selectedLight);
      sync();
    });
    void session.open({ projectId: director.projectId, sceneIndex: director.sceneIndex, look: rt.look });
    build();
  };
  director.on((c) => {
    if (c === 'scene') attach(director.runtime);
    if (c === 'cameras') {
      // a camera was deleted or the active one changed: the phone's lens may differ now
      for (const id of Object.keys(overrides)) if (!director.cameras.some((cam) => cam.id === id)) delete overrides[id];
      saveOverrides();
      sync();
      broadcast(true);
    }
    if (c === 'view') sync();
  });

  // ---- editing helpers -------------------------------------------------------------------------
  const current = () => session.look;
  const change = (next: Look, coalesce: string | null) => session.apply(next, coalesce);
  /** Lens edits go to the active camera's override when it has one, else to the scene look. */
  const changeDof = (fn: (d: Dof) => Dof, coalesce: string | null) => {
    const o = activeOverride();
    if (o && director.activeCameraId) {
      overrides[director.activeCameraId] = fn(o);
      saveOverrides();
      sync();
      broadcast(false);
      return;
    }
    const l = current();
    if (l) change({ ...l, dof: fn(l.dof) }, coalesce);
  };
  const currentDof = (): Dof | null => activeOverride() ?? current()?.dof ?? null;
  const cameraLens = (id: string): Dof | null => overrides[id] ?? null;
  const setCameraLens = (id: string, dof: Dof) => {
    if (!overrides[id]) return;
    overrides[id] = structuredClone(dof);
    saveOverrides();
    sync();
    broadcast(false);
  };

  // ---- DOM -------------------------------------------------------------------------------------
  // controls register a syncer (look → control value); header ones live for the panel's
  // lifetime, body ones are rebuilt with each scene
  const headerSyncers: (() => void)[] = [];
  let bodySyncers: (() => void)[] = [];
  let syncers = headerSyncers;
  const header = h('div', { class: 'look-head' });
  const body = h('div', { class: 'look-body' });
  section.append(header, body);
  const status = h('span', { class: 'look-status small muted', 'data-testid': 'look-status' });
  const undoBtn = h('button', { type: 'button', class: 'icon', title: 'Undo (⌘Z)', 'data-testid': 'look-undo', onclick: () => session.undo() }, '↶');
  const redoBtn = h('button', { type: 'button', class: 'icon', title: 'Redo (⇧⌘Z)', 'data-testid': 'look-redo', onclick: () => session.redo() }, '↷');

  function slider(spec: SliderSpec): HTMLElement {
    const input = h('input', { type: 'range', min: spec.min, max: spec.max, step: spec.step, 'data-testid': `look-${spec.key}` });
    const out = h('span', { class: 'look-val' });
    input.addEventListener('input', () => {
      const l = current();
      if (l) change(spec.set(l, Number(input.value)), spec.key);
    });
    input.addEventListener('change', () => session.seal());
    // double-click a slider: back to its default
    input.addEventListener('dblclick', () => {
      const l = current();
      if (!l) return;
      change(spec.set(l, spec.get(Look.parse({}))), null);
      session.seal();
    });
    syncers.push(() => {
      const l = current();
      if (!l) return;
      const v = spec.get(l);
      if (document.activeElement !== input || Number(input.value) !== v) input.value = String(v);
      out.textContent = spec.fmt(v);
    });
    return h('label', { class: 'look-row', title: spec.hint ?? '' }, h('span', { class: 'look-label' }, spec.label), input, out);
  }

  function lensSlider(spec: LensSpec): HTMLElement {
    const input = h('input', { type: 'range', min: 0, max: 1, step: 0.005, 'data-testid': `look-${spec.key}` });
    const out = h('span', { class: 'look-val' });
    input.addEventListener('input', () => changeDof((d) => spec.set(d, fromLog(Number(input.value), spec.lo, spec.hi)), spec.key));
    input.addEventListener('change', () => session.seal());
    syncers.push(() => {
      const d = currentDof();
      if (!d) return;
      const v = spec.get(d);
      input.value = String(toLog(v, spec.lo, spec.hi));
      out.textContent = spec.fmt(v);
    });
    return h('label', { class: 'look-row' }, h('span', { class: 'look-label' }, spec.label), input, out);
  }

  function colorInput(key: string, get: (l: Look) => string, set: (l: Look, c: string) => Look): HTMLInputElement {
    const input = h('input', { type: 'color', class: 'look-color', 'data-testid': `look-${key}` });
    input.addEventListener('input', () => {
      const l = current();
      if (l) change(set(l, input.value), key);
    });
    input.addEventListener('change', () => session.seal());
    syncers.push(() => {
      const l = current();
      if (l) input.value = get(l);
    });
    return input;
  }

  function group(id: LookGroup, title: string, ...rows: (HTMLElement | null)[]): HTMLElement {
    const reset = h('button', {
      type: 'button',
      class: 'small',
      title: `Reset ${title.toLowerCase()} to defaults`,
      'data-testid': `look-reset-${id}`,
      onclick: (e: Event) => {
        e.preventDefault();
        const l = current();
        if (!l) return;
        if (id === 'lens' && activeOverride() && director.activeCameraId) {
          overrides[director.activeCameraId] = Look.parse({}).dof;
          saveOverrides();
          sync();
          broadcast(true);
          return;
        }
        change(resetGroup(l, id), null);
        session.seal();
      },
    }, 'Reset');
    const open = storageGet<boolean>(`previz:lookGroup:${id}`) ?? id !== 'lights';
    const det = h('details', { class: 'look-group', 'data-group': id, open }, h('summary', {}, h('span', {}, title), h('span', { class: 'spacer' }), reset), ...rows);
    det.addEventListener('toggle', () => storageSet(`previz:lookGroup:${id}`, det.open));
    return det;
  }

  // header: name, presets, undo/redo, compare
  const name = h('input', { class: 'look-name', placeholder: 'Look name', maxlength: 60, 'data-testid': 'look-name', spellcheck: 'false' });
  name.addEventListener('input', () => {
    const l = current();
    if (l) change({ ...l, name: name.value.slice(0, 60) || 'Untitled look' }, 'name');
  });
  name.addEventListener('change', () => session.seal());
  syncers.push(() => {
    const l = current();
    if (l && document.activeElement !== name) name.value = l.name;
  });
  const presets = h('select', { class: 'look-presets', 'data-testid': 'look-presets', title: 'Apply a preset' });
  presets.append(h('option', { value: '' }, 'Presets…'));
  const looksGroup = h('optgroup', { label: 'Looks' });
  FULL_PRESETS.forEach((p, i) => looksGroup.append(h('option', { value: `look:${i}` }, p.name)));
  const lutGroup = h('optgroup', { label: 'LUT' });
  for (const [k, label] of Object.entries(LUT_LABELS)) lutGroup.append(h('option', { value: `lut:${k}` }, label));
  presets.append(looksGroup, lutGroup);
  presets.addEventListener('change', () => {
    const l = current();
    const v = presets.value;
    presets.value = '';
    if (!l || !v) return;
    if (v.startsWith('look:')) change(applyFullPreset(l, FULL_PRESETS[Number(v.slice(5))]!), null);
    else change(applyLutPreset(l, v.slice(4) as Look['lut']), null);
    session.seal();
  });
  const compare = h('button', { type: 'button', class: 'look-compare', title: 'Hold to see the ungraded frame', 'data-testid': 'look-compare' }, 'Compare');
  const setCompare = (on: boolean) => {
    runtime?.look.setCompare(on);
    compare.classList.toggle('on', on);
  };
  compare.addEventListener('pointerdown', (e) => {
    compare.setPointerCapture(e.pointerId);
    setCompare(true);
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) compare.addEventListener(ev, () => setCompare(false));
  header.append(
    h('div', { class: 'row' }, name, undoBtn, redoBtn),
    h('div', { class: 'row' }, presets, h('span', { class: 'spacer' }), compare),
    status,
  );

  // focus picking
  let picking = false;
  const pickBtn = h('button', { type: 'button', class: 'small', title: 'Click the viewport to focus there (or Alt+click any time)', 'data-testid': 'look-pick-focus' }, 'Pick focus');
  pickBtn.addEventListener('click', () => {
    picking = !picking;
    pickBtn.classList.toggle('on', picking);
    director.canvas.classList.toggle('look-picking', picking);
  });
  const raycaster = new THREE.Raycaster();
  /** Focus distance (along the view axis) of the splat / actor under a canvas pixel, or null. */
  const focusAt = (clientX: number, clientY: number): number | null => {
    const rt = director.runtime;
    if (!rt) return null;
    const r = director.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -(((clientY - r.top) / r.height) * 2 - 1));
    const cam = director.mainCamera();
    raycaster.setFromCamera(ndc, cam);
    const targets: THREE.Object3D[] = [...rt.actors.values()].map((a) => a.object);
    if (rt.splat) targets.push(rt.splat);
    const hit = raycaster
      .intersectObjects(targets, true)
      .filter((x) => !(x.object instanceof THREE.Sprite) && x.object.visible)
      .sort((a, b) => a.distance - b.distance)[0];
    if (!hit) return null;
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    return viewDepth(cam.position.toArray() as [number, number, number], fwd.toArray() as [number, number, number], hit.point.toArray() as [number, number, number]);
  };
  director.canvas.addEventListener(
    'click',
    (e) => {
      if (!picking && !e.altKey) return;
      const d = focusAt(e.clientX, e.clientY);
      picking = false;
      pickBtn.classList.remove('on');
      director.canvas.classList.remove('look-picking');
      if (d == null || !(d > 0)) {
        flashStatus('No splat under the cursor');
        return;
      }
      e.stopPropagation();
      changeDof((dof) => ({ ...dof, enabled: true, focusDistance: clampFocus(d) }), null);
      session.seal();
      flashStatus(`Focus ${d.toFixed(2)} m`);
    },
    { capture: true },
  );
  let flash: { text: string; until: number } | null = null;
  const flashStatus = (text: string) => {
    flash = { text, until: performance.now() + 2500 };
    render();
    setTimeout(render, 2600);
  };

  // ---- build per scene -------------------------------------------------------------------------
  const lightsBox = h('div', { class: 'look-lights' });
  let lightsKey = '';
  function build() {
    bodySyncers = [];
    syncers = bodySyncers;
    body.replaceChildren();
    lightsKey = '';
    if (!runtime) {
      body.append(h('div', { class: 'muted' }, 'Open a scene to grade it.'));
      render();
      return;
    }
    const lutSel = h('select', { 'data-testid': 'look-lut' });
    for (const [k, label] of Object.entries(LUT_LABELS)) lutSel.append(h('option', { value: k }, label));
    lutSel.addEventListener('change', () => {
      const l = current();
      if (l) change(applyLutPreset(l, lutSel.value as Look['lut']), null);
      session.seal();
    });
    syncers.push(() => {
      const l = current();
      if (l) lutSel.value = l.lut;
    });
    const dofOn = h('input', { type: 'checkbox', 'data-testid': 'look-dof' });
    dofOn.addEventListener('change', () => changeDof((d) => ({ ...d, enabled: dofOn.checked }), null));
    const lensInfo = h('span', { class: 'small muted' });
    const overrideBox = h('input', { type: 'checkbox', 'data-testid': 'look-lens-override' });
    const overrideLabel = h('span', { class: 'small' });
    overrideBox.addEventListener('change', () => {
      const id = director.activeCameraId;
      const l = current();
      if (!id || !l) return;
      if (overrideBox.checked) overrides[id] = structuredClone(l.dof);
      else delete overrides[id];
      saveOverrides();
      sync();
      broadcast(true);
    });
    syncers.push(() => {
      const d = currentDof();
      if (d) dofOn.checked = d.enabled;
      const cam = director.mainCamera();
      lensInfo.textContent = `${Math.round(focalLengthMm(cam.fov))} mm view`;
      const active = director.cameras.find((c) => c.id === director.activeCameraId);
      overrideBox.disabled = !active;
      overrideBox.checked = !!activeOverride();
      overrideLabel.textContent = active ? `Own lens for camera “${active.name}”` : 'Own lens per camera (drop one first)';
      overrideLabel.title = activeOverride()
        ? `Focus / aperture above are camera “${active?.name}”'s: the phone on it (and the PiP) use them; the director view keeps the scene lens`
        : 'Give the active camera its own depth of field; the phone attached to it adopts it';
    });

    body.append(
      group('grade', 'Exposure & grade', ...GRADE.map(slider)),
      group('film', 'Film', h('label', { class: 'look-row' }, h('span', { class: 'look-label' }, 'LUT'), lutSel), ...FILM.map(slider)),
      group(
        'atmosphere',
        'Atmosphere',
        h('div', { class: 'look-row' }, slider(FOG_DENSITY), colorInput('fog.color', (l) => l.fog.color, (l, c) => ({ ...l, fog: { ...l.fog, color: c } }))),
        h('div', { class: 'look-row' }, slider(SKY_STRENGTH), colorInput('skyTint.color', (l) => l.skyTint.color, (l, c) => ({ ...l, skyTint: { ...l.skyTint, color: c } }))),
      ),
      group(
        'lens',
        'Lens',
        h('label', { class: 'look-row' }, dofOn, h('span', {}, 'Depth of field'), h('span', { class: 'spacer' }), lensInfo),
        lensSlider(FOCUS),
        lensSlider(FSTOP),
        h('div', { class: 'row' }, pickBtn, h('span', { class: 'small muted' }, 'or Alt+click the view')),
        h('label', { class: 'look-row' }, overrideBox, overrideLabel),
      ),
      group('lights', 'Lights', slider(AMBIENT), lightsBox),
    );
    sync();
  }

  // ---- lights ----------------------------------------------------------------------------------
  const setLight = (id: string, fn: (l: Light) => Light, coalesce: string | null) => {
    const look = current();
    if (look) change({ ...look, lights: look.lights.map((l) => (l.id === id ? fn(l) : l)) }, coalesce);
  };
  const cameraFrame = () => {
    const cam = director.mainCamera();
    const fwd = cam.getWorldDirection(new THREE.Vector3());
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const at = (d: number) => cam.position.clone().addScaledVector(fwd, d).toArray().map(r2) as [number, number, number];
    return { position: cam.position.toArray().map(r2) as [number, number, number], at };
  };
  const addLight = (kind: Light['kind']) => {
    const look = current();
    if (!look || look.lights.length >= MAX_SPLAT_LIGHTS) return;
    const { at } = cameraFrame();
    const front = at(2.5);
    const used = new Set(look.lights.map((l) => l.name));
    const name = LIGHT_NAMES.find((n) => !used.has(n)) ?? `Light ${look.lights.length + 1}`;
    const position: [number, number, number] =
      kind === 'sun' ? [front[0] + 6, 12, front[2] + 4] : [front[0], Math.max(front[1] + 0.6, 1.8), front[2]];
    const light = Light.parse({
      id: Math.random().toString(36).slice(2, 10),
      name,
      kind,
      position,
      target: kind === 'point' ? undefined : kind === 'sun' ? [front[0], 0, front[2]] : [front[0], 0, front[2]],
      color: LIGHT_COLORS[kind],
      intensity: kind === 'sun' ? 1.2 : 3,
      radius: kind === 'spot' ? 10 : 6,
      coneDeg: 50,
    });
    selectedLight = light.id;
    change({ ...look, lights: [...look.lights, light] }, null);
    session.seal();
  };

  function lightCard(l: Light): HTMLElement {
    const id = l.id;
    const sel = selectedLight === id;
    const color = h('input', { type: 'color', class: 'look-color', value: l.color, title: 'Colour' });
    color.addEventListener('input', () => setLight(id, (x) => ({ ...x, color: color.value }), `light:${id}:color`));
    color.addEventListener('change', () => session.seal());
    const nameIn = h('input', { class: 'look-light-name', value: l.name, maxlength: 30 });
    nameIn.addEventListener('change', () => setLight(id, (x) => ({ ...x, name: nameIn.value.trim() || x.name }), null));
    const kind = h('select', {}, ...(['point', 'spot', 'sun'] as const).map((k) => h('option', { value: k, selected: k === l.kind }, k)));
    kind.addEventListener('change', () => {
      const k = kind.value as Light['kind'];
      setLight(id, (x) => ({ ...x, kind: k, target: k === 'point' ? x.target : (x.target ?? [x.position[0], 0, x.position[2]]) }), null);
    });
    const on = h('input', { type: 'checkbox', checked: l.enabled, title: 'On / off' });
    on.addEventListener('change', () => setLight(id, (x) => ({ ...x, enabled: on.checked }), null));
    const del = h('button', {
      type: 'button',
      class: 'icon',
      title: 'Delete light',
      onclick: () => {
        const look = current();
        if (look) change({ ...look, lights: look.lights.filter((x) => x.id !== id) }, null);
        session.seal();
      },
    }, '×');
    const rows: HTMLElement[] = [];
    for (const s of LIGHT_SLIDERS) {
      if (s.key === 'coneDeg' && l.kind !== 'spot') continue;
      if (s.key === 'radius' && l.kind === 'sun') continue;
      const v = l[s.key] as number;
      const input = h('input', { type: 'range', min: s.min, max: s.max, step: s.step, value: v });
      const out = h('span', { class: 'look-val' }, s.fmt(v));
      input.addEventListener('input', () => {
        out.textContent = s.fmt(Number(input.value));
        setLight(id, (x) => ({ ...x, [s.key]: Number(input.value) }), `light:${id}:${s.key}`);
      });
      input.addEventListener('change', () => session.seal());
      rows.push(h('label', { class: 'look-row' }, h('span', { class: 'look-label' }, s.label), input, out));
    }
    const vec = (label: string, v: [number, number, number], set: (x: Light, p: [number, number, number]) => Light) => {
      const inputs = v.map((c, i) => {
        const n = h('input', { type: 'number', step: 0.1, value: c.toFixed(2), class: 'look-num', title: 'xyz'[i] });
        n.addEventListener('change', () => {
          const p = inputs.map((x) => Number(x.value)) as [number, number, number];
          if (p.every(Number.isFinite)) setLight(id, (x) => set(x, p), null);
        });
        return n;
      });
      return h('div', { class: 'look-row look-vec' }, h('span', { class: 'look-label' }, label), ...inputs);
    };
    rows.push(vec('Position', l.position, (x, p) => ({ ...x, position: p })));
    if (l.kind !== 'point') rows.push(vec('Aim at', l.target ?? [l.position[0], 0, l.position[2]], (x, p) => ({ ...x, target: p })));
    const place = h('button', {
      type: 'button',
      class: 'small',
      title: 'Move the light to where the view camera is (spots and suns aim where it looks)',
      'data-testid': 'look-light-place',
      onclick: () => {
        const { position, at } = cameraFrame();
        setLight(id, (x) => ({ ...x, position, target: x.kind === 'point' ? x.target : at(4) }), null);
        session.seal();
      },
    }, 'Place at camera');
    const head = h('div', { class: 'row' }, color, nameIn, kind, on, del);
    const card = h('div', { class: `look-light${sel ? ' selected' : ''}${l.enabled ? '' : ' off'}`, 'data-light': id }, head, ...rows, h('div', { class: 'row' }, place));
    card.addEventListener('pointerdown', () => {
      if (selectedLight === id) return;
      selectedLight = id;
      gizmos.set(current()?.lights ?? [], selectedLight);
      for (const c of lightsBox.querySelectorAll('.look-light')) c.classList.toggle('selected', (c as HTMLElement).dataset.light === id);
    });
    return card;
  }

  function renderLights() {
    const look = current();
    const lights = look?.lights ?? [];
    const key = JSON.stringify(lights);
    if (key === lightsKey) return;
    // keep focus while typing a name / number in a light card
    const focused = document.activeElement as HTMLInputElement | null;
    if (lightsKey && focused && lightsBox.contains(focused) && focused.tagName === 'INPUT' && ['text', 'number'].includes(focused.type)) {
      lightsKey = key;
      return;
    }
    lightsKey = key;
    const full = lights.length >= MAX_SPLAT_LIGHTS;
    const add = (k: Light['kind'], label: string) =>
      h('button', { type: 'button', class: 'small', disabled: full, 'data-testid': `look-add-${k}`, onclick: () => addLight(k) }, label);
    lightsBox.replaceChildren(
      ...lights.map(lightCard),
      h('div', { class: 'row wrap' }, add('point', '+ Point'), add('spot', '+ Spot'), add('sun', '+ Sun'), full ? h('span', { class: 'small muted' }, `max ${MAX_SPLAT_LIGHTS}`) : null),
    );
    if (!lights.length)
      lightsBox.append(h('div', { class: 'small muted' }, 'Lights brighten nearby splats and actors (no new shadows: the world is baked).'));
  }

  // ---- render ----------------------------------------------------------------------------------
  const STATUS: Record<string, string> = {
    idle: '',
    loading: 'Loading look…',
    saved: 'Saved',
    unsaved: 'Unsaved',
    saving: 'Saving…',
    offline: 'Not saved (no project for this scene)',
    error: 'Save failed',
  };
  function sync() {
    for (const s of headerSyncers) s();
    for (const s of bodySyncers) s();
    renderLights();
    render();
  }
  function render() {
    const now = performance.now();
    if (flash && now > flash.until) flash = null;
    const s = session.status;
    status.textContent = flash?.text ?? `${STATUS[s] ?? s}${s === 'saved' ? ` · rev ${session.revision}` : ''}${session.error && s === 'error' ? `: ${session.error}` : ''}`;
    status.dataset.status = s;
    status.dataset.revision = String(session.revision);
    undoBtn.disabled = !session.history?.canUndo;
    redoBtn.disabled = !session.history?.canRedo;
    compare.disabled = !runtime;
    presets.disabled = !runtime;
    name.disabled = !runtime;
  }

  // ---- keyboard: undo / redo while the Look tab is open ------------------------------------------
  window.addEventListener('keydown', (e) => {
    // the panel itself must be showing (other tabs, e.g. Edit, hide it without telling us)
    if (section.hidden || !(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ') return;
    if (isTyping(e.target)) return;
    e.preventDefault();
    if (e.shiftKey) session.redo();
    else session.undo();
  });

  attach(director.runtime);
  const panel = { session, phoneLook, cameraLens, setCameraLens };
  // debug / e2e: window.__look.session.look, .phoneLook()
  Object.defineProperty(window, '__look', { configurable: true, value: panel });
  return panel;
}
