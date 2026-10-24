// Laptop director entry (web/index.html).
import './style.css';
import { api } from '@shared/api';
import { getHealth } from './api';
import { installDebugHook } from './debug';
import { Director } from './director';
import { byId } from './dom';
import { mountHud } from './hud';
import { mountLookPanel } from './look-panel';
import { mountProjectsPanel } from './projects-panel';
import { mountPhoneSection, mountScenePanel } from './scene-panel';

const canvas = byId<HTMLCanvasElement>('viewport');
const stage = byId('stage');
const director = new Director(canvas);

const fit = () => {
  const r = stage.getBoundingClientRect();
  director.view.resize(r.width, r.height);
};
new ResizeObserver(fit).observe(stage);
fit();

mountHud(director);
mountScenePanel(director);
mountPhoneSection(director);
mountLookPanel(director);
mountProjectsPanel(director);
installDebugHook(director);
director.start();

getHealth()
  .then((hlt) => {
    const el = byId('health');
    el.textContent = hlt.mock ? 'MOCK' : 'LIVE';
    el.className = `badge ${hlt.mock ? '' : 'live'}`;
    el.title = Object.entries(hlt.keys)
      .map(([k, v]) => `${k}: ${v ? 'key set' : 'no key'}`)
      .join('\n');
  })
  .catch(() => {});

// Deep links: ?manifest=<url> opens a manifest directly; ?project=<id>&scene=<n> reopens a scene.
const q = new URLSearchParams(location.search);
const manifest = q.get('manifest');
const project = q.get('project');
const scene = Number(q.get('scene') ?? 0);
if (manifest) {
  const m = /\/projects\/([^/]+)\/scene-(\d+)\//.exec(manifest);
  void director.openScene(m?.[1] ?? 'adhoc', m ? Number(m[2]) : 0, manifest);
} else if (project && Number.isInteger(scene)) {
  void director.openScene(project, scene, api.manifest(project, scene));
}
