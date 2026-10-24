// edits.json for direct manipulation on the laptop: a live preview goes straight into the open
// scene's document (SceneRuntime.edits — viewer/edits/apply.ts re-applies it next frame), and a
// commit is saved with a read-modify-write PUT (one at a time; a 409 re-runs the change on the
// stored document). The saved document is adopted through SceneLook.adoptEdits, so the look
// session announces the new revision to the phone and the Edit tab's history re-renders.
import { emptySceneEdits, type Look, type SceneEdits } from '@shared/look';
import { fetchEdits, putEdits } from '../viewer/look/edits-client';
import type { ManipEdits } from '../viewer/manipulate';
import type { SceneRuntime } from '../viewer/world';
import type { Director } from './director';

type Fn = (d: SceneEdits) => SceneEdits;

export class EditsStore implements ManipEdits {
  /**
   * The look session: flushed before a save so an unsaved look reaches the file first; when the
   * director changes the look while the save is in flight, that newer look is re-applied after the
   * saved document is adopted (adopting sets the file's look).
   */
  look: { flush(): Promise<void>; dirty(): boolean; reapply(look: Look): void } | null = null;
  /** True while this store hands a saved document to the scene (look changes it causes are ours). */
  adopting = false;
  private preview_: { base: SceneEdits; doc: SceneEdits; fn: Fn } | null = null;
  private readonly server = new WeakMap<SceneRuntime, SceneEdits>();
  /** Documents this store made itself (previews, optimistic commits): never a server revision. */
  private readonly locals = new WeakSet<SceneEdits>();
  private chain: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly director: Director) {}

  private get rt() {
    return this.director.runtime;
  }

  current(): SceneEdits | null {
    return this.rt?.edits ?? null;
  }

  base(): SceneEdits | null {
    const rt = this.rt;
    if (!rt) return null;
    if (this.preview_ && rt.edits === this.preview_.doc) return this.preview_.base;
    this.preview_ = null;
    return rt.edits ?? null;
  }

  preview(fn: Fn) {
    const rt = this.rt;
    if (!rt) return;
    this.noteShown(rt);
    const base = this.base() ?? emptySceneEdits();
    this.preview_ = { base, doc: fn(base), fn };
    this.locals.add(this.preview_.doc);
    rt.edits = this.preview_.doc;
  }

  cancelPreview() {
    const rt = this.rt;
    const p = this.preview_;
    this.preview_ = null;
    if (rt && p && rt.edits === p.doc) rt.edits = p.base;
  }

  commit(fn: Fn): Promise<boolean> {
    const rt = this.rt;
    const id = this.director.projectId;
    const n = this.director.sceneIndex;
    if (!rt) return Promise.resolve(false);
    this.noteShown(rt);
    // optimistic: the change shows now, the save follows
    const local = fn(this.base() ?? emptySceneEdits());
    this.locals.add(local);
    this.preview_ = null;
    rt.edits = local;
    if (id == null || n == null) return Promise.resolve(false);
    this.pending++;
    const run = this.chain.then(() => this.save(rt, id, n, fn));
    this.chain = run.catch(() => {});
    return run
      .catch((err) => {
        console.warn('[edits] save failed', err);
        return false;
      })
      .finally(() => this.pending--);
  }

  private async save(rt: SceneRuntime, id: string, n: number, fn: Fn): Promise<boolean> {
    try {
      await this.look?.flush();
    } catch {
      // the look saves on its own schedule; ours still goes through
    }
    this.noteShown(rt);
    let doc = this.server.get(rt) ?? (await fetchEdits(id, n));
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await putEdits(id, n, fn(doc));
      if (r.ok) {
        this.server.set(rt, r.doc);
        if (this.pending <= 1 && this.rt === rt) this.adopt(rt, r.doc);
        return true;
      }
      doc = r.conflict;
      this.server.set(rt, doc);
    }
    throw new Error('edits kept changing underneath (4 conflicts in a row)');
  }

  /** The saved document becomes the scene's (keeping a drag that started meanwhile on top). */
  private adopt(rt: SceneRuntime, doc: SceneEdits) {
    const p = this.preview_;
    const live = this.look?.dirty() ? rt.getLook() : null;
    this.adopting = true;
    try {
      rt.look.adoptEdits(doc);
      if (live && JSON.stringify(live) !== JSON.stringify(doc.look)) this.look?.reapply(live);
    } finally {
      this.adopting = false;
    }
    if (p && this.preview_ === p) {
      this.preview_ = { base: doc, doc: p.fn(doc), fn: p.fn };
      this.locals.add(this.preview_.doc);
      rt.edits = this.preview_.doc;
    }
  }

  /**
   * The look session puts each document it saved into rt.edits (not through adoptEdits): when the
   * scene shows a document this store did not make, it is the newest stored one (spares a 409).
   */
  private noteShown(rt: SceneRuntime) {
    const shown = rt.edits;
    if (shown && !this.locals.has(shown)) this.noteServer(rt, shown);
  }

  /** Another writer's document (the look session, the Edit tab) is the newest one we know. */
  noteServer(rt: SceneRuntime, doc: SceneEdits) {
    const prev = this.server.get(rt);
    if (!prev || doc.revision >= prev.revision) this.server.set(rt, doc);
  }
}
