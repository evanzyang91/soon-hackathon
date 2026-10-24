// The laptop's look editing session for the open scene: applies every change live, keeps undo /
// redo, saves edits.json 300 ms after the last change (optimistic revision; a 409 keeps the other
// writer's scene edits and re-applies this look on top), and says what the phone should get:
// `liveLook` while changes are unsaved, `revision` once they are on disk.
import { emptySceneEdits, type Look, type SceneEdits } from '@shared/look';
import { fetchEdits, putEdits } from './edits-client';
import { LookHistory } from './history';
import type { SceneLook } from './scene-look';

export type SessionStatus = 'idle' | 'loading' | 'saved' | 'unsaved' | 'saving' | 'offline' | 'error';

export interface SessionTarget {
  projectId: string;
  sceneIndex: number;
  look: SceneLook;
}

export interface SessionOptions {
  debounceMs?: number;
  /** Status / history / look changed (re-render the panel). */
  onChange?(): void;
  /** The phone should hear about it (live look or a new revision); `force` = right away. */
  onBroadcast?(force: boolean): void;
  /** Swappable for tests. */
  load?: typeof fetchEdits;
  save?: typeof putEdits;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class LookSession {
  status: SessionStatus = 'idle';
  /** Revision of edits.json that the current look is saved in (or was loaded from). */
  revision = 0;
  error: string | null = null;
  history: LookHistory<Look> | null = null;
  private target: SessionTarget | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;
  private again = false;
  private offEdits: (() => void) | null = null;
  private readonly debounceMs: number;
  private readonly load: typeof fetchEdits;
  private readonly put: typeof putEdits;

  constructor(private readonly opts: SessionOptions = {}) {
    this.debounceMs = opts.debounceMs ?? 300;
    this.load = opts.load ?? fetchEdits;
    this.put = opts.save ?? putEdits;
  }

  get look(): Look | null {
    return this.target?.look.getLook() ?? null;
  }

  get sceneLook(): SceneLook | null {
    return this.target?.look ?? null;
  }

  /** The look the phone should render now when it differs from the saved file (else null). */
  get liveLook(): Look | null {
    return this.dirty ? this.look : null;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Opens a scene: loads its edits.json (defaults when absent) and makes its look current. */
  async open(target: SessionTarget): Promise<void> {
    if (this.target && this.dirty) void this.flush();
    this.offEdits?.();
    this.target = target;
    this.dirty = false;
    this.revision = 0;
    this.history = new LookHistory(target.look.getLook());
    this.setStatus('loading');
    try {
      const doc = await this.load(target.projectId, target.sceneIndex);
      if (this.target !== target) return;
      this.revision = doc.revision;
      target.look.adoptEdits(doc);
      this.history.reset(doc.look);
      this.setStatus('saved');
    } catch (err) {
      if (this.target !== target) return;
      // no project behind this scene (an ad-hoc manifest): looks still work, they just do not save
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus('offline');
    }
    // another writer (the re-prompt panel) hands its server document to SceneLook.adoptEdits
    this.offEdits = target.look.onEdits((doc) => this.adopted(target, doc));
    this.opts.onBroadcast?.(true);
  }

  close() {
    if (this.dirty) void this.flush();
    this.offEdits?.();
    this.offEdits = null;
    this.target = null;
    this.history = null;
    this.setStatus('idle');
  }

  /** Applies `next` now; consecutive calls with the same `coalesce` key are one undo step. */
  apply(next: Look, coalesce: string | null = null): void {
    const t = this.target;
    if (!t || !this.history) return;
    t.look.setLook(next);
    this.history.push(t.look.getLook(), coalesce);
    this.changed();
  }

  /** Ends a slider drag (the next change is a new undo step). */
  seal() {
    this.history?.seal();
  }

  undo() {
    const prev = this.history?.undo();
    if (prev && this.target) {
      this.target.look.setLook(prev);
      this.changed();
    }
  }

  redo() {
    const next = this.history?.redo();
    if (next && this.target) {
      this.target.look.setLook(next);
      this.changed();
    }
  }

  private changed() {
    this.dirty = true;
    if (this.status !== 'offline') this.setStatus('unsaved');
    else this.opts.onChange?.();
    this.opts.onBroadcast?.(false);
    if (this.status === 'offline') return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Saves now (also what the debounce calls). Resolves when the look on screen is on disk. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saving) {
      this.again = true;
      return this.saving;
    }
    const t = this.target;
    if (!t || !this.dirty) return;
    this.saving = this.saveOnce(t).finally(() => {
      this.saving = null;
      if (this.again && this.target === t && this.dirty) {
        this.again = false;
        void this.flush();
      }
    });
    return this.saving;
  }

  private async saveOnce(t: SessionTarget): Promise<void> {
    this.setStatus('saving');
    const look = t.look.getLook();
    let base: SceneEdits = { ...(t.look.edits ?? emptySceneEdits()), revision: this.revision };
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await this.put(t.projectId, t.sceneIndex, { ...base, look });
        if (r.ok) {
          if (this.target !== t) return;
          this.revision = r.doc.revision;
          t.look.edits = r.doc;
          // still dirty if the director kept dragging while the request was in flight
          this.dirty = !same(t.look.getLook(), r.doc.look);
          this.setStatus(this.dirty ? 'unsaved' : 'saved');
          this.opts.onBroadcast?.(true);
          return;
        }
        // someone else saved first: keep their scene edits / history, put this look on top
        base = r.conflict;
        if (this.target === t) t.look.edits = r.conflict;
      }
      throw new Error('edits kept changing underneath (3 conflicts in a row)');
    } catch (err) {
      if (this.target !== t) return;
      this.error = err instanceof Error ? err.message : String(err);
      this.setStatus('error');
    }
  }

  /** A newer server document arrived through SceneLook.adoptEdits (e.g. a re-prompt). */
  private adopted(t: SessionTarget, doc: SceneEdits) {
    if (this.target !== t || doc.revision <= this.revision) return;
    this.revision = doc.revision;
    this.history?.push(doc.look);
    this.dirty = false;
    this.setStatus('saved');
    this.opts.onBroadcast?.(true);
  }

  private setStatus(s: SessionStatus) {
    this.status = s;
    if (s !== 'error' && s !== 'offline') this.error = null;
    this.opts.onChange?.();
  }
}
