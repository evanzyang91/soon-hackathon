// 2D "viewfinder" shown when there is no 3D view (no scene yet, WebGL unavailable or failed).
// Pose streaming never depends on it; it just proves the sensors work: artificial horizon,
// heading tape and the raw numbers.
import { Euler, Quaternion } from 'three';
import type { Quat, Vec3 } from '@shared/schema';
import { focalLabel } from './fov.ts';

const RAD = 180 / Math.PI;
/** Heading tape sits below the HUD's top row of pills. */
const TAPE_TOP = 52;
const TAPE_H = 34;

export interface Attitude {
  /** Compass-style heading, 0–360, clockwise from −Z. */
  headingDeg: number;
  /** + looks up. */
  pitchDeg: number;
  /** + = camera rolled counter-clockwise (horizon appears rotated clockwise). */
  rollDeg: number;
}

export function attitudeOf(q: Quat | Quaternion): Attitude {
  const qq = Array.isArray(q) ? new Quaternion(q[0], q[1], q[2], q[3]) : q;
  const e = new Euler().setFromQuaternion(qq, 'YXZ');
  return {
    headingDeg: (((-e.y * RAD) % 360) + 360) % 360,
    pitchDeg: e.x * RAD,
    rollDeg: e.z * RAD,
  };
}

export interface ViewfinderState {
  q: Quat;
  fovDeg: number;
  nudge: Vec3;
  /** Shown centered, e.g. why 3D is unavailable. */
  note: string;
}

export function drawViewfinder(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: ViewfinderState,
) {
  const a = attitudeOf(s.q);
  const cx = w / 2;
  const cy = h / 2;
  const fPx = h / 2 / Math.tan((s.fovDeg * Math.PI) / 360);
  const hfovDeg = 2 * Math.atan(w / 2 / fPx) * RAD;

  // Sky / ground split by the horizon.
  ctx.save();
  ctx.fillStyle = '#10161f';
  ctx.fillRect(0, 0, w, h);
  ctx.translate(cx, cy);
  ctx.rotate((a.rollDeg * Math.PI) / 180);
  const pitchRad = (Math.max(-89, Math.min(89, a.pitchDeg)) * Math.PI) / 180;
  const horizonY = Math.tan(pitchRad) * fPx;
  const big = Math.hypot(w, h) * 2;
  ctx.fillStyle = '#1c2a3c';
  ctx.fillRect(-big, -big, 2 * big, big + horizonY);
  ctx.fillStyle = '#2b2620';
  ctx.fillRect(-big, horizonY, 2 * big, big);
  ctx.strokeStyle = '#ffcf5a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-big, horizonY);
  ctx.lineTo(big, horizonY);
  ctx.stroke();
  // Pitch ladder every 10°.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '11px ui-monospace, Menlo, monospace';
  ctx.lineWidth = 1;
  for (let p = -80; p <= 80; p += 10) {
    if (p === 0) continue;
    const y = Math.tan(pitchRad - (p * Math.PI) / 180) * fPx;
    if (Math.abs(y) > h) continue;
    const half = p % 30 === 0 ? 60 : 30;
    ctx.beginPath();
    ctx.moveTo(-half, y);
    ctx.lineTo(half, y);
    ctx.stroke();
    ctx.fillText(`${p}`, half + 6, y + 4);
  }
  ctx.restore();

  // Heading tape.
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(0, TAPE_TOP, w, TAPE_H);
  ctx.strokeStyle = '#fff';
  ctx.fillStyle = '#fff';
  ctx.font = '12px ui-monospace, Menlo, monospace';
  ctx.textAlign = 'center';
  const pxPerDeg = w / hfovDeg;
  const bottom = TAPE_TOP + TAPE_H;
  const start = Math.floor((a.headingDeg - hfovDeg / 2) / 5) * 5;
  for (let d = start; d <= a.headingDeg + hfovDeg / 2; d += 5) {
    const x = cx + (d - a.headingDeg) * pxPerDeg;
    const major = d % 30 === 0;
    ctx.beginPath();
    ctx.moveTo(x, bottom);
    ctx.lineTo(x, bottom - (major ? 14 : 7));
    ctx.stroke();
    if (major) ctx.fillText(`${((d % 360) + 360) % 360}`, x, TAPE_TOP + 15);
  }
  ctx.fillStyle = '#ffcf5a';
  ctx.beginPath();
  ctx.moveTo(cx - 6, bottom);
  ctx.lineTo(cx + 6, bottom);
  ctx.lineTo(cx, bottom - 8);
  ctx.fill();
  ctx.restore();

  // Frame guides: thirds + center cross.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.beginPath();
  for (const f of [1 / 3, 2 / 3]) {
    ctx.moveTo(w * f, 0);
    ctx.lineTo(w * f, h);
    ctx.moveTo(0, h * f);
    ctx.lineTo(w, h * f);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.8)';
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx, cy + 12);
  ctx.stroke();
  // Handheld nudge as an offset dot (1 px per mm, x/y screen-ish).
  ctx.fillStyle = '#5ad1ff';
  ctx.beginPath();
  ctx.arc(cx + s.nudge[0] * 1000, cy - s.nudge[1] * 1000, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Numbers + note, under the heading tape.
  ctx.save();
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(cx - 200, bottom + 6, 400, s.note ? 40 : 22);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = '13px ui-monospace, Menlo, monospace';
  const nums = `HDG ${a.headingDeg.toFixed(0).padStart(3, '0')}°  TILT ${a.pitchDeg.toFixed(1)}°  ROLL ${a.rollDeg.toFixed(1)}°  ${focalLabel(s.fovDeg)}`;
  ctx.fillText(nums, cx, bottom + 22);
  if (s.note) {
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(s.note, cx, bottom + 40);
  }
  ctx.restore();
}
