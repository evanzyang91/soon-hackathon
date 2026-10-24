// Pure protocol helpers for the laptop director (no DOM, no three.js) — unit tested.
import {
  ServerMessage,
  type DropCamera,
  type PhoneCommand,
  type PhonePose,
  type SceneState,
} from '@shared/protocol';
import type { Quat, Vec3 } from '@shared/schema';

/** Parses one relay frame; anything malformed or unknown is dropped (returns null). */
export function parseServerMessage(raw: unknown): ServerMessage | null {
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const r = ServerMessage.safeParse(data);
  return r.success ? r.data : null;
}

export interface DirectorSnapshot {
  projectId: string | null;
  sceneIndex: number | null;
  manifestUrl: string | null;
  time: number;
  playing: boolean;
  cameras: DropCamera[];
  activeCameraId: string | null;
  speakingLineId: string | null;
}

/** SceneState for the phone, or null while no scene is open. */
export function buildSceneState(s: DirectorSnapshot): SceneState | null {
  if (!s.projectId || s.sceneIndex == null || !s.manifestUrl) return null;
  const active = s.cameras.some((c) => c.id === s.activeCameraId) ? s.activeCameraId : null;
  return {
    type: 'scene',
    projectId: s.projectId,
    sceneIndex: s.sceneIndex,
    manifestUrl: s.manifestUrl,
    time: Math.round(s.time * 1000) / 1000,
    playing: s.playing,
    cameras: s.cameras.map((c) => ({ ...c })),
    activeCameraId: active,
    speakingLineId: s.speakingLineId,
  };
}

/** Change detection for "send on every change" — ignores the ticking clock. */
export function sceneStateKey(s: SceneState | null): string {
  if (!s) return '';
  const { time: _time, ...rest } = s;
  return JSON.stringify(rest);
}

export function normalizeQuat(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!Number.isFinite(n) || n < 1e-9) return [0, 0, 0, 1];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export interface CameraPose {
  position: Vec3;
  quaternion: Quat;
  fovDeg: number;
}

/**
 * Where the phone camera is in the world: the attached drop camera's position plus the phone's
 * joystick walk offset plus the handheld nudge; orientation comes straight from the phone
 * (already world frame after re-center). Drives the gizmo, the PiP and "View from phone".
 */
export function phoneCameraPose(pose: PhonePose, anchor: Vec3): CameraPose {
  const fov = Number.isFinite(pose.fovDeg) ? Math.min(120, Math.max(5, pose.fovDeg)) : 60;
  const o = pose.offset ?? [0, 0, 0];
  const n = pose.nudge;
  return {
    position: [anchor[0] + o[0] + n[0], anchor[1] + o[1] + n[1], anchor[2] + o[2] + n[2]],
    quaternion: normalizeQuat(pose.q),
    fovDeg: fov,
  };
}

/** The camera the phone is attached to: the active drop camera, else the scene's start camera. */
export function phoneAnchor(
  cameras: DropCamera[],
  activeCameraId: string | null,
  fallback: Vec3,
): Vec3 {
  return cameras.find((c) => c.id === activeCameraId)?.position ?? fallback;
}

export function cycleCamera(cameras: DropCamera[], activeId: string | null): string | null {
  if (!cameras.length) return null;
  const i = cameras.findIndex((c) => c.id === activeId);
  return cameras[(i + 1) % cameras.length]!.id;
}

export function nextCameraName(cameras: DropCamera[]): string {
  const used = new Set(cameras.map((c) => c.name));
  for (let n = cameras.length + 1; ; n++) if (!used.has(`Cam ${n}`)) return `Cam ${n}`;
}

export function phoneCommand(cmd: PhoneCommand['cmd']): PhoneCommand {
  return { type: 'cmd', cmd };
}

export interface PhoneLinkState {
  phones: number;
  lastPose: PhonePose | null;
  /** Local performance.now() when lastPose arrived. */
  lastPoseAt: number;
  /** Relay-stamped phoneId whose poses drive the gizmo + PiP (null until the first pose). */
  followId: string | null;
  /** Every phoneId seen since the room last had no phones, oldest first. */
  seen: string[];
}

export const initialPhoneLink = (): PhoneLinkState => ({
  phones: 0,
  lastPose: null,
  lastPoseAt: 0,
  followId: null,
  seen: [],
});

/** A followed phone that has been silent this long (it keepalives at 4 Hz) hands over. */
export const FOLLOW_STALE_MS = 1000;

/**
 * Which phone the laptop follows when several are paired: the most recently joined one (the
 * first pose from a phoneId not seen before takes over), falling back to whichever phone speaks
 * next once the followed one has been silent for FOLLOW_STALE_MS. Poses from other phones are
 * ignored meanwhile, so two streaming phones never make the gizmo flicker between them.
 */
export function followsPose(state: PhoneLinkState, pose: PhonePose, now: number): boolean {
  const id = pose.phoneId;
  if (!id || !state.followId || id === state.followId) return true; // unstamped: legacy relay
  if (!state.seen.includes(id)) return true;
  return now - state.lastPoseAt > FOLLOW_STALE_MS;
}

/** Folds an incoming relay message into the phone link state (pure reducer). */
export function reducePhoneLink(
  state: PhoneLinkState,
  msg: ServerMessage,
  now: number,
): PhoneLinkState {
  switch (msg.type) {
    case 'peers':
      return msg.phones > 0 ? { ...state, phones: msg.phones } : { ...initialPhoneLink() };
    case 'pose': {
      const id = msg.phoneId ?? null;
      const seen = id && !state.seen.includes(id) ? [...state.seen, id] : state.seen;
      if (!followsPose(state, msg, now)) return seen === state.seen ? state : { ...state, seen };
      return {
        ...state,
        phones: Math.max(1, state.phones),
        lastPose: msg,
        lastPoseAt: now,
        followId: id,
        seen,
      };
    }
    default:
      return state;
  }
}

/** Phone render aspect (width / height) from its pose, clamped; 16:9 when it does not say. */
export function poseAspect(pose: PhonePose | null, fallback = 16 / 9): number {
  const a = pose?.aspect;
  return a && Number.isFinite(a) ? Math.min(3, Math.max(0.4, a)) : fallback;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the PiP goes on a `width` x `height` canvas: bottom-right, `aspect` shaped, inside a box
 * about 28% of the canvas wide (200–480 px) and at most 40% of it tall.
 */
export function pipRectFor(width: number, height: number, aspect = 16 / 9): Rect {
  const a = Math.min(3, Math.max(0.4, aspect));
  const maxW = Math.min(Math.max(width * 0.28, 200), 480, width - 24);
  const maxH = Math.max(40, Math.min(height * 0.4, (maxW / (16 / 9)) * 1.6));
  let w = maxW;
  let h = w / a;
  if (h > maxH) {
    h = maxH;
    w = h * a;
  }
  w = Math.round(w);
  h = Math.round(h);
  return { x: width - w - 12, y: height - h - 12, width: w, height: h };
}

export function poseIsFresh(state: PhoneLinkState, now: number, maxAgeMs = 3000): boolean {
  return !!state.lastPose && now - state.lastPoseAt <= maxAgeMs;
}
