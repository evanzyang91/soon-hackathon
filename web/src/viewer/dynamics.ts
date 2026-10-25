// Moving props from ScenePlan.dynamics, driven purely by the scene clock so laptop and phone agree.
import * as THREE from 'three';
import type { DynamicElement, Vec3 } from '@shared/schema';
import { PathSampler, type PathSample } from './dynamics-path';
import { createElementProp } from './model-prop';
import type { Prop } from './props';

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
  /** Current world position of each element (for debugging / e2e). */
  positions(): { id: string; position: Vec3; phase: PathSample['phase'] }[];
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
      props[i]!.animate(s.distance, sceneTime);
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
        position: [i.object.position.x, i.object.position.y, i.object.position.z],
        phase: i.last?.phase ?? 'moving',
      })),
    dispose() {
      for (const p of props) p.dispose();
      group.removeFromParent();
    },
  };
}
