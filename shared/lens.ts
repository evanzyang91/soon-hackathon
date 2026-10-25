// Lens ↔ field of view. The app stores a vertical FOV (three.js cameras); filmmakers read a lens.
// Full-frame 35 mm equivalent: sensor height 24 mm, so f = 12 / tan(vfov / 2). The UI shows the
// nearest common prime; the stored FOV is never rounded.

const SENSOR_HEIGHT_MM = 24;

/** Common primes, as a director would call them. */
export const LENS_STOPS_MM = [14, 18, 21, 24, 28, 35, 40, 50, 65, 85, 100, 135, 200] as const;

/** Exact 35 mm-equivalent focal length for a vertical FOV in degrees. */
export function lensMm(fovDeg: number): number {
  const half = (Math.max(1, Math.min(179, fovDeg)) * Math.PI) / 360;
  return SENSOR_HEIGHT_MM / 2 / Math.tan(half);
}

/** Vertical FOV in degrees for a 35 mm-equivalent focal length. */
export function fovDegForLens(mm: number): number {
  return (2 * Math.atan(SENSOR_HEIGHT_MM / 2 / Math.max(1, mm)) * 180) / Math.PI;
}

/** The nearest common prime (by ratio) to a FOV: 50° is 25.7 mm, shown as 24 mm; 30° is 44.8 mm, shown as 50 mm. */
export function nearestLensMm(fovDeg: number): number {
  const mm = lensMm(fovDeg);
  let best: number = LENS_STOPS_MM[0];
  for (const s of LENS_STOPS_MM) if (Math.abs(Math.log(s / mm)) < Math.abs(Math.log(best / mm))) best = s;
  return best;
}

/** "35 mm" for the UI. */
export function lensLabel(fovDeg: number): string {
  return `${nearestLensMm(fovDeg)} mm`;
}
