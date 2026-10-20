// Edit tab (right panel): scoped re-prompting (docs/PLAN-v2.md §2).
//
//   prompt box (Enter) → POST reprompt → the plan's summary + a scope chip
//     look / transform / prop / region (with a 3D target) — already applied and saved by the server
//     region without a target — the planner's vision box (targets) is unprojected through a splat
//       raycast from the camera the view was taken with, previewed, and applied on Apply; without
//       a box the viewport asks "Click the <object>" (Esc cancels)
//     world-regen — an inline confirm card (time, credits, what it keeps/drops) → POST regen, then
//       the scene reloads when the new world is in place
//     clarify — the planner's question
//   Select: arms click-to-select (sphere, auto radius) / Shift+drag (box); the selection goes with
//     the next prompt and its outline can be dragged to resize.
//   History: prompt → what changed, per-edit on/off and delete, Undo last (PUT edits.json).
//
// The current view (jpeg ≤ 300 KB of the main canvas + its camera) goes along with every prompt:
// the camera makes "left / closer" mean what the director sees, and when the prompt names an
// object and nothing is selected the server boxes that object in the image.
import * as THREE from 'three';
import { api } from '@shared/api';
import { SceneEdit, type EditPlan, type SceneEdits } from '@shared/look';
import type { Vec3 } from '@shared/schema';
import { fetchEdits, putEdits } from '../viewer/look/edits-client';
import { appendOps, removeOp, setOpEnabled, type NormBox, type RegionEdit } from '../viewer/edits/model';
import {
  boxFromRect,
  boxToNdc,
  regionFromTarget,
  SelectionGizmo,
  sphereFromClick,
  type RegionSelection,
  type ViewPose,
} from '../viewer/edits/select';
import type { Director } from './director';
import { h, isTyping } from './dom';
import { storageGet, storageSet } from './storage';
import './edit-panel.css';

export interface PlannerTarget {
  opId: string;
  label: string;
  box: NormBox;
  confidence: number;
}

interface RepromptResponse {
  plan: EditPlan;
  edits: SceneEdits;
  targets?: PlannerTarget[];
  applied: string[];
  notes?: string[];
  source?: string;
}

/** A region op waiting for its 3D target (click or vision box) and the director's Apply. */
interface Pending {
  prompt: string;
  plan: EditPlan;
  op: RegionEdit;
  label: string;
  /** Resolved region awaiting Apply (null: waiting for a click). */
  region: RegionSelection | null;
  from: 'vision' | 'click' | null;
  view?: ViewPose;
  box?: NormBox;
}

const SCOPE_LABEL: Record<EditPlan['scope'], string> = {
  look: 'look',
  transform: 'transform',
  prop: 'prop',
  'splat-region': 'region',
  'world-regen': 'regen',
  clarify: 'clarify',
};
const TAB_KEY = 'previz:edit-tab';
const MAX_VIEW_BYTES = 290 * 1024;
/** JPEG data URL of the main view, ≤ 290 KB: render once and copy the canvas before it clears. */
export function captureView(director: Director): { image: string; pose: ViewPose } | null {
  const cam = director.mainCamera();
  director.view.renderMain(cam);
  const src = director.canvas;
  const w0 = src.width;
  const h0 = src.height;
  if (!w0 || !h0) return null;
  const scale = Math.min(1, 1024 / w0);
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * scale);
  c.height = Math.round(h0 * scale);
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  let url = '';
  for (const q of [0.82, 0.7, 0.58, 0.45, 0.35]) {
    url = c.toDataURL('image/jpeg', q);
    if (((url.length - url.indexOf(',') - 1) * 3) / 4 <= MAX_VIEW_BYTES) break;
  }
  const pose: ViewPose = {
    position: cam.position.toArray() as Vec3,
    quaternion: cam.quaternion.toArray() as [number, number, number, number],
    fovDeg: cam.fov,
    aspect: c.width / c.height,
  };
  return { image: url.slice(url.indexOf(',') + 1), pose };
}

export interface EditPanel {
  /** Sends a prompt as if typed (tests / verification). */
  send(prompt: string): Promise<RepromptResponse | null>;
  state(): Record<string, unknown>;
}

