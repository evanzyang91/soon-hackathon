// Director fly camera: WASD + QE, Shift = fast, right-drag, left-drag on empty space or
// pointer-lock (double-click) to look, wheel = field of view. Orientation is kept as YXZ Euler so
// roll from a dropped camera survives. A left press that `claimLeft` claims (an object or handle
// under the pointer: viewer/manipulate) is not a look; a left drag that looked swallows its click,
// so click tools (select, pick focus) do not fire at the end of a look.
import * as THREE from 'three';
import { isTyping } from './dom';

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'] as const;
const PITCH_LIMIT = THREE.MathUtils.degToRad(89);
/** A left press becomes a look after moving this far (px); shorter is a click. */
const LEFT_DRAG_PX = 4;

interface Flight {
  from: THREE.Vector3;
  to: THREE.Vector3;
  qFrom: THREE.Quaternion;
  qTo: THREE.Quaternion;
  fovFrom: number;
  fovTo: number;
  t: number;
  seconds: number;
}

export class FlyControls {
  speed = 2;
  fastMultiplier = 4;
  lookSensitivity = 0.0025;
  enabled = true;
  onChange: (() => void) | null = null;
  /** True when a left press belongs to someone else (the manipulator's objects and handles). */
  claimLeft: ((e: PointerEvent | MouseEvent) => boolean) | null = null;
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly down = new Set<string>();
  private dragging = false;
  /** Button that started the look drag (0 left, 2 right). */
  private dragButton = -1;
  private leftArmed: { id: number; x: number; y: number } | null = null;
  private swallowClick = false;
  private flight: Flight | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    readonly dom: HTMLElement,
  ) {
    this.syncFromCamera();
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement | Document,
      type: K,
      fn: (e: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(window, 'keydown', (e) => {
      if (!this.enabled || isTyping(e.target) || e.metaKey || e.ctrlKey) return;
      if ((KEYS as readonly string[]).includes(e.code)) {
        this.down.add(e.code);
        this.flight = null;
      }
    });
    on(window, 'keyup', (e) => this.down.delete(e.code));
    on(window, 'blur', () => this.down.clear());
    on(dom, 'contextmenu', (e) => e.preventDefault());
    on(dom, 'pointerdown', (e) => {
      this.swallowClick = false;
      if (!this.enabled) return;
      if (e.button === 2) {
        this.dragging = true;
        this.dragButton = 2;
        dom.setPointerCapture(e.pointerId);
      } else if (e.button === 0 && !e.altKey && !this.claimLeft?.(e)) {
        this.leftArmed = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    });
    on(dom, 'pointerup', (e) => {
      if (e.button === 0) {
        if (this.dragButton === 0) {
          this.dragging = false;
          this.dragButton = -1;
          this.swallowClick = true;
        }
        this.leftArmed = null;
      } else if (e.button === 2 && this.dragButton === 2) {
        this.dragging = false;
        this.dragButton = -1;
      } else return;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });
    on(dom, 'pointercancel', () => {
      this.dragging = false;
      this.dragButton = -1;
      this.leftArmed = null;
    });
    on(dom, 'pointermove', (e) => {
      const arm = this.leftArmed;
      if (arm && !this.dragging) {
        if (!(e.buttons & 1)) {
          this.leftArmed = null;
          return;
        }
        if (Math.hypot(e.clientX - arm.x, e.clientY - arm.y) < LEFT_DRAG_PX) return;
        this.dragging = true;
        this.dragButton = 0;
        try {
          dom.setPointerCapture(arm.id);
        } catch {
          // the pointer is gone; the drag still looks while it lasts
        }
      }
      if (this.dragging || document.pointerLockElement === dom) this.look(e.movementX, e.movementY);
    });
    // the click that ends a left look-drag is not a click (capture on window: before any tool)
    on(
      window,
      'click',
      (e) => {
        if (!this.swallowClick || e.target !== dom) return;
        this.swallowClick = false;
        e.stopPropagation();
        e.preventDefault();
      },
      { capture: true },
    );
    on(dom, 'dblclick', (e) => {
      // a double-click on an object is the manipulator's, not mouselook
      if (this.claimLeft?.(e)) return;
      // the promise rejects if the user dismisses the lock; that is not an error worth logging
      if (this.enabled && document.pointerLockElement !== dom)
        Promise.resolve(dom.requestPointerLock?.()).catch(() => {});
    });
    on(
      dom,
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.setFov(this.camera.fov + e.deltaY * 0.02);
      },
      { passive: false },
    );
  }

  syncFromCamera() {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
  }

  setFov(fov: number) {
    this.camera.fov = THREE.MathUtils.clamp(fov, 12, 110);
    this.camera.updateProjectionMatrix();
    this.onChange?.();
  }

  /** Jump (seconds = 0) or glide to a pose. */
  flyTo(
    position: THREE.Vector3Like,
    quaternion: THREE.QuaternionLike,
    fov?: number,
    seconds = 0.6,
  ) {
    const to = new THREE.Vector3(position.x, position.y, position.z);
    const qTo = new THREE.Quaternion(
      quaternion.x,
      quaternion.y,
      quaternion.z,
      quaternion.w,
    ).normalize();
    const fovTo = fov ?? this.camera.fov;
    if (seconds <= 0) {
      this.camera.position.copy(to);
      this.camera.quaternion.copy(qTo);
      this.camera.fov = fovTo;
      this.camera.updateProjectionMatrix();
      this.syncFromCamera();
      this.flight = null;
      this.onChange?.();
      return;
    }
    this.flight = {
      from: this.camera.position.clone(),
      to,
      qFrom: this.camera.quaternion.clone(),
      qTo,
      fovFrom: this.camera.fov,
      fovTo,
      t: 0,
      seconds,
    };
  }

  update(dt: number) {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.seconds);
      const k = f.t * f.t * (3 - 2 * f.t);
      this.camera.position.lerpVectors(f.from, f.to, k);
      this.camera.quaternion.slerpQuaternions(f.qFrom, f.qTo, k);
      this.camera.fov = THREE.MathUtils.lerp(f.fovFrom, f.fovTo, k);
      this.camera.updateProjectionMatrix();
      if (f.t >= 1) {
        this.flight = null;
        this.syncFromCamera();
      }
      this.onChange?.();
      return;
    }
    if (!this.enabled || this.down.size === 0) return;
    const fast = this.down.has('ShiftLeft') || this.down.has('ShiftRight');
    const v = this.speed * (fast ? this.fastMultiplier : 1) * dt;
    const move = new THREE.Vector3(
      (this.down.has('KeyD') ? 1 : 0) - (this.down.has('KeyA') ? 1 : 0),
      0,
      (this.down.has('KeyS') ? 1 : 0) - (this.down.has('KeyW') ? 1 : 0),
    );
    move.applyQuaternion(this.camera.quaternion);
    move.y += (this.down.has('KeyE') ? 1 : 0) - (this.down.has('KeyQ') ? 1 : 0);
    if (move.lengthSq() === 0) return;
    this.camera.position.addScaledVector(move.normalize(), v);
    this.onChange?.();
  }

  private look(dx: number, dy: number) {
    if (!this.enabled) return;
    this.flight = null;
    // slower look when zoomed in, so framing a tight shot stays controllable
    const k = this.lookSensitivity * (this.camera.fov / 60);
    this.euler.y -= dx * k;
    this.euler.x = THREE.MathUtils.clamp(this.euler.x - dy * k, -PITCH_LIMIT, PITCH_LIMIT);
    this.camera.quaternion.setFromEuler(this.euler);
    this.onChange?.();
  }

  dispose() {
    for (const c of this.cleanup) c();
  }
}
