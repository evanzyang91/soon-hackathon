// Touch + mouse input on the phone stage: pinch → zoom, one-finger / mouse drag → look (only
// when enabled: desktop simulator or no motion sensors), wheel → zoom (desktop).
import { Euler, Quaternion } from 'three';

export interface LookState {
  yaw: number;
  pitch: number;
}

export interface GestureHandlers {
  /** Pinch started: remember the current fov. */
  pinchStart(): void;
  /** scale = finger distance now / at start (> 1 zooms in). */
  pinch(scale: number): void;
  /** Look-drag produced a new camera orientation (pre-recenter). */
  look(q: Quaternion): void;
  /** Mouse wheel: + = zoom out. */
  wheel(deltaY: number): void;
  /** Orientation (pre-recenter) a new look-drag should continue from. */
  currentLook(): LookState;
}

export const lookQuaternion = (s: LookState) =>
  new Quaternion().setFromEuler(new Euler(s.pitch, s.yaw, 0, 'YXZ'));

/** Apply a drag of (dx, dy) px; `radPerPx` scales with fov so it feels the same when zoomed. */
export function dragLook(s: LookState, dx: number, dy: number, radPerPx: number): LookState {
  const lim = (85 * Math.PI) / 180;
  return {
    yaw: s.yaw + dx * radPerPx,
    pitch: Math.max(-lim, Math.min(lim, s.pitch + dy * radPerPx)),
  };
}

export class Gestures {
  /** When false, single-pointer drags do nothing (sensors drive the camera). */
  lookEnabled = false;
  private look: LookState = { yaw: 0, pitch: 0 };
  private pinchDist = 0;
  private drag: { x: number; y: number } | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly h: GestureHandlers,
    private readonly fov: () => number,
  ) {
    el.addEventListener('touchstart', this.onTouchStart, { passive: false });
    el.addEventListener('touchmove', this.onTouchMove, { passive: false });
    el.addEventListener('touchend', this.onTouchEnd);
    el.addEventListener('touchcancel', this.onTouchEnd);
    el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', () => (this.drag = null));
    el.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private radPerPx() {
    // Drag across the full screen height ≈ the vertical fov.
    return (this.fov() * Math.PI) / 180 / Math.max(1, this.el.clientHeight || window.innerHeight);
  }

  private moveBy(dx: number, dy: number) {
    if (!this.lookEnabled) return;
    // "Grab the world": dragging right turns the camera left.
    this.look = dragLook(this.look, dx, dy, this.radPerPx());
    this.h.look(lookQuaternion(this.look));
  }

  private onTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      this.pinchDist = touchDist(e.touches);
      this.drag = null;
      this.h.pinchStart();
    } else if (e.touches.length === 1) {
      const t = e.touches[0]!;
      this.beginDrag(t.clientX, t.clientY);
    }
  };

  private onTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && this.pinchDist > 0) {
      e.preventDefault();
      this.h.pinch(touchDist(e.touches) / this.pinchDist);
    } else if (e.touches.length === 1 && this.drag) {
      e.preventDefault();
      const t = e.touches[0]!;
      this.moveBy(t.clientX - this.drag.x, t.clientY - this.drag.y);
      this.drag = { x: t.clientX, y: t.clientY };
    }
  };

  private onTouchEnd = (e: TouchEvent) => {
    if (e.touches.length < 2) this.pinchDist = 0;
    if (e.touches.length === 0) this.drag = null;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    this.beginDrag(e.clientX, e.clientY);
  };

  private beginDrag(x: number, y: number) {
    this.drag = { x, y };
    if (this.lookEnabled) this.look = this.h.currentLook();
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.drag) return;
    this.moveBy(e.clientX - this.drag.x, e.clientY - this.drag.y);
    this.drag = { x: e.clientX, y: e.clientY };
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.h.wheel(e.deltaY);
  };
}

function touchDist(t: TouchList) {
  const a = t[0]!;
  const b = t[1]!;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1;
}
