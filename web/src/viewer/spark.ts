import type * as THREE from 'three';
import { SparkRenderer, type SparkRendererOptions } from '@sparkjsdev/spark';

/** Per-caller overrides of the defaults below (e.g. the phone's cheaper mobile settings). */
export type SparkOptions = Partial<Omit<SparkRendererOptions, 'renderer'>>;

/**
 * Splat renderer settings used for Marble worlds: Z-depth
 * sort, 0.3 px pre-blur, Gaussians cut at sqrt(5) std devs. `overrides` win.
 */
export function createSpark(
  renderer: THREE.WebGLRenderer,
  overrides: SparkOptions = {},
): SparkRenderer {
  return new SparkRenderer({
    preBlurAmount: 0.3,
    blurAmount: 0,
    sortRadial: false,
    maxStdDev: Math.sqrt(5),
    ...overrides,
    renderer,
  });
}
