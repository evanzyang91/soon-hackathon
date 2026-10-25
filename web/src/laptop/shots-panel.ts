// Shots mode (docs/PLAN-v4.md "Coverage"): the open scene's shot list, numbered 1A, 1B… Each shot
// has a frame grab, a lens (mm), a camera height and a note; the director renames, reorders,
// duplicates and deletes them, adds the current view as a shot (C) and re-grabs a frame (F).
//
// Persistence: scene-<n>/shots.json through ShotListClient (revision-checked, debounced). The first
// time a scene without one opens, the list is seeded with suggested coverage framed on where the
// cast stands (viewer/shots.ts) once the scene has settled; Refresh coverage frames the suggested
// shots again (the director's own stay). A suggested shot the director edits becomes theirs.
//
// The phone: director.cameras is this list as DropCameras (same ids, names "1B · Two-shot"), so
// SceneState.cameras reaches the phone unchanged; selecting a shot flies the view there and makes
// it the phone's (activeCameraId). Moves, deletes and undo of a shot's frustum in the viewport go
// through the director's cameras and come back here (reconcile).
//
// Selection: the selected shot's frame guide (viewer/frame-guide.ts) and label draw over the
// viewport; moving or zooming the view deselects it (the phone stays on its shot).
import { api } from '@shared/api';
import { fovDegForLens, lensLabel, LENS_STOPS_MM, nearestLensMm } from '@shared/lens';
import type { DropCamera } from '@shared/protocol';
import type { Quat, SuggestedShot, Vec3 } from '@shared/schema';
import { SHOT_FRAME_MAX_BYTES, shotNumber, type Shot } from '@shared/shots';
import {
  FrameGuide,
  GUIDE_ASPECT,
  guideRect,
  shotFovForView,
  viewFovForShot,
  type GuideAspect,
} from '../viewer/frame-guide';
import type { SceneRuntime } from '../viewer/world';
import { castKey, type Director } from './director';
import { h, isTyping } from './dom';
import { GIZMO_LAYER } from './gizmos';
import { icon } from './icons';
import type { Manipulation } from './manipulate';
import { ShotListClient } from './shots-client';
import { storageDel, storageGet, storageSet } from './storage';

/** The lenses the picker offers (full-frame equivalent). */
const PICKER_MM = LENS_STOPS_MM.filter((mm) => mm >= 18 && mm <= 135);
const GUIDE_KEY = 'previz:guide';
const AUTO_NAME = /^Shot \d+[A-Z]+$/;
const uid = () => Math.random().toString(36).slice(2, 10);
const clampFov = (f: number) => Math.min(120, Math.max(10, Math.round(f * 100) / 100));
const round3 = (v: number[]) => v.map((x) => Math.round(x * 1e4) / 1e4);
const near = (a: readonly number[], b: readonly number[], eps: number) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

export interface ShotsPanel {
  /** The open scene's shots, in order (empty while none is open or it is loading). */
  shots(): readonly Shot[];
  selected(): string | null;
  /** Flies to a shot, selects it and puts the phone on it (null: deselect). */
  select(id: string | null): void;
  /** The current view as a new shot ("Shot 1F"), selected, with its frame grabbed (C). */
  addShot(): Promise<Shot | null>;
  /** Grabs the frame of a shot (default the selected one) from the view at it (F). */
  grabFrame(id?: string): Promise<boolean>;
  /** Grabs a frame for every shot without one (the view visits each, then comes back). */
  grabMissing(progress?: (done: number, total: number) => void): Promise<void>;
  /** Stores unsaved changes now. */
  flush(): Promise<void>;
  /** URL of a shot's frame (cache-busted by its grab time), null without one. */
  frameUrl(shot: Shot): string | null;
  guideAspect(): GuideAspect;
  setGuideAspect(a: GuideAspect): void;
  onChange(fn: () => void): () => void;
}

export interface ShotsPanelOptions {
  toast(text: string): void;
  /** Shows the Shots mode (the tour, a key that needs the list). */
  showMode(): void;
}

