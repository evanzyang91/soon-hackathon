// Walk controls on the phone HUD (DOM; the math is in walk.ts): a floating left-thumb joystick,
// a spring-loaded vertical height slider, and WASD / arrow keys + Q / E in the desktop simulator.
// Pointer events, so touch, pen and mouse all drive them; each stick follows one pointer, so a
// thumb on the joystick never disturbs a pinch or a button press with the other hand.
import { NO_WALK, stickVector, type WalkInput } from './walk.ts';

export interface StickOptions {
  /** Knob travel (px) for full deflection. */
  radius: number;
  /** 'xy' = joystick, 'y' = vertical slider. */
  axis: 'xy' | 'y';
  /** The base jumps to where the thumb lands (joystick) instead of staying put (slider). */
  floating: boolean;
}

const TAP_MS = 260;
const TAP_SLOP_PX = 12;
const DOUBLE_TAP_MS = 380;

export class TouchStick {
  /** Deflection, -1..1 (y up = +). */
  x = 0;
  y = 0;
  /** Two quick taps without dragging. */
  onDoubleTap?: () => void;
  private pointer: number | null = null;
  private origin = { x: 0, y: 0 };
  private downAt = 0;
  private travel = 0;
  private lastTapAt = -Infinity;

  constructor(
    private readonly zone: HTMLElement,
    private readonly base: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly opts: StickOptions,
  ) {
    zone.addEventListener('pointerdown', this.onDown);
    zone.addEventListener('pointermove', this.onMove);
    zone.addEventListener('pointerup', this.onUp);
    zone.addEventListener('pointercancel', this.onUp);
    zone.addEventListener('lostpointercapture', this.onUp);
    // a long press must not open the iOS callout / context menu
    zone.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  get active(): boolean {
    return this.pointer !== null;
  }

  private onDown = (e: PointerEvent) => {
    if (this.pointer !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    this.pointer = e.pointerId;
    try {
      this.zone.setPointerCapture(e.pointerId);
    } catch {
      // synthetic events in tests have no active pointer to capture
    }
    this.origin = { x: e.clientX, y: e.clientY };
    this.downAt = performance.now();
    this.travel = 0;
    if (this.opts.floating) {
      const r = this.zone.getBoundingClientRect();
      this.base.style.left = `${e.clientX - r.left}px`;
      this.base.style.top = `${e.clientY - r.top}px`;
    }
    this.zone.dataset.active = '';
    this.set(0, 0);
  };

  private onMove = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    e.preventDefault();
    const dx = this.opts.axis === 'y' ? 0 : e.clientX - this.origin.x;
    const dy = e.clientY - this.origin.y;
    this.travel = Math.max(this.travel, Math.hypot(dx, dy));
    this.set(dx, dy);
  };

  private onUp = (e: PointerEvent) => {
    if (e.pointerId !== this.pointer) return;
    this.pointer = null;
    delete this.zone.dataset.active;
    if (this.opts.floating) {
      this.base.style.left = '';
      this.base.style.top = '';
    }
    this.set(0, 0);
    if (e.type !== 'pointerup') return;
    const now = performance.now();
    if (now - this.downAt > TAP_MS || this.travel > TAP_SLOP_PX) return;
    if (now - this.lastTapAt < DOUBLE_TAP_MS) {
      this.lastTapAt = -Infinity;
      this.onDoubleTap?.();
    } else this.lastTapAt = now;
  };

  private set(dx: number, dy: number) {
    const v = stickVector(dx, dy, this.opts.radius);
    this.x = this.opts.axis === 'y' ? 0 : v.x;
    this.y = v.y;
    const r = this.opts.radius;
    this.knob.style.transform = `translate(${this.x * r}px, ${-this.y * r}px)`;
  }
}

const KEYS: Record<string, keyof WalkInput | `-${keyof WalkInput}`> = {
  KeyW: 'y',
  ArrowUp: 'y',
  KeyS: '-y',
  ArrowDown: '-y',
  KeyD: 'x',
  ArrowRight: 'x',
  KeyA: '-x',
  ArrowLeft: '-x',
  KeyE: 'rise',
  PageUp: 'rise',
  KeyQ: '-rise',
  PageDown: '-rise',
};

/** WASD / arrows walk, Q / E (or Page Down / Up) change height. Desktop simulator only. */
export class KeyboardWalk {
  private readonly down = new Set<string>();

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      if (!(e.code in KEYS) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      this.down.add(e.code);
    });
    target.addEventListener('keyup', (e) => this.down.delete(e.code));
    target.addEventListener('blur', () => this.down.clear());
  }

  get input(): WalkInput {
    if (!this.down.size) return NO_WALK;
    const v = { x: 0, y: 0, rise: 0 };
    for (const code of this.down) {
      const k = KEYS[code]!;
      if (k.startsWith('-')) v[k.slice(1) as keyof WalkInput] -= 1;
      else v[k as keyof WalkInput] += 1;
    }
    return {
      x: Math.sign(v.x),
      y: Math.sign(v.y),
      rise: Math.sign(v.rise),
    };
  }
}
