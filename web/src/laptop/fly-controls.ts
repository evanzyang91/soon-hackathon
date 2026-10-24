// Director fly camera: WASD + QE, Shift = fast, right-drag or pointer-lock (double-click) to look,
// wheel = field of view. Orientation is kept as YXZ Euler so roll from a dropped camera survives.
import * as THREE from 'three';
import { isTyping } from './dom';

const KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'] as const;
const PITCH_LIMIT = THREE.MathUtils.degToRad(89);

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
  private readonly euler = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly down = new Set<string>();
  private dragging = false;
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
      if (!this.enabled || e.button !== 2) return;
      this.dragging = true;
      dom.setPointerCapture(e.pointerId);
    });
    on(dom, 'pointerup', (e) => {
      if (e.button !== 2) return;
      this.dragging = false;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    });
    on(dom, 'pointermove', (e) => {
      if (this.dragging || document.pointerLockElement === dom) this.look(e.movementX, e.movementY);
    });
    on(dom, 'dblclick', () => {
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
