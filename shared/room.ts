// Pure geometry on a scanned room footprint (RoomScan.outline: [x, z] metres, offset frame).
// Shared by the laptop (drawing the room) and the phone page (warning near real walls).
export type Point2 = readonly [number, number];

/** Shoelace area (m²) of a simple polygon; positive for counter-clockwise in x/z. */
export function signedArea(poly: readonly Point2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, z0] = poly[i]!;
    const [x1, z1] = poly[(i + 1) % poly.length]!;
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Even-odd ray cast: is p inside the polygon? */
export function insidePolygon(p: Point2, poly: readonly Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i]!;
    const [xj, zj] = poly[j]!;
    if (zi > p[1] !== zj > p[1] && p[0] < ((xj - xi) * (p[1] - zi)) / (zj - zi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Distance from p to the segment a–b. */
export function distanceToSegment(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len2 = dx * dx + dz * dz;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / len2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dz));
}

/** Distance from p to the nearest edge of the outline (its walls). */
export function distanceToWalls(p: Point2, poly: readonly Point2[]): number {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++)
    d = Math.min(d, distanceToSegment(p, poly[i]!, poly[(i + 1) % poly.length]!));
  return d;
}

export type WallProximity =
  { kind: 'clear' } | { kind: 'near'; meters: number } | { kind: 'outside'; meters: number };

/** What the phone shows for a position: near a wall (within `warnAt`), outside the room, or clear. */
export function wallProximity(p: Point2, poly: readonly Point2[], warnAt = 0.6): WallProximity {
  if (poly.length < 3) return { kind: 'clear' };
  const meters = distanceToWalls(p, poly);
  if (!insidePolygon(p, poly)) return { kind: 'outside', meters };
  return meters < warnAt ? { kind: 'near', meters } : { kind: 'clear' };
}