export function mountEditPanel(director: Director): EditPanel {
  const right = document.getElementById('right');
  if (!right) throw new Error('#right missing from index.html');

  // ---- tab (next to the Look panel's Shoot / Look tabs) ----------------------------------------
  let tabs = right.querySelector<HTMLElement>('.right-tabs');
  if (!tabs) {
    tabs = h('div', { class: 'right-tabs', role: 'tablist' });
    right.prepend(tabs);
  }
  const section = h('section', { class: 'card grow edit-panel', id: 'edit-panel', 'data-testid': 'edit-panel' });
  right.append(section);
  const editTab = h('button', { type: 'button', class: 'tab', 'data-tab': 'edit', 'data-testid': 'tab-edit', role: 'tab' }, 'Edit');
  tabs.append(editTab);
  const show = (on: boolean) => {
    section.hidden = !on;
    editTab.classList.toggle('on', on);
    if (on) {
      for (const c of [...right.children] as HTMLElement[]) if (c !== tabs && c !== section) c.hidden = true;
      for (const b of tabs!.querySelectorAll('.tab')) if (b !== editTab) b.classList.remove('on');
    }
    storageSet(TAB_KEY, on);
  };
  editTab.addEventListener('click', () => show(true));
  for (const b of tabs.querySelectorAll('.tab')) if (b !== editTab) b.addEventListener('click', () => show(false));
  show(storageGet<boolean>(TAB_KEY) === true);

  // ---- viewport overlays ------------------------------------------------------------------------
  const stage = director.canvas.parentElement!;
  const banner = h('div', { class: 'edit-banner', hidden: true, 'data-testid': 'edit-banner' });
  const rect = h('div', { class: 'edit-rect', hidden: true });
  const targetBox = h('div', { class: 'edit-target-box', hidden: true });
  stage.append(banner, rect, targetBox);
  const gizmo = new SelectionGizmo();

  // ---- panel DOM --------------------------------------------------------------------------------
  const input = h('textarea', {
    class: 'edit-prompt',
    rows: 2,
    placeholder: 'Describe a change… ("make the pillow red", "move Leo closer", "warmer")',
    'data-testid': 'edit-prompt',
    spellcheck: 'false',
  });
  const sendBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'edit-send' }, 'Send');
  const selectBtn = h('button', { type: 'button', class: 'small', title: 'Click the world to select a region (Shift+drag: box)', 'data-testid': 'edit-select' }, 'Select');
  const selInfo = h('span', { class: 'muted small edit-selinfo' });
  const growBtn = h('button', { type: 'button', class: 'icon', title: 'Grow selection' }, '+');
  const shrinkBtn = h('button', { type: 'button', class: 'icon', title: 'Shrink selection' }, '−');
  const clearBtn = h('button', { type: 'button', class: 'icon', title: 'Clear selection' }, '×');
  const result = h('div', { class: 'edit-result', 'data-testid': 'edit-result' });
  const card = h('div', { class: 'edit-card', hidden: true, 'data-testid': 'edit-card' });
  const historyBox = h('div', { class: 'edit-history', 'data-testid': 'edit-history' });
  const undoBtn = h('button', { type: 'button', class: 'small', 'data-testid': 'edit-undo' }, 'Undo last');
  section.append(
    h('h2', {}, 'Edit', h('span', { class: 'spacer' }), selectBtn),
    h('div', { class: 'edit-input' }, input, sendBtn),
    h('div', { class: 'row edit-selrow' }, selInfo, h('span', { class: 'spacer' }), shrinkBtn, growBtn, clearBtn),
    result,
    card,
    h('h3', { class: 'edit-h3' }, 'History', h('span', { class: 'spacer' }), undoBtn),
    historyBox,
  );

  // ---- state ------------------------------------------------------------------------------------
  let busy = false;
  let selecting = false;
  let selection: RegionSelection | null = null;
  let pending: Pending | null = null;
  let queue: Pending[] = [];
  let lastPlan: { plan: EditPlan; prompt: string; notes: string[] } | null = null;
  let regenWatch: ReturnType<typeof setInterval> | null = null;
  /** world-regen flow: confirm card → running (polling the project) → done */
  let regen: 'idle' | 'confirm' | 'running' | 'done' = 'idle';
  let error: string | null = null;

  const rt = () => director.runtime;
  const doc = (): SceneEdits | null => rt()?.edits ?? null;
  const adopt = (d: SceneEdits) => {
    const r = rt();
    if (!r) return;
    if (!r.edits || d.revision >= r.edits.revision) r.look.adoptEdits(d);
  };
  const ensureDoc = async (): Promise<SceneEdits | null> => {
    const r = rt();
    if (!r || director.projectId == null || director.sceneIndex == null) return null;
    if (r.edits) return r.edits;
    try {
      const d = await fetchEdits(director.projectId, director.sceneIndex);
      adopt(d);
      return d;
    } catch {
      return null;
    }
  };

  /** Read-modify-write of edits.json: `fn` runs again on the stored doc after a 409. */
  const save = async (fn: (d: SceneEdits) => SceneEdits): Promise<boolean> => {
    const id = director.projectId;
    const n = director.sceneIndex;
    let base = await ensureDoc();
    if (!base || id == null || n == null) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await putEdits(id, n, fn(base));
      if (r.ok) {
        adopt(r.doc);
        return true;
      }
      base = r.conflict;
      adopt(r.conflict);
    }
    error = 'edits kept changing underneath; try again';
    return false;
  };

  const setSelection = (sel: RegionSelection | null) => {
    selection = sel;
    showGizmo();
    render();
  };
  const showGizmo = () => {
    const r = rt();
    if (r && gizmo.object.parent !== r.scene) r.scene.add(gizmo.object);
    gizmo.set(pending?.region ?? selection);
    previewPending();
  };
  const previewPending = () => {
    const r = rt();
    if (!r?.sceneEdits) return;
    if (pending?.region) r.sceneEdits.setPreview({ ...pending.op, ...placement(pending.region) });
    else r.sceneEdits.setPreview(null);
  };
  const placement = (sel: RegionSelection) => ({ shape: sel.shape, center: sel.center, size: sel.size, yaw: sel.yaw });

  // ---- prompt -----------------------------------------------------------------------------------
  const send = async (text?: string): Promise<RepromptResponse | null> => {
    const prompt = (text ?? input.value).trim();
    const r = rt();
    if (!prompt || busy || !r || director.projectId == null || director.sceneIndex == null) return null;
    busy = true;
    error = null;
    cancelPending();
    render();
    try {
      const body: Record<string, unknown> = { prompt };
      let viewPose: ViewPose | undefined;
      if (selection) body.selection = { region: { center: selection.center, size: selection.size, shape: selection.shape } };
      // the view always goes along: its camera gives "left / right / closer" their meaning, and
      // when the prompt names an object and nothing is selected the server boxes it in the image
      const v = captureView(director);
      if (v) {
        body.view = { image: v.image, ...v.pose };
        viewPose = v.pose;
      }
      const res = await fetch(api.reprompt(director.projectId, director.sceneIndex), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as RepromptResponse & { error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.edits.revision > (doc()?.revision ?? -1) || json.applied.length) adopt(json.edits);
      lastPlan = { plan: json.plan, prompt, notes: json.notes ?? [] };
      regen = json.plan.scope === 'world-regen' && json.plan.regen ? 'confirm' : 'idle';
      if (selection && json.applied.length) setSelection(null);
      input.value = '';
      // regions still waiting for a target: vision boxes first, else ask for a click
      queue = json.plan.needsTarget.flatMap((t) => {
        const op = json.plan.ops.find((o) => o.id === t.opId);
        if (!op || op.kind !== 'splat-region') return [];
        const box = json.targets?.find((x) => x.opId === t.opId);
        return [{ prompt, plan: json.plan, op, label: t.label, region: null, from: null, view: viewPose, box: box?.box } as Pending];
      });
      nextPending();
      return json;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return null;
    } finally {
      busy = false;
      render();
    }
  };

  const nextPending = () => {
    pending = queue.shift() ?? null;
    if (pending?.box && pending.view && rt()?.splat) {
      const region = regionFromTarget(rt()!.splat!, pending.view, pending.box);
      if (region) {
        pending.region = region;
        pending.from = 'vision';
      }
    }
    showGizmo();
    render();
  };

  const cancelPending = () => {
    pending = null;
    queue = [];
    showGizmo();
  };

  const applyPending = async () => {
    const p = pending;
    if (!p?.region) return;
    const op = SceneEdit.parse({ ...p.op, ...placement(p.region) });
    const plan: EditPlan = { ...p.plan, needsTarget: p.plan.needsTarget.filter((t) => t.opId !== p.op.id) };
    busy = true;
    render();
    const ok = await save((d) => appendOps(d, [op], { prompt: p.prompt, plan }));
    busy = false;
    if (ok) nextPending();
    else render();
  };

  // ---- regen ------------------------------------------------------------------------------------
  const startRegen = async (plan: EditPlan) => {
    if (!plan.regen || director.projectId == null || director.sceneIndex == null) return;
    const id = director.projectId;
    const n = director.sceneIndex;
    busy = true;
    render();
    try {
      const res = await fetch(api.regen(id, n), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan: plan.regen }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      lastPlan = { plan: { ...plan, summary: `Regenerating the world… (${plan.regen.method === 'pano-inpaint' ? 'edited panorama' : 'new prompt'}, ~${plan.regen.estimatedMinutes} min)` }, prompt: lastPlan?.prompt ?? '', notes: [] };
      regen = 'running';
      watchRegen(id, n);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
      render();
    }
  };

  const watchRegen = (id: string, n: number) => {
    if (regenWatch) clearInterval(regenWatch);
    regenWatch = setInterval(async () => {
      try {
        const st = (await (await fetch(api.project(id), { cache: 'no-store' })).json()) as {
          scenes: { stages: Record<string, { status: string; note?: string }> }[];
        };
        const s = st.scenes[n]?.stages;
        if (!s || s.world?.status === 'running' || s.manifest?.status === 'pending' || s.manifest?.status === 'running') return;
        clearInterval(regenWatch!);
        regenWatch = null;
        regen = 'done';
        lastPlan = lastPlan && { ...lastPlan, plan: { ...lastPlan.plan, summary: `World stage: ${s.world?.note ?? s.world?.status}` } };
        render();
        if (director.projectId === id && director.sceneIndex === n && director.manifestUrl) {
          const u = new URL(director.manifestUrl, location.href);
          u.searchParams.set('rev', String(Date.now()));
          void director.openScene(id, n, u.pathname + u.search);
        }
      } catch {
        /* keep polling */
      }
    }, 2000);
  };

  // ---- history actions --------------------------------------------------------------------------
  const toggle = (opId: string, on: boolean) => void save((d) => setOpEnabled(d, opId, on)).then(render);
  const remove = (opId: string) => void save((d) => removeOp(d, opId)).then(render);
  const undoLast = () =>
    void save((d) => {
      const last = [...d.history].reverse().find((h) => h.appliedOpIds.some((id) => d.edits.some((e) => e.id === id)));
      if (!last) return d;
      return last.appliedOpIds.reduce((acc, id) => removeOp(acc, id), d);
    }).then(render);

  // ---- viewport input ---------------------------------------------------------------------------
  const ndcOf = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = director.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, -(((e.clientY - r.top) / r.height) * 2 - 1)];
  };
  let drag: { kind: 'resize'; startDist: number; cx: number; cy: number; startSize: Vec3 } | { kind: 'box'; x0: number; y0: number } | null = null;
  const active = () => !section.hidden && (selecting || (!!pending && !pending.region) || !!pending?.region || !!selection);

  director.canvas.addEventListener(
    'pointerdown',
    (e) => {
      if (e.button !== 0 || e.altKey || !active()) return;
      const cur = pending?.region ?? selection;
      const r = director.canvas.getBoundingClientRect();
      if (cur) {
        const c = gizmo.screenCircle(director.mainCamera(), r.width, r.height);
        if (c) {
          const d = Math.hypot(e.clientX - r.left - c.x, e.clientY - r.top - c.y);
          if (Math.abs(d - c.r) < Math.max(10, c.r * 0.18)) {
            drag = { kind: 'resize', startDist: Math.max(4, d), cx: c.x, cy: c.y, startSize: [...cur.size] };
            director.canvas.setPointerCapture(e.pointerId);
            e.stopPropagation();
            e.preventDefault();
            return;
          }
        }
      }
      if (e.shiftKey && (selecting || (pending && !pending.region))) {
        drag = { kind: 'box', x0: e.clientX, y0: e.clientY };
        director.canvas.setPointerCapture(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
      }
    },
    { capture: true },
  );
  director.canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = director.canvas.getBoundingClientRect();
    if (drag.kind === 'resize') {
      const d = Math.hypot(e.clientX - r.left - drag.cx, e.clientY - r.top - drag.cy);
      const k = Math.max(0.1, d / drag.startDist);
      const target = pending?.region ? pending : null;
      const base = drag.startSize;
      const sized = (sel: RegionSelection): RegionSelection => ({ ...sel, size: base.map((v) => Math.round(Math.min(3.6, Math.max(0.05, v * k)) * 1000) / 1000) as Vec3 });
      if (target?.region) target.region = sized(target.region);
      else if (selection) selection = sized(selection);
      showGizmo();
      renderSel();
    } else {
      rect.hidden = false;
      Object.assign(rect.style, {
        left: `${Math.min(drag.x0, e.clientX) - r.left}px`,
        top: `${Math.min(drag.y0, e.clientY) - r.top}px`,
        width: `${Math.abs(e.clientX - drag.x0)}px`,
        height: `${Math.abs(e.clientY - drag.y0)}px`,
      });
    }
  });
  director.canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    rect.hidden = true;
    if (d.kind === 'box' && rt()?.splat && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 6) {
      const a = ndcOf({ clientX: d.x0, clientY: d.y0 });
      const b = ndcOf(e);
      const region = boxFromRect(rt()!.splat!, director.mainCamera(), a, b);
      if (region) placeRegion(region, 'click');
    }
    render();
  });
  director.canvas.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.altKey || e.shiftKey || section.hidden) return;
      if (!selecting && !(pending && !pending.region)) return;
      const splat = rt()?.splat;
      if (!splat) return;
      e.stopPropagation();
      const region = sphereFromClick(splat, director.mainCamera(), ndcOf(e));
      if (!region) {
        flash('No splat under the cursor');
        return;
      }
      placeRegion(region, 'click');
    },
    { capture: true },
  );
  const placeRegion = (region: RegionSelection, from: 'click' | 'vision') => {
    if (pending) {
      pending.region = region;
      pending.from = from;
    } else {
      selection = region;
      selecting = false;
    }
    showGizmo();
    render();
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (pending || selecting || selection)) {
      if (pending) cancelPending();
      else if (selecting) selecting = false;
      else setSelection(null);
      render();
    }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });
  sendBtn.addEventListener('click', () => void send());
  selectBtn.addEventListener('click', () => {
    selecting = !selecting;
    render();
  });
  growBtn.addEventListener('click', () => resizeSel(1.15));
  shrinkBtn.addEventListener('click', () => resizeSel(1 / 1.15));
  clearBtn.addEventListener('click', () => {
    if (pending?.region) pending.region = null;
    else setSelection(null);
    showGizmo();
    render();
  });
  undoBtn.addEventListener('click', undoLast);
  const resizeSel = (k: number) => {
    const target = pending?.region ? pending : null;
    const scale = (s: RegionSelection): RegionSelection => ({ ...s, size: s.size.map((v) => Math.round(Math.min(3.6, Math.max(0.05, v * k)) * 1000) / 1000) as Vec3 });
    if (target?.region) target.region = scale(target.region);
    else if (selection) selection = scale(selection);
    showGizmo();
    render();
  };

  let flashText: { text: string; until: number } | null = null;
  const flash = (text: string) => {
    flashText = { text, until: performance.now() + 2500 };
    render();
    setTimeout(render, 2600);
  };

  // ---- render -----------------------------------------------------------------------------------
  const describeOp = (op: SceneEdit): string => {
    switch (op.kind) {
      case 'look':
        return `look: ${Object.keys(op.patch).length ? 'grade' : ''}`.trim();
      case 'transform':
        return `${op.target.type} ${op.target.id}${op.position ? ` → (${op.position.map((v) => v.toFixed(1)).join(', ')})` : ''}${op.scale ? ` ×${op.scale}` : ''}`;
      case 'prop-add':
        return `+ ${op.element.label}`;
      case 'prop-remove':
        return `− ${op.elementId}`;
      case 'splat-region': {
        const what = op.opacity === 0 ? 'hidden' : op.color ? `${op.color.mode} ${op.color.value}` : op.displace ? 'moved' : op.scale ? `×${op.scale}` : 'edited';
        return `${op.label}: ${what} (${op.shape}, ${op.size[0].toFixed(2)} m)`;
      }
    }
  };
  const renderSel = () => {
    const s = pending?.region ?? selection;
    selInfo.textContent = s
      ? `${pending?.region ? 'Target' : 'Selection'}: ${s.shape} ${s.shape === 'sphere' ? `r ${s.size[0].toFixed(2)} m` : `${s.size.map((v) => (v * 2).toFixed(2)).join('×')} m`}`
      : selecting
        ? 'Click the world (Shift+drag for a box)'
        : 'Nothing selected';
    for (const b of [growBtn, shrinkBtn, clearBtn]) b.disabled = !s;
  };

  function render() {
    const r = rt();
    sendBtn.disabled = busy || !r;
    input.disabled = !r;
    selectBtn.classList.toggle('on', selecting);
    director.canvas.classList.toggle('edit-picking', !section.hidden && (selecting || (!!pending && !pending.region)));
    renderSel();
    // banner over the viewport
    if (pending && !pending.region) {
      banner.hidden = false;
      banner.textContent = `Click the ${pending.label} (Shift+drag for a box) — Esc cancels`;
    } else if (flashText && performance.now() < flashText.until) {
      banner.hidden = false;
      banner.textContent = flashText.text;
    } else banner.hidden = true;
    stage.classList.toggle('edit-target', !!pending && !pending.region);
    // the planner's box over the viewport while its region awaits Apply
    if (pending?.box && pending.from === 'vision') {
      const { a, b } = boxToNdc(pending.box);
      const cr = director.canvas.getBoundingClientRect();
      const sr = stage.getBoundingClientRect();
      targetBox.hidden = false;
      Object.assign(targetBox.style, {
        left: `${cr.left - sr.left + ((a[0] + 1) / 2) * cr.width}px`,
        top: `${cr.top - sr.top + ((1 - b[1]) / 2) * cr.height}px`,
        width: `${((b[0] - a[0]) / 2) * cr.width}px`,
        height: `${((b[1] - a[1]) / 2) * cr.height}px`,
      });
    } else targetBox.hidden = true;

    // result
    result.replaceChildren();
    if (busy) result.append(h('div', { class: 'muted small' }, 'Planning…'));
    if (error) result.append(h('div', { class: 'warn small' }, error));
    if (lastPlan && !busy) {
      const { plan } = lastPlan;
      result.append(
        h('div', { class: 'edit-summary' }, h('span', { class: `chip scope-${SCOPE_LABEL[plan.scope]}`, 'data-testid': 'edit-scope' }, SCOPE_LABEL[plan.scope]), ' ', plan.summary),
      );
      if (plan.question) result.append(h('div', { class: 'edit-question' }, plan.question));
    }

    // card: regen confirm, or a resolved region awaiting Apply
    card.replaceChildren();
    card.hidden = true;
    const plan = lastPlan?.plan;
    if (plan?.scope === 'world-regen' && plan.regen && regen === 'confirm') {
      const rg = plan.regen;
      const change = lastPlan!.prompt.replace(/^make (it|the scene) /i, '').replace(/[.!]$/, '');
      card.hidden = false;
      card.append(
        h(
          'div',
          { 'data-testid': 'regen-confirm' },
          `Regenerate the world with ${change} — about ${rg.estimatedMinutes} min and ${rg.estimatedCredits.toLocaleString('en-US')} Marble credits. Keeps ${rg.keeps.join(', ') || 'nothing'}${rg.drops.length ? `; drops ${rg.drops.join(', ')}` : ''}.`,
        ),
        h('div', { class: 'muted small' }, rg.method === 'pano-inpaint' ? 'Edits the world’s panorama (layout stays) and feeds it to Marble.' : 'New text prompt for Marble (layout may change).'),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'primary', 'data-testid': 'regen-go', onclick: () => void startRegen(plan) }, 'Regenerate'),
          h('button', { type: 'button', 'data-testid': 'regen-cancel', onclick: () => { regen = 'idle'; lastPlan = null; render(); } }, 'Cancel'),
        ),
      );
    } else if (pending?.region) {
      card.hidden = false;
      card.append(
        h('div', {}, `${pending.from === 'vision' ? 'Found' : 'Selected'} the ${pending.label}: ${describeOp({ ...pending.op, ...placement(pending.region) } as SceneEdit)}.`),
        h('div', { class: 'muted small' }, 'Previewing. Drag the outline to resize, click elsewhere to re-place.'),
        h(
          'div',
          { class: 'row' },
          h('button', { type: 'button', class: 'primary', 'data-testid': 'edit-apply', onclick: () => void applyPending() }, 'Apply'),
          h('button', { type: 'button', 'data-testid': 'edit-replace', onclick: () => { if (pending) { pending.region = null; pending.from = null; showGizmo(); render(); } } }, 'Click instead'),
          h('button', { type: 'button', 'data-testid': 'edit-cancel', onclick: () => { cancelPending(); render(); } }, 'Cancel'),
        ),
      );
    }

    // history
    historyBox.replaceChildren();
    const d = doc();
    const entries = [...(d?.history ?? [])].reverse();
    undoBtn.disabled = !d || !entries.some((e) => e.appliedOpIds.some((id) => d.edits.some((x) => x.id === id)));
    if (!entries.length) historyBox.append(h('div', { class: 'muted small' }, 'No edits yet.'));
    for (const entry of entries.slice(0, 40)) {
      const ops = entry.appliedOpIds.map((id) => ({ id, op: d!.edits.find((e) => e.id === id) }));
      historyBox.append(
        h(
          'div',
          { class: 'edit-entry', 'data-testid': 'edit-entry' },
          h('div', { class: 'edit-entry-head' }, h('span', { class: `chip scope-${SCOPE_LABEL[entry.plan.scope]}` }, SCOPE_LABEL[entry.plan.scope]), ' ', h('b', {}, entry.prompt)),
          h('div', { class: 'muted small' }, entry.plan.summary),
          ...ops
            .filter(({ id }) => !id.endsWith('.before'))
            .map(({ id, op }) =>
              op
                ? h(
                    'div',
                    { class: 'edit-op', 'data-testid': 'edit-op', 'data-id': id },
                    h('input', { type: 'checkbox', checked: op.enabled, title: 'On / off', onchange: (ev: Event) => toggle(id, (ev.target as HTMLInputElement).checked) }),
                    h('span', { class: op.enabled ? '' : 'muted' }, describeOp(op)),
                    h('span', { class: 'spacer' }),
                    h('button', { type: 'button', class: 'icon', title: 'Delete this edit', onclick: () => remove(id) }, '×'),
                  )
                : h('div', { class: 'edit-op muted small' }, 'removed'),
            ),
        ),
      );
    }
  }

  director.on((c) => {
    if (c === 'scene') {
      cancelPending();
      selection = null;
      selecting = false;
      const r = rt();
      if (r) {
        r.scene.add(gizmo.object);
        r.look.onEdits(() => render());
        if (!r.edits) void ensureDoc().then(render);
      }
      render();
    }
  });
  render();

  const panel: EditPanel = {
    send: (p) => send(p),
    state: () => ({
      busy,
      selecting,
      selection,
      pending: pending && { label: pending.label, from: pending.from, region: pending.region, box: pending.box, opId: pending.op.id },
      queue: queue.length,
      plan: lastPlan?.plan ?? null,
      error,
      revision: doc()?.revision ?? null,
      edits: doc()?.edits ?? [],
      sceneEdits: rt()?.sceneEdits?.debug() ?? null,
      regen,
    }),
  };
  Object.defineProperty(window, '__previzEdits', {
    configurable: true,
    value: Object.freeze({
      ...panel,
      apply: () => applyPending(),
      cancel: () => cancelPending(),
      regen: () => (lastPlan?.plan ? startRegen(lastPlan.plan) : Promise.resolve()),
      clickAt: (ndc: [number, number]) => {
        const splat = rt()?.splat;
        const region = splat && sphereFromClick(splat, director.mainCamera(), ndc);
        if (region) placeRegion(region, 'click');
        return region ?? null;
      },
      select: (on: boolean) => {
        selecting = on;
        render();
      },
      setSelection: (s: RegionSelection | null) => setSelection(s),
      toggle: (id: string, on: boolean) => save((d) => setOpEnabled(d, id, on)),
      remove: (id: string) => save((d) => removeOp(d, id)),
      undo: () => undoLast(),
      gizmo,
      THREE,
    }),
  });
  return panel;
}
