import type * as THREE from 'three';
import { SparkRenderer } from '@sparkjsdev/spark';

/**
 * Splat renderer settings used for Marble worlds (same as Orbis `fourd-runtime.js`): Z-depth
 * sort, 0.3 px pre-blur, Gaussians cut at sqrt(5) std devs.
 */
export function createSpark(renderer: THREE.WebGLRenderer): SparkRenderer {
  return new SparkRenderer({
    renderer,
    preBlurAmount: 0.3,
    blurAmount: 0,
    sortRadial: false,
    maxStdDev: Math.sqrt(5),
  });
}
