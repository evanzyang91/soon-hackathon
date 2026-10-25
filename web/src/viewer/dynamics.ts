// Moving props from ScenePlan.dynamics, driven purely by the scene clock so laptop and phone agree.
import * as THREE from 'three';
import type { DynamicElement, Vec3 } from '@shared/schema';
import { PathSampler, type PathSample } from './dynamics-path';
import type { FoundInfo } from './found-model';
import { createElementProp } from './model-prop';
import type { Prop } from './props';

/** What an element's found model is doing (debug hook / e2e): absent without `element.model`. */
export function foundState(
  element: DynamicElement,
  object: THREE.Object3D,
): { model?: string; body?: string; clip?: string; loadMs?: number; reason?: string; rate?: number; parts?: string; facing?: string } {
  if (!element.model) return {};
  if (element.kind === 'model') return { model: String(object.userData.modelStatus ?? 'marker') };
  const f = object.userData.found as FoundInfo | undefined;
  if (!f) return {};
  return { model: f.status, body: f.body, clip: f.clip, loadMs: f.loadMs, reason: f.reason, rate: f.rate, parts: f.parts, facing: f.facing };
}

export interface DynamicInstance {
  element: DynamicElement;
  object: THREE.Group;
  sampler: PathSampler;
  last: PathSample | null;
}

export interface DynamicsRuntime {
  group: THREE.Group;
  items: DynamicInstance[];
  update(sceneTime: number): void;
  /** Current world position of each element (for debugging / e2e), and its found model's state. */
  positions(): ({ id: string; kind: string; position: Vec3; phase: PathSample['phase'] } & ReturnType<typeof foundState>)[];
  dispose(): void;
}

/** `resolve` turns a project-root relative file (a kind 'model' prop's .glb) into a URL. */
export function createDynamics(elements: DynamicElement[], resolve?: (file: string) => string): DynamicsRuntime {
  const group = new THREE.Group();
  group.name = 'dynamics';
  const props: Prop[] = [];
  const items: DynamicInstance[] = [];

  for (const element of elements) {
    try {
      const prop = createElementProp(element, resolve);
      prop.object.scale.setScalar(element.scale ?? 1);
      prop.object.userData.dynamicId = element.id;
      const sampler = new PathSampler(element.path, {
        speed: element.speed,
        loop: element.loop ?? true,
        pauseSeconds: element.pauseSeconds ?? 2,
      });
      group.add(prop.object);
      props.push(prop);
      items.push({ element, object: prop.object, sampler, last: null });
    } catch (err) {
      console.warn(`dynamic element ${element.id} skipped`, err);
    }
  }

  const update = (sceneTime: number) => {
    items.forEach((item, i) => {
      const s = item.sampler.sample(sceneTime);
      item.object.position.set(...s.position);
      item.object.rotation.y = s.heading;
      props[i]!.animate(s.distance, sceneTime, { phase: s.phase, since: s.since, speed: item.element.speed });
      item.last = s;
    });
  };
  update(0);

  return {
    group,
    items,
    update,
    positions: () =>
      items.map((i) => ({
        id: i.element.id,
        kind: i.element.kind,
        position: [i.object.position.x, i.object.position.y, i.object.position.z],
        phase: i.last?.phase ?? 'moving',
        ...foundState(i.element, i.object),
      })),
    dispose() {
      for (const p of props) p.dispose();
      group.removeFromParent();
    },
  };
}
