// Lens: Look.dof → Spark's depth of field (SparkRenderer.focalDistance / apertureAngle).
//
// Spark blurs each splat by  focusBlur · focalPx · tan(apertureAngle / 2)  pixels, where
// focusBlur = |z − focalDistance| / z. A thin lens gives a circle of confusion (radius, in pixels)
// of  (A / 2s) · focalPx · |z − s| / z  for aperture diameter A = f / N and focus distance s ≫ f,
// so apertureAngle = 2 · atan(A / 2s): the angle the aperture subtends from the focus point.
import type { Look } from '@shared/look';

/** Full-frame frame height (mm) the focal length is measured against (same as phone/fov.ts). */
export const FRAME_HEIGHT_MM = 24;
export const FOCUS_MIN_M = 0.2;
export const FOCUS_MAX_M = 200;
/** Spark's blur is a Gaussian std-dev, not a CoC radius; this makes it read like a real lens. */
const BLUR_SCALE = 1.6;
/** Beyond this the splat blur is no longer a lens look (and costs fill rate). */
export const MAX_APERTURE_RAD = 0.08;

export const focalLengthMm = (fovDeg: number) =>
  FRAME_HEIGHT_MM / 2 / Math.tan(((Math.min(170, Math.max(1, fovDeg)) * Math.PI) / 180) / 2);

export const clampFocus = (m: number) =>
  Math.min(FOCUS_MAX_M, Math.max(FOCUS_MIN_M, Number.isFinite(m) ? m : 3));

/** Spark aperture angle (radians, full width) for an f-stop at a focal length and focus distance. */
export function apertureAngle(fStop: number, focalMm: number, focusM: number): number {
  const n = Math.min(22, Math.max(0.95, fStop));
  const diameterM = focalMm / n / 1000;
  const s = clampFocus(focusM);
  return Math.min(MAX_APERTURE_RAD, 2 * Math.atan((diameterM * BLUR_SCALE) / (2 * s)));
}

export interface SparkLens {
  focalDistance: number;
  apertureAngle: number;
}

/** What to set on the SparkRenderer for this view (both 0 = DOF off). */
export function sparkLens(dof: Look['dof'] | undefined, fovDeg: number): SparkLens {
  if (!dof?.enabled) return { focalDistance: 0, apertureAngle: 0 };
  const focus = clampFocus(dof.focusDistance);
  return { focalDistance: focus, apertureAngle: apertureAngle(dof.fStop, focalLengthMm(fovDeg), focus) };
}

/** Depth along the camera's view axis of a world point (what Spark's focalDistance measures). */
export function viewDepth(
  cameraPos: [number, number, number],
  forward: [number, number, number],
  point: [number, number, number],
): number {
  return (
    (point[0] - cameraPos[0]) * forward[0] +
    (point[1] - cameraPos[1]) * forward[1] +
    (point[2] - cameraPos[2]) * forward[2]
  );
}
