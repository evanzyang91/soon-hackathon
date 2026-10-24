// Undo / redo for look edits (pure). A slider drag is one step: `push` with the same `coalesce`
// key while the drag lasts replaces the pending step instead of stacking a new one.

export class LookHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  private openKey: string | null = null;

  constructor(
    private present: T,
    readonly limit = 50,
  ) {}

  get current(): T {
    return this.present;
  }
  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }
  get depth(): { undo: number; redo: number } {
    return { undo: this.past.length, redo: this.future.length };
  }

  /**
   * Records `next` as the new present. Consecutive pushes with the same non-null `coalesce` key
   * (one slider drag) collapse into one undo step; `seal()` ends the run.
   */
  push(next: T, coalesce: string | null = null): void {
    if (coalesce !== null && coalesce === this.openKey) {
      this.present = next;
      return;
    }
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.present = next;
    this.future = [];
    this.openKey = coalesce;
  }

  /** Ends the current coalescing run (pointer up / change event). */
  seal(): void {
    this.openKey = null;
  }

  undo(): T | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(this.present);
    this.present = prev;
    this.openKey = null;
    return prev;
  }

  redo(): T | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(this.present);
    this.present = next;
    this.openKey = null;
    return next;
  }

  /** Starts over at `present` (a scene opened, or another client's revision was loaded). */
  reset(present: T): void {
    this.past = [];
    this.future = [];
    this.present = present;
    this.openKey = null;
  }
}
