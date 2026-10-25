// One scene's shot list on the server (scene-<n>/shots.json, shared/shots.ts): GET once, then every
// change is applied here at once (optimistic) and stored with a revision-checked PUT 300 ms after
// the last one, like edits.json. On 409 the stored list comes back and the changes not yet stored
// are replayed onto it (another tab's changes survive, ours land on top). Frame uploads go through
// the same queue, after any unsaved change (the shot has to be stored before its frame), and the
// server's revision bump is adopted.
import { api } from '@shared/api';
import { ShotList, type Shot } from '@shared/shots';

export type ShotEdit = (shots: Shot[]) => Shot[];
export type ShotsStatus = 'loading' | 'saved' | 'unsaved' | 'saving' | 'error';

const SAVE_MS = 300;
const MAX_CONFLICTS = 4;

export class ShotListClient {
  /** The list as the director sees it (stored + not yet stored changes). */
  shots: Shot[] = [];
  /** Revision of the stored list `shots` is based on (0: no shots.json yet). */
  revision = 0;
  loaded = false;
  status: ShotsStatus = 'loading';
  error: string | null = null;
  /** Changes applied to `shots` that the server has not stored yet, oldest first. */
  private pending: ShotEdit[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly projectId: string,
    readonly sceneIndex: number,
    private readonly onChange: () => void,
  ) {}

  async load(): Promise<void> {
    const res = await fetch(api.shots(this.projectId, this.sceneIndex), { cache: 'no-store' });
    if (!res.ok) throw new Error(`shot list: HTTP ${res.status}`);
    const list = ShotList.parse(await res.json());
    // a change made while loading lands on top of the stored list
    this.shots = this.pending.reduce((s, fn) => fn(s), list.shots);
    this.revision = list.revision;
    this.loaded = true;
    this.status = this.pending.length ? 'unsaved' : 'saved';
    this.onChange();
  }

  /** Applies `fn` now and stores the list `SAVE_MS` after the last change (`now`: at once). */
  edit(fn: ShotEdit, now = false) {
    this.shots = fn(structuredClone(this.shots));
    this.pending.push(fn);
    this.status = 'unsaved';
    this.onChange();
    this.schedule(now ? 0 : SAVE_MS);
  }

  /** Stores what is unsaved now; resolves when the queue is through it. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.enqueue(() => this.save());
  }

  /** Uploads a JPEG as the shot's frame (after unsaved changes); false when the shot is gone. */
  uploadFrame(shotId: string, jpeg: Blob): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    return this.enqueue(async () => {
      await this.save();
      const res = await fetch(api.shotFrame(this.projectId, this.sceneIndex, shotId), {
        method: 'PUT',
        headers: { 'content-type': 'image/jpeg' },
        body: jpeg,
      });
      if (res.status === 404) return false;
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `frame upload: HTTP ${res.status}`);
      }
      const list = ShotList.parse(await res.json());
      this.revision = list.revision;
      const got = list.shots.find((s) => s.id === shotId);
      if (got)
        this.shots = this.shots.map((s) => (s.id === shotId ? { ...s, frame: got.frame, frameAt: got.frameAt } : s));
      if (!this.pending.length) this.status = 'saved';
      this.onChange();
      return true;
    });
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.enqueue(() => this.save()).catch(() => {});
    }, ms);
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op);
    this.chain = run.catch(() => {});
    return run;
  }

  private async save(): Promise<void> {
    if (!this.loaded || !this.pending.length) return;
    let taken = this.pending.splice(0);
    this.status = 'saving';
    this.onChange();
    try {
      for (let attempt = 0; attempt < MAX_CONFLICTS; attempt++) {
        const body: ShotList = { version: 1, revision: this.revision, shots: this.shots };
        const res = await fetch(api.shots(this.projectId, this.sceneIndex), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          this.revision = ShotList.parse(await res.json()).revision;
          this.error = null;
          // changes made while the PUT was out go next
          this.status = this.pending.length ? 'unsaved' : 'saved';
          if (this.pending.length) this.schedule(SAVE_MS);
          this.onChange();
          return;
        }
        if (res.status !== 409) {
          const err = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(err?.error ?? `shot list: HTTP ${res.status}`);
        }
        // someone else stored a list: replay our changes (and any made meanwhile) onto theirs
        const { current } = (await res.json()) as { current: unknown };
        const stored = ShotList.parse(current);
        taken = [...taken, ...this.pending.splice(0)];
        this.revision = stored.revision;
        this.shots = taken.reduce((s, fn) => fn(structuredClone(s)), stored.shots);
        this.onChange();
      }
      throw new Error('the shot list kept changing underneath (4 conflicts in a row)');
    } catch (err) {
      // not stored: the changes stay pending for the next try
      this.pending = [...taken, ...this.pending];
      this.status = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      console.warn('[shots] save failed', err);
      this.onChange();
      throw err;
    }
  }
}
