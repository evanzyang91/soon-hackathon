// Keeps dragged actors out of walls: the world's collider (placement.ts's triangle grid and body
// probes, the same test that corrects LLM blocking at load) decides whether a spot is free, and a
// drag slides up to the last free spot instead of passing through geometry. Without a collider
// every spot is free.
import type * as THREE from 'three';
import { colliderTriangles, hasFloor, spotBlocked, TriGrid, type Pose } from '../placement';
import { constrainMove, type V2 } from './math';

export class FloorGuard {
  private grid: TriGrid | null = null;
  private built: THREE.Object3D | null = null;

  /** Rebuilds the triangle grid when the collider changes (lazily: the first drag pays ~0.1 s). */
  private ensure(collider: THREE.Object3D | null) {
    if (collider === this.built) return;
    this.built = collider;
    this.grid = null;
    if (!collider) return;
    try {
      const tris = colliderTriangles(collider);
      if (tris.length) this.grid = new TriGrid(tris);
    } catch (err) {
      console.warn('[manipulate] collider unusable for drag constraints', err);
    }
  }

  free(collider: THREE.Object3D | null, x: number, z: number, pose: Pose = 'standing'): boolean {
    this.ensure(collider);
    if (!this.grid) return true;
    const local = this.grid.around(x, z);
    return hasFloor(local, x, z) && !spotBlocked(local, x, z, pose);
  }

  /** `to`, or the last free spot on the way there from `from`. */
  constrain(collider: THREE.Object3D | null, from: V2, to: V2, pose: Pose = 'standing'): V2 {
    this.ensure(collider);
    if (!this.grid) return to;
    return constrainMove(from, to, (x, z) => this.free(collider, x, z, pose));
  }
}
