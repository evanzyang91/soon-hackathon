// Field of view ↔ focal length, pinch zoom (pure math).
// fovDeg is three.js PerspectiveCamera.fov (vertical). Focal lengths are full-frame equivalents
// against the 24 mm frame height of a 36×24 mm sensor.

export const FOV_MIN = 24;
export const FOV_MAX = 90;
export const DEFAULT_FOV = 50;
const FRAME_HEIGHT_MM = 24;
const DEG = Math.PI / 180;

export const clampFov = (fov: number) => Math.min(FOV_MAX, Math.max(FOV_MIN, fov));

export function fovToFocalMm(fovDeg: number): number {
  return FRAME_HEIGHT_MM / 2 / Math.tan((fovDeg * DEG) / 2);
}

export function focalMmToFov(mm: number): number {
  return (2 * Math.atan(FRAME_HEIGHT_MM / 2 / mm)) / DEG;
}

/** "35mm" */
export function focalLabel(fovDeg: number): string {
  return `${Math.round(fovToFocalMm(fovDeg))}mm`;
}

/**
 * Pinch zoom: `scale` = current finger distance / distance at pinch start. Spreading (scale > 1)
 * zooms in. Works in tan space so equal pinch ratios feel like equal focal-length ratios.
 */
export function pinchFov(startFovDeg: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return clampFov(startFovDeg);
  const t = Math.tan((startFovDeg * DEG) / 2) / scale;
  return clampFov((2 * Math.atan(t)) / DEG);
}
