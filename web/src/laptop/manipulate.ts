// Direct manipulation on the laptop: the viewer's Manipulator (viewer/manipulate) wired to the
// director (cameras, selection, the frame loop, fly-controls), the look session (lights, focus)
// and edits.json (EditsStore). Also owns ⌘Z / ⇧⌘Z for the director's undo stack, sharing the
// keys with the Look panel's own history: whichever changed last is undone first.
import type { Look } from '@shared/look';
import type { RegionSelection } from '../viewer/edits/select';
import { Manipulator, type ManipHost } from '../viewer/manipulate';
import type { SceneRuntime } from '../viewer/world';
import type { Director } from './director';
import { isTyping } from './dom';
import { EditsStore } from './edits-store';
import { GIZMO_LAYER } from './gizmos';
import type { LookPanel } from './look-panel';
import { displayName } from './projects-panel';

export interface ManipulationOptions {
  toast(text: string): void;
  /** The Look tab is showing (its own ⌘Z is live then). */
  lookVisible(): boolean;
  /** Switch the right panel to a tab (Edit › hands a region over). */
  showTab(tab: 'edit'): void;
}

export interface Manipulation {
  manipulator: Manipulator;
  store: EditsStore;
  /** Undo / redo the newest step: the director's stack, or the Look panel's when it changed last. */
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
}

interface EditsHook {
  setSelection?(sel: RegionSelection | null): void;
}

export function mountManipulation(director: Director, look: LookPanel, opts: ManipulationOptions): Manipulation {
  const store = new EditsStore(director);
  const session = look.session;
  store.look = { flush: () => session.flush(), dirty: () => session.isDirty, reapply: (l: Look) => session.apply(l, null) };
  const stage = director.canvas.parentElement ?? document.body;

  /** Look changes made by the manipulator (or its saves) are not "the Look panel changed last". */
  let manipLook = false;
  let lastLookChange = -Infinity;
  const setLook = (next: Look, coalesce: string | null) => {
    manipLook = true;
    try {
      session.apply(next, coalesce);
    } finally {
      manipLook = false;
    }
  };

  const host: ManipHost = {
    canvas: director.canvas,
    overlay: stage,
    layer: GIZMO_LAYER,
    runtime: () => director.runtime,
    camera: () => (director.viewFromPhone ? null : director.camera),
    blocked: (e) => {
      const c = director.canvas;
      if (c.classList.contains('look-picking') || c.classList.contains('edit-picking')) return true;
      if (document.pointerLockElement === c) return true;
      const pip = director.pipRect;
      if (!pip) return false;
      const r = c.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      return x >= pip.x && x <= pip.x + pip.width && y >= pip.y && y <= pip.y + pip.height;
    },
    names: () => new Map((director.runtime?.manifest.characters ?? []).map((c) => [c.id, displayName(c.name)])),
    edits: store,
    undo: director.undo,
    look: () => session.look,
    setLook,
    sealLook: () => session.seal(),
    cameraLens: (id) => {
      const l = session.look;
      if (!l) return null;
      // the Look panel keeps per-camera lenses next to the cameras (look-panel.ts)
      const own = look.cameraLens(id);
      return own ? { dof: own, own: true } : { dof: l.dof, own: false };
    },
    setCameraLens: (id, dof) => look.setCameraLens(id, dof),
    cameras: () => director.cameras,
    activeCameraId: () => director.activeCameraId,
    updateCamera: (id, patch, persist) => director.updateCamera(id, patch, persist),
    removeCamera: (id) => director.removeCamera(id),
    restoreCamera: (cam, index, active) => director.restoreCamera(cam, index, active),
    setActiveCamera: (id) => director.setActiveCamera(id),
    lookThrough: (cam) => director.flyTo(cam),
    selectionChanged: (ref) => director.select(ref),
    regionChanged: (sel) => director.setPendingRegion(sel),
    sendRegionToEdit: (sel) => {
      director.setPendingRegion(sel);
      opts.showTab('edit');
      // WP G's Edit tab takes a selection for its next prompt (window hook until it reads
      // director.pendingRegion itself)
      (window as unknown as { __previzEdits?: EditsHook }).__previzEdits?.setSelection?.(structuredClone(sel));
      opts.toast('Region handed to the Edit tab: describe the change');
    },
    toast: opts.toast,
  };
  const manipulator = new Manipulator(host);
  director.controls.claimLeft = (e) => manipulator.claims(e);
  director.onFrame(() => manipulator.frame());
  director.on((c) => {
    // the Scene tab's outliner selects through the director
    if (c === 'selection' && JSON.stringify(director.selection) !== JSON.stringify(manipulator.selected))
      manipulator.select(director.selection);
    if (c === 'scene') watch(director.runtime);
  });

  let watched: SceneRuntime | null = null;
  const offs: (() => void)[] = [];
  const watch = (rt: SceneRuntime | null) => {
    if (rt === watched) return;
    for (const off of offs.splice(0)) off();
    watched = rt;
    if (!rt) return;
    offs.push(
      rt.look.onChange(() => {
        if (!manipLook && !store.adopting) lastLookChange = performance.now();
      }),
      rt.look.onEdits((doc) => store.noteServer(rt, doc)),
    );
  };
  watch(director.runtime);

  // ---- one ⌘Z for both stacks ------------------------------------------------------------------
  const lookOwns = (redo: boolean) => {
    if (!opts.lookVisible()) return false;
    const h = session.history;
    if (!h) return false;
    return redo ? h.canRedo && lastLookChange > director.undo.nextRedoAt : h.canUndo && lastLookChange > director.undo.lastAt;
  };
  const say = (what: string, label: string | null) => label && opts.toast(`${what}: ${label}`);
  const undo = () => {
    if (lookOwns(false)) return session.undo();
    say('Undid', director.undo.undo());
  };
  const redo = () => {
    if (lookOwns(true)) return session.redo();
    say('Redid', director.undo.redo());
  };
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey) || isTyping(e.target)) return;
      const isRedo = (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && !e.shiftKey);
      if (e.code !== 'KeyZ' && !isRedo) return;
      if (lookOwns(isRedo)) return; // the Look panel's own handler runs
      if (isRedo ? !director.undo.canRedo : !director.undo.canUndo) return;
      e.preventDefault();
      e.stopPropagation();
      if (isRedo) say('Redid', director.undo.redo());
      else say('Undid', director.undo.undo());
    },
    { capture: true },
  );

  const api: Manipulation = {
    manipulator,
    store,
    undo,
    redo,
    canUndo: () => director.undo.canUndo || (opts.lookVisible() && !!session.history?.canUndo),
    canRedo: () => director.undo.canRedo || (opts.lookVisible() && !!session.history?.canRedo),
  };
  // debug / e2e: window.__manip.state(), .screenOf({type, id}, part), .select(ref)
  Object.defineProperty(window, '__manip', {
    configurable: true,
    value: Object.freeze({
      state: () => ({ ...manipulator.state(), undo: director.undo.depth, labels: director.undo.labels, pendingRegion: director.pendingRegion }),
      select: (ref: Parameters<Manipulator['select']>[0]) => manipulator.select(ref),
      screenOf: (ref: Parameters<Manipulator['screenOf']>[0], part?: Parameters<Manipulator['screenOf']>[1]) => manipulator.screenOf(ref, part),
      regionScreen: () => manipulator.regionScreen(),
      selectRegionAt: (clientX: number, clientY: number) => manipulator.selectRegionAt({ clientX, clientY }),
      floorFree: (x: number, z: number) => manipulator.floorFree(x, z),
      undo,
      redo,
      edits: () => store.current(),
    }),
  });
  return api;
}
