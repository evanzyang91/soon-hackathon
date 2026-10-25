// What server/pipeline/calibrate-render.ts asks the scale harness (scale-harness.ts) to draw.
// Types only, shared by the Node side and the browser page.
import type { Look } from '@shared/look';

export interface ScaleWorld {
  /** URL of the SPZ (served by the render server). */
  spz: string;
  collider?: string;
  metricScaleFactor: number;
  groundPlaneOffset: number;
  opencvFrame?: boolean;
  background?: string;
}

export interface ScaleFigure {
  /** World metres AFTER the shot's factor is applied. */
  x: number;
  z: number;
  /** Feet height (default 0 = the viewer's floor). */
  y?: number;
  /** rotation.y; 0 faces -Z. Default: face the camera. */
  yaw?: number;
  /** Text over the head (default "1.70 m"). */
  label?: string;
  tint?: string;
  /** default standing; sitting lowers the hips onto a seat ~0.45 m up (feet stay at y) */
  pose?: 'standing' | 'sitting';
  /** Standing height of the mannequin (default 1.70 m), scaled like a character's actor. */
  heightMeters?: number;
}

/**
 * A labelled ring lying on the ground, drawn over the finished render (2D, always on top, fixed
 * label size at any depth): the staging step's candidate marks (server/pipeline/staging.ts).
 * Whether the spot is actually visible is the caller's business (collider line of sight).
 */
export interface ScaleMark {
  /** World metres after the shot's factor; y is the ground height at the spot. */
  x: number;
  y: number;
  z: number;
  label: string;
  /** css colour of the ring and the label background (default #ffd23f) */
  color?: string;
  /** ring radius on the ground, m (default 0.14) */
  radius?: number;
}

export interface ScaleShot {
  /** Calibration factor on top of Marble's metric scale (1 = Marble as delivered). */
  factor: number;
  /** yaw 0 looks down -Z (rotation.y, + turns left); fovDeg is the HORIZONTAL field of view. */
  camera: { position: [number, number, number]; yawDeg: number; pitchDeg: number; fovDeg: number };
  figures: ScaleFigure[];
  width: number;
  height: number;
  /** A 2 m pole with 0.5 m bands next to each figure. */
  ruler?: boolean;
  showCollider?: boolean;
  /** Labelled ground rings drawn over the render (see ScaleMark). */
  marks?: ScaleMark[];
  /** default png; jpeg (q 0.9) keeps vision requests small */
  format?: 'png' | 'jpeg';
  /**
   * Grade the frame with this look exactly as the laptop does: the scene's SceneLook (splat fog,
   * sky tint, lights on splats and mannequins) and the look post pass (grade, LUT, film). Absent =
   * the raw frame, as before.
   */
  look?: Look;
}

export interface ScalePanel {
  /** PNG data URL from render(). */
  image: string;
  title: string;
  subtitle?: string;
}

export interface ComposeOptions {
  /** Panels per row (default: all in one row). A grid uses smaller titles sized to the panels. */
  columns?: number;
  /** A heading line over the whole sheet. */
  heading?: string;
}

export interface ScaleHarness {
  load(world: ScaleWorld): Promise<{ splats: number }>;
  render(shot: ScaleShot): Promise<string>;
  /** Panels side by side (or in rows of `columns`) with a title strip each and footer lines under all of them. */
  compose(panels: ScalePanel[], footer: string[], opts?: ComposeOptions): Promise<string>;
}
