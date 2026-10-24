// What the phone derives from the laptop's SceneState (pure).
import type { DropCamera, SceneState } from '@shared/protocol';
import type { SceneManifest, Vec3 } from '@shared/schema';
import { yawOf } from './sensors.ts';

export function activeCamera(state: SceneState | null): DropCamera | null {
  if (!state?.activeCameraId) return null;
  return state.cameras.find((c) => c.id === state.activeCameraId) ?? null;
}

export interface Anchor {
  /** Where the phone camera sits (before the handheld nudge). */
  position: Vec3;
  /** Heading the phone maps to on recenter. */
  yaw: number;
  fovDeg: number;
  name: string;
  /** Changes whenever the phone should re-center (camera switched / first scene). */
  key: string;
}

const DEFAULT_ANCHOR: Anchor = {
  position: [0, 1.6, 0],
  yaw: 0,
  fovDeg: 50,
  name: 'No camera',
  key: 'none',
};

/** Active drop camera → else the manifest's start camera → else a standing eye height at origin. */
export function anchorFor(state: SceneState | null, manifest: SceneManifest | null): Anchor {
  const cam = activeCamera(state);
  if (cam) {
    return {
      position: cam.position,
      yaw: yawOf(cam.quaternion),
      fovDeg: cam.fovDeg,
      name: cam.name,
      key: `cam:${cam.id}`,
    };
  }
  if (manifest) {
    const s = manifest.startCamera;
    return {
      position: s.position,
      yaw: yawOf(s.quaternion),
      fovDeg: s.fovDeg,
      name: 'Start camera',
      key: `start:${manifest.projectId}:${manifest.plan.index}`,
    };
  }
  return DEFAULT_ANCHOR;
}

export interface Caption {
  speaker: string;
  text: string;
}

export function captionFor(manifest: SceneManifest | null, lineId: string | null): Caption | null {
  if (!manifest || !lineId) return null;
  const line = manifest.plan.dialogue.find((l) => l.id === lineId);
  if (!line) return null;
  const who = manifest.characters.find((c) => c.id === line.characterId);
  return { speaker: who?.name ?? line.characterId.toUpperCase(), text: line.text };
}

/**
 * Whether the laptop is running the scene (clock playing and dialogue under way): what the
 * phone's ACTION button shows as CUT. A line has to have been spoken within `holdMs`, which
 * bridges the short pause the laptop leaves between lines.
 */
export class DialogueActivity {
  private lastSpeakingAt = -Infinity;

  constructor(private readonly holdMs = 1200) {}

  update(state: SceneState, nowMs: number): void {
    if (state.speakingLineId) this.lastSpeakingAt = nowMs;
  }

  running(state: SceneState | null, nowMs: number): boolean {
    if (!state?.playing) return false;
    return !!state.speakingLineId || nowMs - this.lastSpeakingAt < this.holdMs;
  }

  reset(): void {
    this.lastSpeakingAt = -Infinity;
  }
}

/** Extrapolates the laptop's scene clock between SceneState messages. */
export class SceneClockTracker {
  private base = 0;
  private at = 0;
  private playing = false;

  update(state: SceneState, nowMs: number): void {
    this.base = state.time;
    this.at = nowMs;
    this.playing = state.playing;
  }

  time(nowMs: number): number {
    return this.playing ? this.base + Math.max(0, nowMs - this.at) / 1000 : this.base;
  }

  get isPlaying(): boolean {
    return this.playing;
  }
}
