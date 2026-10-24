// Keeps 3D rendering from starving the pose stream (pure, no DOM).
//
// A slow GPU blocks the browser main thread at frame submission, which delays sensor events and
// the pose timer. The governor watches main-thread timer gaps in 1 s windows. If two of the last
// three windows saw stalls, it steps down: render less often and at a lower pixel ratio, and as a
// last resort pause 3D entirely (the viewfinder stays live). It steps back up after a run of
// clean windows, waiting longer each time a level has failed, so it does not oscillate.

export interface RenderLevel {
  /** Minimum ms between rendered frames (0 = every animation frame). */
  minIntervalMs: number;
  pixelRatio: number;
  render3d: boolean;
}

/** Short names for the HUD's perf label, one per level. */
export const LEVEL_NAMES = ['full', 'reduced', 'low', 'minimal', 'paused'] as const;

export const LEVELS: readonly RenderLevel[] = [
  { minIntervalMs: 0, pixelRatio: 1.5, render3d: true },
  { minIntervalMs: 50, pixelRatio: 1, render3d: true },
  { minIntervalMs: 100, pixelRatio: 0.75, render3d: true },
  { minIntervalMs: 250, pixelRatio: 0.5, render3d: true },
  { minIntervalMs: Infinity, pixelRatio: 0.5, render3d: false },
];

export interface GovernorOptions {
  enabled?: boolean;
  windowMs?: number;
  /** A window whose worst gap exceeds this counts as a stall. */
  badGapMs?: number;
  /** Stalls this bad skip two levels at once. */
  severeGapMs?: number;
  /** Windows must stay under this to count as clean. */
  goodGapMs?: number;
  /** Clean windows needed before stepping up (doubles each time a level fails, up to 60). */
  upAfterWindows?: number;
}

export class RenderGovernor {
  level = 0;
  readonly enabled: boolean;
  private readonly windowMs: number;
  private readonly badGapMs: number;
  private readonly severeGapMs: number;
  private readonly goodGapMs: number;
  private readonly baseUpAfter: number;
  /** Clean windows required to re-enter each level (grows when that level fails). */
  private readonly upAfter: number[];
  private windowStart = -1;
  private windowMax = 0;
  private recent: number[] = [];
  private clean = 0;
  private lastRender = -Infinity;
  /** Called with (newLevel, reason) whenever the level changes. */
  onChange?: (level: number, reason: string) => void;

  constructor(opts: GovernorOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.windowMs = opts.windowMs ?? 1000;
    this.badGapMs = opts.badGapMs ?? 120;
    this.severeGapMs = opts.severeGapMs ?? 400;
    this.goodGapMs = opts.goodGapMs ?? 45;
    this.baseUpAfter = opts.upAfterWindows ?? 5;
    this.upAfter = LEVELS.map(() => this.baseUpAfter);
  }

  get current(): RenderLevel {
    return LEVELS[this.level]!;
  }

  /** Feed the gap (ms) between two consecutive ticks of a short main-thread timer. */
  observeGap(now: number, gapMs: number): void {
    if (!this.enabled) return;
    if (this.windowStart < 0) this.windowStart = now;
    this.windowMax = Math.max(this.windowMax, gapMs);
    if (now - this.windowStart < this.windowMs) return;
    this.closeWindow(this.windowMax);
    this.windowStart = now;
    this.windowMax = 0;
  }

  /** Whether to render a 3D frame now. */
  shouldRender(now: number): boolean {
    const lvl = this.enabled ? this.current : LEVELS[0]!;
    return lvl.render3d && now - this.lastRender >= lvl.minIntervalMs;
  }

  rendered(now: number): void {
    this.lastRender = now;
  }

  private closeWindow(max: number) {
    this.recent.push(max);
    if (this.recent.length > 3) this.recent.shift();
    const stalls = this.recent.filter((g) => g > this.badGapMs);
    if (stalls.length >= 2 && this.level < LEVELS.length - 1) {
      const severe = stalls.filter((g) => g > this.severeGapMs).length >= 2;
      const from = this.level;
      // The level we are leaving failed: wait longer before trying it again.
      this.upAfter[from] = Math.min(60, this.upAfter[from]! * 2);
      this.set(
        Math.min(LEVELS.length - 1, from + (severe ? 2 : 1)),
        `stalls ${stalls.map(Math.round).join('/')} ms`,
      );
      return;
    }
    this.clean = max < this.goodGapMs ? this.clean + 1 : 0;
    if (this.level > 0 && this.clean >= this.upAfter[this.level - 1]!) {
      this.set(this.level - 1, `${this.clean} clean windows`);
    }
  }

  private set(level: number, reason: string) {
    this.level = level;
    this.recent = [];
    this.clean = 0;
    this.onChange?.(level, reason);
  }
}

/** What the phone's view is doing, for the HUD's perf label. */
export interface PerfState {
  /**
   * off = 2D only by choice (?3d=0); unavailable = no WebGL / 3D failed; waiting = no scene from
   * the laptop yet; loading = scene loading; webgl = 3D on screen (subject to the governor).
   */
  view: 'off' | 'unavailable' | 'waiting' | 'loading' | 'webgl';
  level: number;
  /** 3D frames drawn per second, measured. */
  fps: number;
}

/** Tiny bottom-right HUD label, e.g. "48 fps · full", "3D paused", so a frozen view is explained. */
export function perfLabel(p: PerfState): string {
  switch (p.view) {
    case 'off':
      return '2D viewfinder';
    case 'unavailable':
      return '3D unavailable';
    case 'waiting':
      return 'no scene yet';
    case 'loading':
      return 'loading 3D…';
  }
  const lvl = LEVELS[p.level];
  if (!lvl?.render3d) return '3D paused';
  const fps = Number.isFinite(p.fps) ? Math.round(p.fps) : 0;
  return `${fps} fps · ${LEVEL_NAMES[p.level]}`;
}
