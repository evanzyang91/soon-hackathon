// The director's undo stack for direct manipulation (moves, turns, scales, deletes, region edits,
// camera drags). Each entry knows how to undo and redo itself; consecutive entries with the same
// `coalesce` key inside a short window (arrow-key nudges) merge into one step. Pure: the clock is
// injectable and the entries' actions may be async (they are started, not awaited).

/** Starts an entry's action; a failure (sync or async) is logged, never thrown into the caller. */
function run(fn: () => unknown, what: string) {
  try {
    void Promise.resolve(fn()).catch((err) => console.warn(`[${what}] failed`, err));
  } catch (err) {
    console.warn(`[${what}] failed`, err);
  }
}

export interface UndoEntry {
  /** "Move Maya", "Delete light Key" — shown after an undo. */
  label: string;
  undo(): unknown;
  redo(): unknown;
}

interface Stored extends UndoEntry {
  at: number;
  key: string | null;
}

export interface PushOptions {
  /** Merge with the previous entry when it has the same key and is younger than `windowMs`. */
  coalesce?: string;
  windowMs?: number;
}

export class UndoStack {
  private past: Stored[] = [];
  private future: Stored[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly limit = 100,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  /** When the newest undoable / redoable step was recorded (−∞ when none). */
  get lastAt() {
    return this.past.at(-1)?.at ?? -Infinity;
  }
  get nextRedoAt() {
    return this.future.at(-1)?.at ?? -Infinity;
  }
  get labels() {
    return { undo: this.past.at(-1)?.label ?? null, redo: this.future.at(-1)?.label ?? null };
  }
  get depth() {
    return { undo: this.past.length, redo: this.future.length };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  push(entry: UndoEntry, opts: PushOptions = {}) {
    const now = this.now();
    const key = opts.coalesce ?? null;
    const top = this.past.at(-1);
    if (key !== null && top && top.key === key && now - top.at <= (opts.windowMs ?? 1000)) {
      // one step: undo goes back to before the first nudge, redo to after the last
      this.past[this.past.length - 1] = { ...top, label: entry.label, redo: entry.redo, at: now };
    } else {
      this.past.push({ ...entry, at: now, key });
      if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    }
    this.future = [];
    this.changed();
  }

  undo(): string | null {
    const e = this.past.pop();
    if (!e) return null;
    this.future.push({ ...e, at: this.now(), key: null });
    run(() => e.undo(), 'undo');
    this.changed();
    return e.label;
  }

  redo(): string | null {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push({ ...e, at: this.now(), key: null });
    run(() => e.redo(), 'redo');
    this.changed();
    return e.label;
  }

  clear() {
    if (!this.past.length && !this.future.length) return;
    this.past = [];
    this.future = [];
    this.changed();
  }
}
