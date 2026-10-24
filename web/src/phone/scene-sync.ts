// What the phone derives from the laptop's SceneState (pure).
import { lensLabel } from '@shared/lens';
import type { DropCamera, SceneState } from '@shared/protocol';
import type { SceneManifest, Vec3 } from '@shared/schema';
import { shotNumber } from '@shared/shots';
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

/** The laptop names its cameras after their shot: "1B · Two-shot". */
const NUMBERED = /^\d+[A-Z]+ · /;

/** A shot of the scene's list as the phone shows it (the camera popover, the label). */
export interface ShotEntry {
  id: string;
  /** "1B": scene number + the shot's place in the list. */
  number: string;
  /** "Two-shot", without the number; '' for one still called "Shot 1B". */
  name: string;
  /** "35 mm" */
  lens: string;
}

/** `SceneState.cameras` in order, numbered like the laptop's shot list. */
export function shotEntries(state: SceneState | null): ShotEntry[] {
  if (!state) return [];
  return state.cameras.map((c, i) => {
    const number = shotNumber(state.sceneIndex, i);
    const name = c.name.replace(NUMBERED, '').trim();
    return {
      id: c.id,
      number,
      name: name === `Shot ${number}` ? '' : name,
      lens: lensLabel(c.fovDeg),
    };
  });
}

/**
 * The HUD's one label: "1B · Two-shot · 35 mm" on a shot, "Handheld · 35 mm" off one. The lens is
 * the phone's own (`fovDeg`: the pinch lens), so it follows a pinch.
 */
export function shotLabel(state: SceneState | null, fovDeg: number): string {
  const lens = lensLabel(fovDeg);
  const shot = shotEntries(state).find((s) => s.id === state?.activeCameraId);
  return shot ? [shot.number, shot.name, lens].filter(Boolean).join(' · ') : `Handheld · ${lens}`;
}

/**
 * Whether the laptop is running the scene (clock playing and dialogue under way): what the
 * phone's play button shows as pause. A line has to have been spoken within `holdMs`, which
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
