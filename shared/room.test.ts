import { describe, expect, it } from 'vitest';
import { distanceToWalls, insidePolygon, signedArea, wallProximity, type Point2 } from './room.ts';

// a 4 m × 3 m room, counter-clockwise in x/z, from x -2..2 and z -2..1
const room: Point2[] = [
  [-2, -2],
  [-2, 1],
  [2, 1],
  [2, -2],
];

describe('room footprint', () => {
  it('area and winding', () => {
    expect(Math.abs(signedArea(room))).toBeCloseTo(12);
    expect(signedArea([...room].reverse())).toBeCloseTo(-signedArea(room));
  });

  it('inside / outside, including an L-shaped room', () => {
    expect(insidePolygon([0, 0], room)).toBe(true);
    expect(insidePolygon([3, 0], room)).toBe(false);
    const l: Point2[] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 3],
      [0, 3],
    ];
    expect(insidePolygon([0.5, 2], l)).toBe(true);
    expect(insidePolygon([2, 2], l)).toBe(false);
  });

  it('distance to the nearest wall', () => {
    expect(distanceToWalls([0, 0], room)).toBeCloseTo(1);
    expect(distanceToWalls([1.7, 0], room)).toBeCloseTo(0.3);
    expect(distanceToWalls([3, 0], room)).toBeCloseTo(1);
  });

  it('proximity: clear, near a wall, outside', () => {
    expect(wallProximity([0, -0.5], room)).toEqual({ kind: 'clear' });
    const near = wallProximity([1.7, 0], room);
    expect(near.kind).toBe('near');
    expect(wallProximity([2.4, 0], room).kind).toBe('outside');
    expect(
      wallProximity(
        [0, 0],
        [
          [0, 0],
          [1, 0],
        ],
      ),
    ).toEqual({ kind: 'clear' });
  });
});
