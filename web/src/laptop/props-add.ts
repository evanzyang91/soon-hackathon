// Scene › Background › Add prop (docs/PLAN-v4.md "Props by import or by prompt"): the director's
// own objects in the scene.
//
//   Import a 3D model (.glb)       the file picker, or a .glb dropped on the viewport → POST
//                                  …/uploads (model/gltf-binary, ≤ 25 MB) → uploads/<sha16>.glb
//   Generate from a description…   an inline prompt + Go → POST …/props/generate → a PropJob row
//                                  ("Generating: a weathered wooden barrel · meshing on Modal…")
//                                  polled every 2 s; done → placed + toast; failed → the error +
//                                  Retry
//
// Either way the prop lands as one `prop-add` scene edit of kind 'model' (id `manip:add:<id>`):
// a one-point path on the ground 2 m in front of the view camera (runtime.groundY), speed 0, its
// front (+Z, the glTF convention) turned to the camera through PropModel.yawOffset, saved to
// edits.json (so the phone draws it too) and undoable (⌘Z). It is then a prop like any other:
// drag, turn, scale, delete, switch off. An imported model keeps its own size (glTF is in metres)
// when that is plausible; a generated one stands at the server's heightM (a size in the prompt,
// else 1 m). Jobs still running are remembered per project in localStorage, so a reload keeps
// polling them.
import * as THREE from 'three';
import type { SceneEdit } from '@shared/look';
import type { DynamicElement, PropJob, PropModel, Vec3 } from '@shared/schema';
import { headingFor } from '../viewer/dynamics-path';
import { withEdit, withoutEdit } from '../viewer/manipulate/edits';
import { modelHeight, projectFileResolver } from '../viewer/model-prop';
import { generateProp, getPropJob, uploadModel } from './api';
import type { Director } from './director';
import { h } from './dom';
import { icon } from './icons';
import type { Manipulation } from './manipulate';

export const MAX_GLB_BYTES = 25 * 1024 * 1024;
const MAX_PROMPT = 300;
const POLL_MS = 2000;
/** Metres in front of the view camera a new prop is put down. */
export const PLACE_AHEAD_M = 2;
const STORE_KEY = 'previz.propJobs';

interface Tracked {
  projectId: string;
  sceneIndex: number;
  job: PropJob;
  placed: boolean;
}

interface Importing {
  key: number;
  projectId: string;
  sceneIndex: number;
  name: string;
}

export interface PropAdder {
  /** The rows (importing / generating / failed) and the Add prop control, for Background. */
  nodes(): HTMLElement[];
  importFile(file: File): Promise<void>;
  generate(prompt: string): Promise<void>;
  /** Background re-renders when a row or the scene's props change. */
  onChange(fn: () => void): void;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const isGlb = (f: File) => /\.glb$/i.test(f.name) || f.type === 'model/gltf-binary';

/** Where a new prop goes: on the ground PLACE_AHEAD_M in front of the view camera, facing it. */
export function placementAhead(director: Director): { position: Vec3; facing: number } | null {
  const rt = director.runtime;
  if (!rt) return null;
  const cam = director.mainCamera();
  cam.updateMatrixWorld();
  const from = cam.getWorldPosition(new THREE.Vector3());
  const dir = cam.getWorldDirection(new THREE.Vector3()).setY(0);
  if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); // looking straight down: put it "north"
  dir.normalize();
  const x = from.x + dir.x * PLACE_AHEAD_M;
  const z = from.z + dir.z * PLACE_AHEAD_M;
  const y = rt.groundY(x, z);
  // +Z (the model's front) onto −dir, i.e. toward the camera: the yaw that turns −Z onto dir
  return { position: [round3(x), round3(Number.isFinite(y) ? y : 0), round3(z)], facing: Math.round(headingFor(dir.x, dir.z) * 1e4) / 1e4 };
}

