// Rate limiter for the pose stream (pure).
import type { PhonePose } from '@shared/protocol';
// Sends at most `hz` per second; when nothing changed, still sends a keepalive every
// `keepaliveMs` so the laptop knows the phone is alive.

export class PoseThrottle {
  private last = -Infinity;
  private lastKey = '';
  private readonly minGapMs: number;

  constructor(
    hz = 30,
    private readonly keepaliveMs = 250,
  ) {
    // 2 ms tolerance so a 60 Hz rAF (16.7 ms frames) reliably yields every other frame.
    this.minGapMs = 1000 / hz - 2;
  }

  /** `key` summarizes the pose (rounded); identical keys are skipped until the keepalive. */
  shouldSend(now: number, key: string): boolean {
    const gap = now - this.last;
    if (gap < this.minGapMs) return false;
    if (key === this.lastKey && gap < this.keepaliveMs) return false;
    this.last = now;
    this.lastKey = key;
    return true;
  }
}

/** Compact change-detection key: ~0.001 rad / 1 mm / 0.1° / 0.01 aspect resolution. */
export function poseKey(
  p: Pick<PhonePose, 'q' | 'nudge' | 'offset' | 'fovDeg' | 'recording' | 'aspect'>,
) {
  const q = p.q.map((v) => Math.round(v * 2000)).join(',');
  const n = p.nudge.map((v) => Math.round(v * 1000)).join(',');
  const o = (p.offset ?? [0, 0, 0]).map((v) => Math.round(v * 1000)).join(',');
  return `${q}|${n}|${o}|${Math.round(p.fovDeg * 10)}|${Math.round((p.aspect ?? 0) * 100)}|${p.recording ? 1 : 0}`;
}