export function mountShotsPanel(director: Director, manip: Manipulation, opts: ShotsPanelOptions): ShotsPanel {
  const pane = document.getElementById('pane-shots')!;
  const guide = new FrameGuide(director.canvas.parentElement!);
  const listeners = new Set<() => void>();

  let client: ShotListClient | null = null;
  let openedRt: SceneRuntime | null = null;
  let selected: string | null = null;
  /** Where the view sits while a shot is selected (its fov opens wider for the guide's matte). */
  let target: { position: Vec3; quaternion: Quat; fov: number } | null = null;
  let aspect: GuideAspect = storageGet<GuideAspect>(GUIDE_KEY) === '2.39' ? '2.39' : '16:9';
  /** Shots deleted in the viewport (⌫), kept whole so ⌘Z brings back their frame and note. */
  const stash = new Map<string, Shot>();
  /** The cast's spots when the coverage was framed: a change offers Refresh coverage. */
  let coverageKey = '';
  let castMoved = false;
  let busy: string | null = null;

  const shots = () => client?.shots ?? [];
  const find = (id: string | null) => (id ? (shots().find((s) => s.id === id) ?? null) : null);
  const sceneN = () => director.sceneIndex ?? 0;
  const num = (i: number) => shotNumber(sceneN(), i);
  const changed = () => {
    for (const fn of listeners) fn();
  };

  // ---- DOM ------------------------------------------------------------------------------------
  const addBtn = h(
    'button',
    { type: 'button', class: 'primary', id: 'shots-add', 'data-testid': 'add-shot', title: 'Add the current view as a shot and grab its frame (C)', onclick: () => void addShot() },
    icon('plus'),
    'Add shot',
  );
  const refreshBtn = h(
    'button',
    { type: 'button', 'data-testid': 'refresh-coverage', title: 'Frame the suggested coverage again on where the cast stands now (your own shots stay)', onclick: () => refreshCoverage() },
    'Refresh coverage',
  );
  const framesBtn = h(
    'button',
    { type: 'button', class: 'small', 'data-testid': 'grab-frames', title: 'Grab a frame for every shot that has none (the view visits each and comes back)', onclick: () => void grabMissing() },
    icon('frame'),
    'Frames',
  );
  const status = h('span', { class: 'small muted shots-status', 'data-testid': 'shots-status' });
  const hint = h('div', { class: 'ruled warn small shots-hint', hidden: true, 'data-testid': 'coverage-stale' });
  const list = h('div', { class: 'shot-list', id: 'shot-list', 'data-testid': 'shot-list' });
  pane.append(
    h('section', { class: 'card' }, h('div', { class: 'row' }, addBtn, refreshBtn, h('span', { class: 'spacer' }), framesBtn), hint),
    h('section', { class: 'card grow' }, h('h2', {}, 'Shot list', h('span', { class: 'spacer' }), status), list),
  );

  // ---- shots <-> the phone's cameras ------------------------------------------------------------
  const toCamera = (s: Shot, i: number): DropCamera => ({
    id: s.id,
    name: `${num(i)} · ${s.name}`,
    position: s.position,
    quaternion: s.quaternion,
    fovDeg: s.fovDeg,
  });
  let pushing = false;
  const pushCameras = () => {
    pushing = true;
    try {
      director.setCameras(shots().map(toCamera), director.activeCameraId);
    } finally {
      pushing = false;
    }
  };

  /** "Shot 1F" follows its number until the director renames it. */
  const renumber = (list: Shot[]) =>
    list.map((s, i) => (AUTO_NAME.test(s.name) && s.name !== `Shot ${num(i)}` ? { ...s, name: `Shot ${num(i)}` } : s));
  /** A list change: stored (debounced), shown, and handed to the phone. */
  const edit = (fn: (list: Shot[]) => Shot[], now = false) => {
    if (!client?.loaded) return;
    client.edit((l) => renumber(fn(l)), now);
    if (selected && !find(selected)) deselect();
    pushCameras();
  };
  /** The director's change to a suggested shot makes it theirs. */
  const own = (id: string, patch: Partial<Shot>) =>
    edit((l) => l.map((s) => (s.id === id ? { ...s, ...patch, source: 'director' as const } : s)));

  const heightAt = (rt: SceneRuntime, p: Vec3) => Math.round((p[1] - rt.groundY(p[0], p[2])) * 100) / 100;

  /** The scene's dialogue ids a suggested shot covers: a close-up or the "on X" side its speaker's, a wide everyone's. */
  const coveredLines = (rt: SceneRuntime, name: string): string[] => {
    const lines = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    const who = (n: string) => rt.manifest.characters.find((c) => c.name.toLowerCase() === n.trim().toLowerCase())?.id;
    const m = /^Close-up (.+)$/.exec(name) ?? / on (.+)$/.exec(name);
    const id = m ? who(m[1]!) : undefined;
    return lines.filter((l) => !id || l.characterId === id).map((l) => l.id);
  };

  /** Suggested coverage on where the cast stands now (the plan's own shots for a scene without actors). */
  const coverage = (rt: SceneRuntime): Shot[] => {
    const live = director.suggestedShots(GUIDE_ASPECT['16:9']);
    const from: SuggestedShot[] = live.length ? live : rt.manifest.plan.shots;
    return from.map((s) => ({
      id: uid(),
      name: s.name.slice(0, 60),
      position: round3(s.position) as Vec3,
      quaternion: round3(s.quaternion) as Quat,
      fovDeg: clampFov(s.fovDeg),
      heightM: heightAt(rt, s.position),
      lines: coveredLines(rt, s.name),
      source: 'suggested' as const,
    }));
  };

  /** Cameras the laptop kept before shot lists existed (localStorage) become the director's shots. */
  const legacyKey = (p: string, n: number) => `previz:cams:${p}:${n}`;
  const legacy = (rt: SceneRuntime, p: string, n: number): Shot[] =>
    (storageGet<{ cameras?: DropCamera[] }>(legacyKey(p, n))?.cameras ?? []).map((c) => ({
      id: /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(c.id) ? c.id : uid(),
      name: (c.name || 'Shot').slice(0, 60),
      position: c.position,
      quaternion: c.quaternion,
      fovDeg: clampFov(c.fovDeg),
      heightM: heightAt(rt, c.position),
      lines: [],
      source: 'director' as const,
    }));

  /** Waits until the cast stops moving (collider placement, edits loading), at most ~4 s. */
  const settle = async (rt: SceneRuntime) => {
    await rt.colliderReady.catch(() => null);
    let key = castKey(rt);
    let stable = 0;
    for (let i = 0; i < 16 && stable < 2 && director.runtime === rt; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const k = castKey(rt);
      stable = k === key ? stable + 1 : 0;
      key = k;
    }
  };

  const open = async (rt: SceneRuntime | null) => {
    if (rt === openedRt) return;
    void client?.flush().catch(() => {});
    openedRt = rt;
    deselect();
    stash.clear();
    castMoved = false;
    const p = director.projectId;
    const n = director.sceneIndex;
    if (!rt || !p || n == null) {
      client = null;
      render();
      return;
    }
    const c = new ShotListClient(p, n, () => c === client && render());
    client = c;
    render();
    try {
      await c.load();
    } catch (err) {
      c.status = 'error';
      c.error = err instanceof Error ? err.message : String(err);
      render();
      return;
    }
    if (c !== client) return;
    if (c.revision === 0 && !c.shots.length) {
      await settle(rt);
      if (c !== client) return;
      const seeded = [...coverage(rt), ...legacy(rt, p, n)];
      if (seeded.length) {
        // (a shot the director added while the scene settled stays, after the coverage)
        edit((l) => [...seeded, ...l], true);
        storageDel(legacyKey(p, n));
      }
    }
    coverageKey = castKey(rt);
    pushCameras();
    render();
    changed();
    maybeAutoFrames();
  };

  /** A shot's frustum moved, deleted or brought back in the viewport, or the phone changed shot. */
  const reconcile = () => {
    if (pushing || !client?.loaded || director.projectId !== client.projectId || director.sceneIndex !== client.sceneIndex) return;
    const rt = director.runtime;
    const cams = director.cameras;
    const byId = new Map(shots().map((s) => [s.id, s]));
    let dirty = cams.length !== byId.size || cams.some((c, i) => shots()[i]?.id !== c.id);
    const next: Shot[] = cams.map((c) => {
      let s = byId.get(c.id) ?? stash.get(c.id);
      if (!s) {
        dirty = true;
        return { id: c.id, name: c.name.replace(/^\d+[A-Z]+ · /, '').slice(0, 60) || 'Shot', position: c.position, quaternion: c.quaternion, fovDeg: clampFov(c.fovDeg), lines: [], source: 'director' as const };
      }
      if (!near(s.position, c.position, 1e-6) || !near(s.quaternion, c.quaternion, 1e-6) || Math.abs(s.fovDeg - c.fovDeg) > 1e-6) {
        dirty = true;
        s = { ...s, position: c.position, quaternion: c.quaternion, fovDeg: clampFov(c.fovDeg), heightM: rt ? heightAt(rt, c.position) : s.heightM, source: 'director' };
        if (s.id === selected) deselect();
      }
      return s;
    });
    for (const s of shots()) if (!cams.some((c) => c.id === s.id)) stash.set(s.id, s);
    if (dirty) edit(() => next);
    else render();
  };

  // ---- selection --------------------------------------------------------------------------------
  const rectNow = () => {
    const { width, height } = director.view.size;
    return { rect: guideRect(width, height, GUIDE_ASPECT[aspect]), height };
  };
  const viewFov = (s: Shot) => {
    const { rect, height } = rectNow();
    return viewFovForShot(s.fovDeg, height, rect.height);
  };

  /** `phone: false` leaves the phone where it is (the frame-grabbing pass). */
  function select(id: string | null, how: { fly?: 'glide' | 'jump' | 'stay'; phone?: boolean } = {}) {
    if (!id) return deselect();
    const s = find(id);
    if (!s) return;
    selected = id;
    const fov = viewFov(s);
    target = { position: s.position, quaternion: s.quaternion, fov };
    if (how.phone !== false && director.activeCameraId !== id) director.setActiveCamera(id);
    const fly = how.fly ?? 'glide';
    if (director.viewFromPhone) director.setViewFromPhone(false);
    if (fly === 'stay') {
      director.camera.fov = fov;
      director.camera.updateProjectionMatrix();
    } else director.controls.flyTo(
      { x: s.position[0], y: s.position[1], z: s.position[2] },
      { x: s.quaternion[0], y: s.quaternion[1], z: s.quaternion[2], w: s.quaternion[3] },
      fov,
      fly === 'jump' ? 0 : 0.6,
    );
    render();
    list.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  function deselect() {
    if (!selected && !target) return;
    selected = null;
    target = null;
    guide.hide();
    render();
  }

  // the view moved off the selected shot: the guide and the label go (the phone stays on it)
  let frameCount = 0;
  director.onFrame(() => {
    const rt = director.runtime;
    if (rt && client?.loaded && ++frameCount % 30 === 0) {
      const moved = !!coverageKey && castKey(rt) !== coverageKey && shots().some((s) => s.source === 'suggested');
      if (moved !== castMoved) {
        castMoved = moved;
        renderHint();
      }
    }
    const i = shots().findIndex((s) => s.id === selected);
    const s = shots()[i];
    // looking through a shot: the other shots' frustums stay out of the frame
    director.markers.group.visible = !s || !target;
    if (!s || !target || director.viewFromPhone) return guide.hide();
    const cam = director.camera;
    const { rect, height } = rectNow();
    if (!director.controls.flying) {
      const moved = !near(cam.position.toArray(), target.position, 1e-3) || !near(cam.quaternion.toArray(), target.quaternion, 1e-3);
      if (moved || Math.abs(cam.fov - target.fov) > 0.05) return deselect();
      // the canvas resized, the guide's aspect or the shot's lens changed: keep the guide exact
      const want = viewFovForShot(s.fovDeg, height, rect.height);
      if (Math.abs(want - target.fov) > 0.01) {
        cam.fov = want;
        cam.updateProjectionMatrix();
        target.fov = want;
      }
    }
    guide.show(rect, `${num(i)} · ${s.name} · ${lensLabel(s.fovDeg)}`, aspect);
  });

  // ---- frames -------------------------------------------------------------------------------------
  /** Until the view has stopped flying and drawn `frames` more frames (the splat sort catches up). */
  const settled = async (frames: number) => {
    const t0 = performance.now();
    while (director.controls.flying && performance.now() - t0 < 3000) await nextFrame();
    const f0 = director.view.mainFrames;
    while (director.view.mainFrames < f0 + frames && performance.now() - t0 < 8000) await nextFrame();
  };

  const toJpeg = async (c: HTMLCanvasElement): Promise<Blob | null> => {
    for (const q of [0.8, 0.7, 0.6, 0.5]) {
      const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', q));
      if (!b) return null;
      if (b.size <= SHOT_FRAME_MAX_BYTES) return b;
    }
    return null;
  };

  /**
   * The guide's part of the next main render, ≤ 960 px wide, as JPEG. The gizmos (frustums, rings,
   * light handles) are off for that one frame, so the frame is what the phone would see.
   */
  const capture = () =>
    new Promise<Blob | null>((resolve) => {
      const cam = director.camera;
      cam.layers.disable(GIZMO_LAYER);
      director.afterNextMainRender(() => {
        cam.layers.enable(GIZMO_LAYER);
        const { width } = director.view.size;
        const { rect } = rectNow();
        const src = director.canvas;
        const k = src.width / Math.max(1, width);
        const outW = Math.max(16, Math.min(960, Math.round(rect.width * k)));
        const out = document.createElement('canvas');
        out.width = outW;
        out.height = Math.round(outW / (rect.width / rect.height));
        const ctx = out.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.drawImage(src, rect.x * k, rect.y * k, rect.width * k, rect.height * k, 0, 0, out.width, out.height);
        void toJpeg(out).then(resolve, () => resolve(null));
      });
    });

  async function grabFrame(id = selected ?? undefined, frames = 2): Promise<boolean> {
    const c = client;
    const s = find(id ?? null);
    if (!c || !s) {
      if (!id) opts.toast('Select a shot first (1–9), then F grabs its frame');
      return false;
    }
    if (selected !== s.id) select(s.id);
    await settled(frames);
    if (selected !== s.id || c !== client) return false;
    const jpeg = await capture();
    if (!jpeg) return false;
    try {
      return await c.uploadFrame(s.id, jpeg);
    } catch (err) {
      opts.toast(`Frame not saved: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  async function grabMissing(progress?: (done: number, total: number) => void, stopOnInput = false) {
    const c = client;
    const todo = shots().filter((s) => !s.frame);
    if (!c || !todo.length || busy) return;
    const back = { position: director.camera.position.clone(), quaternion: director.camera.quaternion.clone(), fov: director.camera.fov, selected };
    // an automatic pass gives the camera back as soon as the director reaches for it
    let stopped = false;
    const stop = (e: Event) => {
      if (e instanceof KeyboardEvent && (e.metaKey || e.ctrlKey)) return;
      stopped = true;
    };
    if (stopOnInput) for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) window.addEventListener(ev, stop, { capture: true });
    try {
      for (let i = 0; i < todo.length && !stopped; i++) {
        busy = `Grabbing frames ${i + 1} / ${todo.length}`;
        progress?.(i, todo.length);
        render();
        if (c !== client) return;
        select(todo[i]!.id, { fly: 'jump', phone: false });
        await grabFrame(todo[i]!.id, 3);
      }
      progress?.(todo.length, todo.length);
    } finally {
      for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) window.removeEventListener(ev, stop, { capture: true });
      busy = null;
      if (stopped) return render();
      if (c === client) {
        if (back.selected && find(back.selected)) select(back.selected, { fly: 'jump', phone: false });
        else {
          deselect();
          director.controls.flyTo(back.position, back.quaternion, back.fov, 0);
        }
      }
      render();
    }
  }

  // ---- actions ------------------------------------------------------------------------------------
  async function addShot(): Promise<Shot | null> {
    const rt = director.runtime;
    if (!rt || !client?.loaded) return null;
    const src = director.mainCamera();
    const { rect, height } = rectNow();
    const i = shots().length;
    const position = round3(src.position.toArray()) as Vec3;
    const shot: Shot = {
      id: uid(),
      name: `Shot ${num(i)}`,
      position,
      quaternion: round3(src.quaternion.toArray()) as Quat,
      fovDeg: clampFov(shotFovForView(src.fov, height, rect.height)),
      heightM: heightAt(rt, position),
      lines: [],
      source: 'director',
    };
    edit((l) => [...l, shot]);
    opts.showMode();
    // from the director's view the camera is already there; from the phone's it flies there
    select(shot.id, { fly: director.viewFromPhone ? 'jump' : 'stay' });
    opts.toast(`Added shot ${num(i)}`);
    await grabFrame(shot.id, 1);
    return find(shot.id);
  }

  const move = (id: string, to: number) =>
    edit((l) => {
      const from = l.findIndex((s) => s.id === id);
      if (from < 0) return l;
      const out = [...l];
      const [s] = out.splice(from, 1);
      out.splice(Math.max(0, Math.min(out.length, to)), 0, s!);
      return out;
    });

  const duplicate = (id: string) =>
    edit((l) => {
      const i = l.findIndex((s) => s.id === id);
      if (i < 0) return l;
      const s = l[i]!;
      const name = AUTO_NAME.test(s.name) ? s.name : `${s.name.slice(0, 54)} (alt)`;
      const copy: Shot = { ...structuredClone(s), id: uid(), name, source: 'director' };
      return [...l.slice(0, i + 1), copy, ...l.slice(i + 1)];
    });

  // deleting goes through the viewport's undo stack (⌘Z brings the shot back, frame and note too)
  const remove = (id: string) => manip.manipulator.remove({ type: 'camera', id });

  function refreshCoverage() {
    const rt = director.runtime;
    if (!rt || !client?.loaded) return;
    const fresh = coverage(rt);
    edit((l) => {
      const old = new Map(l.filter((s) => s.source === 'suggested').map((s) => [s.name, s]));
      const updated = fresh.map((f) => {
        const o = old.get(f.name);
        if (!o) return f;
        const same = near(o.position, f.position, 0.01) && near(o.quaternion, f.quaternion, 0.004) && Math.abs(o.fovDeg - f.fovDeg) < 0.1;
        return { ...o, position: f.position, quaternion: f.quaternion, fovDeg: f.fovDeg, heightM: f.heightM, frame: same ? o.frame : undefined, frameAt: same ? o.frameAt : undefined };
      });
      const out: Shot[] = [];
      let placed = false;
      for (const s of l) {
        if (s.source !== 'suggested') out.push(s);
        else if (!placed) {
          out.push(...updated);
          placed = true;
        }
      }
      return placed ? out : [...updated, ...out];
    });
    coverageKey = castKey(rt);
    castMoved = false;
    renderHint();
    opts.toast(fresh.length ? `Coverage framed again: ${fresh.length} shots` : 'No cast to frame coverage on');
  }

  // ---- render -------------------------------------------------------------------------------------
  const frameUrl = (s: Shot) =>
    s.frame && client ? `${api.upload(client.projectId, s.frame)}${s.frameAt ? `?t=${encodeURIComponent(s.frameAt)}` : ''}` : null;

  let dragId: string | null = null;
  const lineLabel = (rt: SceneRuntime, id: string) => {
    const l = rt.manifest.plan.dialogue.find((x) => x.id === id);
    if (!l) return null;
    const who = rt.manifest.characters.find((c) => c.id === l.characterId)?.name ?? l.characterId;
    return { who, text: l.text };
  };

  const row = (s: Shot, i: number) => {
    const rt = director.runtime;
    const isSel = s.id === selected;
    const onPhone = s.id === director.activeCameraId;
    const url = frameUrl(s);
    const name = h('input', { class: 'shot-name', value: s.name, maxlength: 60, spellcheck: 'false', 'aria-label': 'Shot name', 'data-testid': 'shot-name' });
    name.addEventListener('change', () => {
      const v = name.value.trim().slice(0, 60);
      if (v && v !== s.name) own(s.id, { name: v });
      else name.value = s.name;
    });
    name.addEventListener('keydown', (e) => e.key === 'Enter' && name.blur());
    const note = h('input', { class: 'shot-note', value: s.note ?? '', maxlength: 200, placeholder: 'Note', spellcheck: 'false', 'aria-label': 'Note', 'data-testid': 'shot-note' });
    note.addEventListener('change', () => {
      const v = note.value.trim().slice(0, 200);
      if (v !== (s.note ?? '')) own(s.id, { note: v || undefined });
    });
    note.addEventListener('keydown', (e) => e.key === 'Enter' && note.blur());
    const grip = h('span', { class: 'shot-grip', draggable: 'true', title: 'Drag to reorder', 'aria-hidden': 'true' }, icon('grip'));
    const act = (ic: Parameters<typeof icon>[0], title: string, testid: string, fn: () => void, disabled = false) =>
      h('button', { type: 'button', class: 'icon', title, 'aria-label': title, 'data-testid': testid, disabled, onclick: (e: Event) => (e.stopPropagation(), fn()) }, icon(ic));
    const el = h(
      'div',
      {
        class: `shot-row${isSel ? ' selected' : ''}${onPhone ? ' on-phone' : ''}`,
        'data-testid': 'shot-row',
        'data-id': s.id,
        'data-shot': s.name,
        'data-source': s.source,
        'aria-selected': String(isSel),
      },
      grip,
      h('span', { class: 'shot-num num', 'data-testid': 'shot-number' }, num(i)),
      h(
        'button',
        { type: 'button', class: 'shot-thumb', 'data-testid': 'shot-fly', title: `Go to ${num(i)}: the view flies there and the phone attaches${i < 9 ? ` (${i + 1})` : ''}` },
        url ? h('img', { src: url, alt: '', loading: 'lazy', 'data-testid': 'shot-frame' }) : h('span', { class: 'shot-noframe' }, 'no frame'),
      ),
      h(
        'div',
        { class: 'shot-body' },
        name,
        h(
          'div',
          { class: 'shot-meta small muted' },
          h('span', { class: `dot ${s.source === 'suggested' ? '' : 'ok'}`, title: s.source === 'suggested' ? 'Coverage: framed on where the cast stands (Refresh coverage frames it again)' : 'Your shot' }),
          h('span', { class: 'num', 'data-testid': 'shot-lens' }, lensLabel(s.fovDeg)),
          s.heightM != null ? h('span', { class: 'num', 'data-testid': 'shot-height', title: 'Camera height above the ground' }, `${s.heightM.toFixed(2)} m`) : null,
          onPhone ? h('span', { class: 'shot-phone', title: 'The phone is on this shot' }, icon('phone'), 'phone') : null,
        ),
        note,
      ),
      h(
        'div',
        { class: 'shot-actions' },
        act('chevron-up', 'Move up', 'shot-up', () => move(s.id, i - 1), i === 0),
        act('chevron-down', 'Move down', 'shot-down', () => move(s.id, i + 1), i === shots().length - 1),
        act('copy', 'Duplicate', 'shot-duplicate', () => duplicate(s.id)),
        act('trash', 'Delete (⌘Z brings it back)', 'shot-delete', () => remove(s.id)),
      ),
    );
    el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.shot-actions, .shot-detail')) return;
      if (selected !== s.id || !target) select(s.id);
    });
    // drag to reorder (the grip starts it; rows take the drop above or below their middle)
    grip.addEventListener('dragstart', (e) => {
      dragId = s.id;
      e.dataTransfer?.setData('text/plain', s.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer?.setDragImage(el, 16, 16);
      el.classList.add('dragging');
    });
    grip.addEventListener('dragend', () => {
      dragId = null;
      for (const r of list.querySelectorAll('.drop-before, .drop-after, .dragging')) r.classList.remove('drop-before', 'drop-after', 'dragging');
    });
    el.addEventListener('dragover', (e) => {
      if (!dragId || dragId === s.id) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
    el.addEventListener('drop', (e) => {
      if (!dragId) return;
      e.preventDefault();
      const after = el.classList.contains('drop-after');
      el.classList.remove('drop-before', 'drop-after');
      const from = shots().findIndex((x) => x.id === dragId);
      let to = i + (after ? 1 : 0);
      if (from < to) to--;
      move(dragId, to);
      dragId = null;
    });
    if (!isSel || !rt) return el;
    // the selected shot: lens, frame, the lines it covers
    const lens = h('select', { class: 'shot-lens-pick', 'data-testid': 'shot-lens-pick', title: 'Lens (full-frame equivalent)' }, ...PICKER_MM.map((mm) => h('option', { value: mm, selected: mm === nearestLensMm(s.fovDeg) }, `${mm} mm`)));
    lens.addEventListener('change', () => own(s.id, { fovDeg: clampFov(fovDegForLens(Number(lens.value))) }));
    const dialogue = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    const chips = dialogue.map((l) => {
      const on = s.lines.includes(l.id);
      const label = lineLabel(rt, l.id)!;
      return h(
        'button',
        {
          type: 'button',
          class: `small line-chip${on ? ' on' : ''}`,
          'data-testid': 'shot-line',
          'data-line': l.id,
          'aria-pressed': String(on),
          title: `${label.who}: ${label.text}\n${on ? 'Covered by this shot (click: not covered)' : 'Click: this shot covers the line'}`,
          onclick: () => own(s.id, { lines: on ? s.lines.filter((x) => x !== l.id) : dialogue.filter((d) => d.id === l.id || s.lines.includes(d.id)).map((d) => d.id) }),
        },
        h('b', {}, label.who),
        ` ${label.text.length > 26 ? `${label.text.slice(0, 25)}…` : label.text}`,
      );
    });
    const detail = h(
      'div',
      { class: 'shot-detail', 'data-testid': 'shot-detail' },
      h(
        'div',
        { class: 'row' },
        h('label', { class: 'label' }, 'Lens'),
        lens,
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', class: 'small', 'data-testid': 'shot-grab', title: 'Grab this shot’s frame from the view again (F)', onclick: () => void grabFrame(s.id) }, icon('frame'), url ? 'Re-grab frame' : 'Grab frame'),
      ),
      dialogue.length ? h('div', { class: 'label' }, 'Lines it covers') : null,
      dialogue.length ? h('div', { class: 'line-chips' }, ...chips) : null,
    );
    const wrap = h('div', { class: 'shot-item selected' }, el, detail);
    return wrap;
  };

  const renderHint = () => {
    hint.hidden = !castMoved;
    hint.replaceChildren(
      'The cast moved since this coverage was framed.',
      h('button', { type: 'button', class: 'small link-ish', onclick: () => refreshCoverage() }, 'Refresh coverage'),
    );
  };

  let lastKey = '';
  let deferred = false;
  function render() {
    const c = client;
    const st = !c ? '' : busy ?? (c.status === 'error' ? `Not saved: ${c.error ?? 'error'}` : c.status === 'saving' ? 'Saving…' : c.status === 'unsaved' ? 'Unsaved' : c.loaded ? `${c.shots.length} shot${c.shots.length === 1 ? '' : 's'}` : '');
    status.textContent = st;
    status.dataset.revision = String(c?.revision ?? 0);
    status.dataset.status = c?.status ?? 'none';
    const rt = director.runtime;
    addBtn.disabled = !rt || !c?.loaded;
    refreshBtn.disabled = !rt || !c?.loaded;
    const missing = shots().filter((s) => !s.frame).length;
    framesBtn.disabled = !c?.loaded || !!busy || !missing;
    framesBtn.hidden = !missing && !busy;
    framesBtn.lastChild!.textContent = missing ? `Grab ${missing} frame${missing === 1 ? '' : 's'}` : 'Frames';
    const key = JSON.stringify([c?.projectId, c?.sceneIndex, c?.loaded, c?.status === 'error', shots(), selected, director.activeCameraId, !!rt]);
    if (key === lastKey) return changed();
    // typing a name or a note: rebuild once it is done (the field keeps what is being typed)
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement && list.contains(focused)) {
      deferred = true;
      for (const r of list.querySelectorAll<HTMLElement>('.shot-row')) {
        r.classList.toggle('selected', r.dataset.id === selected);
        r.classList.toggle('on-phone', r.dataset.id === director.activeCameraId);
      }
      return changed();
    }
    lastKey = key;
    deferred = false;
    list.replaceChildren();
    if (!rt) list.append(h('div', { class: 'empty' }, 'Open a scene to plan its coverage.'));
    else if (!c?.loaded) list.append(h('div', { class: `empty${c?.status === 'error' ? ' error' : ''}` }, c?.status === 'error' ? `The shot list did not load: ${c.error}` : 'Loading the shot list…'));
    else if (!shots().length) list.append(h('div', { class: 'empty' }, 'No shots yet. Frame something and press C.'));
    else shots().forEach((s, i) => list.append(row(s, i)));
    changed();
  }
  list.addEventListener('focusout', () => {
    if (deferred) setTimeout(render, 0);
  });

  // The first time the Shots mode shows a scene's list with shots that have no frame, the view
  // visits each one and grabs it (any key or click hands the camera back at once). Automation
  // (navigator.webdriver) skips it unless ?frames=1 asks.
  const autoFrames = new URLSearchParams(location.search).get('frames') === '1' || !navigator.webdriver;
  const autoDone = new WeakSet<ShotListClient>();
  const maybeAutoFrames = () => {
    const c = client;
    if (!autoFrames || !c?.loaded || pane.hidden || autoDone.has(c) || busy || !shots().some((s) => !s.frame)) return;
    autoDone.add(c);
    setTimeout(() => {
      if (c === client && !pane.hidden) void grabMissing(undefined, true);
    }, 400);
  };
  new MutationObserver(maybeAutoFrames).observe(pane, { attributes: true, attributeFilter: ['hidden'] });

  // ---- keys -------------------------------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || !director.runtime) return;
    if (/^Digit[1-9]$/.test(e.code)) {
      const s = shots()[Number(e.code.slice(5)) - 1];
      if (s) {
        e.preventDefault();
        select(s.id);
      }
    } else if (e.code === 'KeyC') {
      e.preventDefault();
      void addShot();
    } else if (e.code === 'KeyF') {
      e.preventDefault();
      void grabFrame();
    }
  });

  director.on((c) => {
    if (c === 'scene' || c === 'loading') void open(director.runtime);
    if (c === 'cameras') reconcile();
  });
  render();

  const panel: ShotsPanel = {
    shots,
    selected: () => selected,
    select: (id) => select(id),
    addShot,
    grabFrame: (id) => grabFrame(id),
    grabMissing,
    flush: () => client?.flush() ?? Promise.resolve(),
    frameUrl,
    guideAspect: () => aspect,
    setGuideAspect: (a) => {
      aspect = a;
      storageSet(GUIDE_KEY, a);
      changed();
    },
    onChange: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  // debug / e2e / evidence: window.__shots.state()
  Object.defineProperty(window, '__shots', {
    configurable: true,
    value: Object.freeze({
      ...panel,
      state: () => ({
        loaded: !!client?.loaded,
        status: client?.status ?? null,
        revision: client?.revision ?? 0,
        shots: shots().map((s, i) => ({ id: s.id, number: num(i), name: s.name, lens: lensLabel(s.fovDeg), source: s.source, frame: s.frame ?? null, lines: s.lines })),
        selected,
        guide: { visible: guide.visible, label: guide.text, aspect },
      }),
    }),
  });
  return panel;
}