export function mountPropAdder(director: Director, manip: Manipulation, opts: { toast(text: string): void }): PropAdder {
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((fn) => fn());
  const jobs = new Map<string, Tracked>();
  const importing: Importing[] = [];
  let importKey = 0;
  const here = (t: { projectId: string; sceneIndex: number }) => director.projectId === t.projectId && director.sceneIndex === t.sceneIndex;

  // ---- placement ----------------------------------------------------------------------------------
  const place = async (model: PropModel, label: string): Promise<boolean> => {
    const spot = placementAhead(director);
    if (!spot) return false;
    const id = `model-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const element: DynamicElement = {
      id,
      kind: 'model',
      label: label.slice(0, 200),
      path: [spot.position],
      speed: 0,
      loop: false,
      pauseSeconds: 0,
      scale: 1,
      model: { ...model, yawOffset: Math.round((spot.facing + (model.yawOffset ?? 0)) * 1e4) / 1e4 },
    };
    const edit: SceneEdit = { kind: 'prop-add', id: `manip:add:${id}`, element, enabled: true };
    const store = manip.store;
    const saved = store.commit((d) => withEdit(d, edit));
    director.undo.push({
      label: `Add ${element.label}`,
      undo: () => store.commit((d) => withoutEdit(d, edit.id)),
      redo: () => store.commit((d) => withEdit(d, edit)),
    });
    changed();
    // select it once the edit is applied (next frame), so it can be dragged right away
    setTimeout(() => director.runtime && director.select({ type: 'prop', id }), 120);
    const ok = await saved;
    if (!ok) opts.toast(`${element.label}: shown here, but the scene could not be saved (the phone will not see it)`);
    return ok;
  };

  // ---- import ---------------------------------------------------------------------------------------
  const importFile = async (file: File) => {
    const projectId = director.projectId;
    const sceneIndex = director.sceneIndex;
    const rt = director.runtime;
    if (!rt || projectId == null || sceneIndex == null) return opts.toast('Open a scene first.');
    if (!isGlb(file)) return opts.toast(`${file.name}: only glTF binaries (.glb) can be imported`);
    if (file.size > MAX_GLB_BYTES) return opts.toast(`${file.name} is over 25 MB; export it smaller (fewer triangles, smaller textures)`);
    const row: Importing = { key: ++importKey, projectId, sceneIndex, name: file.name };
    importing.push(row);
    changed();
    try {
      const up = await uploadModel(projectId, file, file.name);
      // keep its own size when it is a plausible one (glTF units are metres)
      const native = await modelHeight(projectFileResolver(rt.manifestUrl)(up.file));
      const heightM = native && native >= 0.02 && native <= 100 ? round3(native) : 1;
      if (!here(row)) return opts.toast(`${file.name} was uploaded; reopen scene ${sceneIndex + 1} to place it`);
      const name = file.name.replace(/\.glb$/i, '') || 'model';
      if (native === null) opts.toast(`${file.name} did not load in the viewer; it is shown as a marker`);
      await place({ file: up.file, heightM, source: file.name.slice(0, 200) }, name);
      opts.toast(`Imported ${file.name} · ${heightM} m tall, 2 m in front of the camera`);
    } catch (e) {
      opts.toast(`Could not import ${file.name}: ${(e as Error).message}`);
    } finally {
      importing.splice(importing.indexOf(row), 1);
      changed();
    }
  };

  // ---- generate -------------------------------------------------------------------------------------
  const persist = () => {
    try {
      const open = [...jobs.values()].filter((t) => !t.placed && t.job.status !== 'failed').map((t) => ({ p: t.projectId, s: t.sceneIndex, id: t.job.id }));
      localStorage.setItem(STORE_KEY, JSON.stringify(open));
    } catch {
      /* private mode: jobs are not remembered across reloads */
    }
  };
  const generate = async (raw: string) => {
    const prompt = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT);
    const projectId = director.projectId;
    const sceneIndex = director.sceneIndex;
    if (!prompt) return;
    if (!director.runtime || projectId == null || sceneIndex == null) return opts.toast('Open a scene first.');
    try {
      const job = await generateProp(projectId, prompt, sceneIndex);
      jobs.set(job.id, { projectId, sceneIndex, job, placed: false });
      persist();
      changed();
      schedule();
    } catch (e) {
      opts.toast(`Could not start "${prompt}": ${(e as Error).message}`);
    }
  };

  const settle = async (t: Tracked) => {
    if (t.job.status !== 'done' || t.placed || !here(t)) return;
    t.placed = true;
    persist();
    const model = t.job.model;
    if (!model) {
      t.job = { ...t.job, status: 'failed', error: 'the job finished without a model' };
      return changed();
    }
    await place({ ...model, source: model.source ?? t.job.prompt.slice(0, 200) }, t.job.prompt);
    const spend = t.job.costUsd ? ` · $${t.job.costUsd.toFixed(2)}` : '';
    opts.toast(`Placed: ${t.job.prompt}${spend}`);
    jobs.delete(t.job.id);
    changed();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, POLL_MS);
  };
  const poll = async () => {
    const active = [...jobs.values()].filter((t) => t.job.status === 'pending' || t.job.status === 'running');
    await Promise.all(
      active.map(async (t) => {
        try {
          const next = await getPropJob(t.projectId, t.job.id);
          if (JSON.stringify(next) !== JSON.stringify(t.job)) {
            t.job = next;
            changed();
          }
        } catch (e) {
          // a job the server no longer knows (a wiped data dir) ends; a network blip retries
          if (/HTTP 404/.test((e as Error).message)) {
            t.job = { ...t.job, status: 'failed', error: 'the server no longer knows this job' };
            changed();
          }
        }
      }),
    );
    for (const t of jobs.values()) await settle(t);
    persist();
    if ([...jobs.values()].some((t) => t.job.status === 'pending' || t.job.status === 'running')) schedule();
  };

  // a reload keeps polling what was still running
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as { p: string; s: number; id: string }[];
    for (const r of Array.isArray(saved) ? saved : []) {
      if (typeof r?.id !== 'string' || typeof r.p !== 'string' || !Number.isInteger(r.s)) continue;
      jobs.set(r.id, {
        projectId: r.p,
        sceneIndex: r.s,
        placed: false,
        job: { id: r.id, projectId: r.p, sceneIndex: r.s, prompt: '…', status: 'pending', note: 'checking', startedAt: new Date().toISOString() },
      });
    }
    if (jobs.size) schedule();
  } catch {
    /* nothing remembered */
  }

  // a finished job whose scene was not open is placed when the director opens it
  director.on((c) => {
    if (c !== 'scene') return;
    for (const t of jobs.values()) void settle(t);
    changed();
  });

  // ---- DOM ---------------------------------------------------------------------------------------------
  const fileInput = h('input', { type: 'file', accept: '.glb,model/gltf-binary', hidden: true, 'data-testid': 'prop-file' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (f) void importFile(f);
  });
  const prompt = h('input', {
    type: 'text',
    class: 'small',
    maxlength: MAX_PROMPT,
    placeholder: 'a weathered wooden barrel',
    'aria-label': 'Describe the prop',
    'data-testid': 'prop-prompt',
  });
  const go = h('button', { type: 'submit', class: 'small primary', 'data-testid': 'prop-generate-go' }, 'Go');
  const form = h(
    'form',
    { class: 'prop-gen', hidden: true, 'data-testid': 'prop-generate-form' },
    prompt,
    go,
    h('button', { type: 'button', class: 'icon', title: 'Cancel', 'aria-label': 'Cancel', onclick: () => closeAll() }, icon('close')),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = prompt.value;
    if (!text.trim()) return prompt.focus();
    prompt.value = '';
    closeAll();
    void generate(text);
  });
  const menu = h(
    'div',
    { class: 'menu prop-add-menu', role: 'menu', hidden: true, 'data-testid': 'add-prop-menu' },
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        'data-testid': 'add-prop-import',
        title: 'A glTF binary up to 25 MB (no Draco / meshopt compression); you can also drop it on the view',
        onclick: () => {
          closeAll();
          fileInput.click();
        },
      },
      'Import a 3D model (.glb)',
    ),
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        'data-testid': 'add-prop-generate',
        title: 'A picture of the object, then a 3D model from it (about a minute or two)',
        onclick: () => {
          menu.hidden = true;
          button.setAttribute('aria-expanded', 'false');
          form.hidden = false;
          prompt.focus();
        },
      },
      'Generate from a description…',
    ),
    h('div', { class: 'muted small prop-add-hint' }, 'Or drop a .glb on the view.'),
  );
  const button = h(
    'button',
    {
      type: 'button',
      class: 'small',
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
      'data-testid': 'add-prop',
      title: 'Put your own object in the scene: import a .glb or describe one',
      onclick: () => {
        const open = menu.hidden;
        closeAll();
        menu.hidden = !open;
        button.setAttribute('aria-expanded', String(open));
      },
    },
    icon('plus'),
    'Add prop',
  );
  const control = h('div', { class: 'prop-add' }, button, menu, form, fileInput);
  const closeAll = () => {
    menu.hidden = true;
    form.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  };
  control.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAll();
      button.focus();
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!menu.hidden && !control.contains(e.target as Node)) closeAll();
  });

  const jobRow = (t: Tracked) => {
    const { job } = t;
    if (job.status === 'failed')
      return h(
        'div',
        { class: 'list-row prop-job failed', 'data-testid': 'prop-job-row', 'data-status': 'failed', 'data-job': job.id },
        h('span', { class: 'dot bad' }),
        h(
          'span',
          { class: 'bg-name', title: job.error ?? '' },
          `Could not generate: ${job.prompt}`,
          h('span', { class: 'muted small prop-job-error' }, job.error ? ` · ${job.error}` : ''),
        ),
        h('button', { type: 'button', class: 'small', 'data-testid': 'prop-job-retry', title: 'Try the same description again', onclick: () => (jobs.delete(job.id), persist(), changed(), void generate(job.prompt)) }, 'Retry'),
        h('button', { type: 'button', class: 'icon', title: 'Dismiss', 'aria-label': 'Dismiss', onclick: () => (jobs.delete(job.id), persist(), changed()) }, icon('close')),
      );
    const note = job.status === 'done' ? 'placing…' : job.note ? `${job.note}…`.replace(/…+$/, '…') : 'starting…';
    return h(
      'div',
      { class: 'list-row prop-job', 'data-testid': 'prop-job-row', 'data-status': job.status, 'data-job': job.id, title: `Generating a 3D model of "${job.prompt}"` },
      h('span', { class: 'dot run' }),
      h('span', { class: 'bg-name' }, `Generating: ${job.prompt}`, h('span', { class: 'muted' }, ` · ${note}`)),
    );
  };

  // ---- drop a .glb on the viewport ---------------------------------------------------------------------
  const stage = director.canvas.parentElement ?? document.body;
  const dropHint = h('div', { class: 'prop-drop', hidden: true, 'data-testid': 'prop-drop' }, 'Drop a .glb to add it as a prop');
  stage.append(dropHint);
  const hasFiles = (e: DragEvent) => !!director.runtime && !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let depth = 0;
  stage.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    dropHint.hidden = false;
  });
  stage.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'copy';
  });
  stage.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--depth <= 0) {
      depth = 0;
      dropHint.hidden = true;
    }
  });
  stage.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dropHint.hidden = true;
    const files = [...e.dataTransfer!.files];
    const models = files.filter(isGlb);
    if (!models.length) return opts.toast('Only .glb models can be dropped on the view (photos go in the chat)');
    for (const f of models) void importFile(f);
  });

  return {
    nodes: () => {
      const rows: HTMLElement[] = [];
      for (const r of importing)
        if (here(r))
          rows.push(h('div', { class: 'list-row prop-job', 'data-testid': 'prop-import-row' }, h('span', { class: 'dot run' }), h('span', { class: 'bg-name' }, `Importing ${r.name}…`)));
      for (const t of jobs.values()) if (here(t)) rows.push(jobRow(t));
      return [...rows, control];
    },
    importFile,
    generate,
    onChange: (fn) => void listeners.add(fn),
  };
}
