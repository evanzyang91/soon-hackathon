// Laptop director entry (web/index.html).
import './style.css';
import { api } from '@shared/api';
import { getHealth } from './api';
import { installDebugHook } from './debug';
import { Director } from './director';
import { byId } from './dom';
import { mountHud } from './hud';
import * as editPanel from './edit-panel';
import { mountLookPanel } from './look-panel';
import { mountManipulation } from './manipulate';
import { mountProjectsPanel } from './projects-panel';
import { mountPhoneSection, mountScenePanel } from './scene-panel';
import { mountSceneTab } from './scene-tab';
import { mountShell } from './shell';

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
const look = mountLookPanel(director);
// WP G's Edit tab: `mountEditPanel(director)` today (it adds its own section to #right); the
// shell's contract is `mountEditPanel(el, director)` filling `el` — both are accepted
const edit = (() => {
  const mount = (editPanel as { mountEditPanel?: (...a: unknown[]) => unknown }).mountEditPanel;
  if (!mount) return false;
  try {
    if (mount.length >= 2) {
      const el = document.createElement('section');
      el.className = 'card grow edit-panel';
      el.id = 'edit-panel';
      el.dataset.testid = 'edit-panel';
      byId('right').append(el);
      mount(el, director);
    } else mount(director);
    return true;
  } catch (err) {
    console.warn('edit panel failed to mount', err);
    return false;
  }
})();
const projects = mountProjectsPanel(director);
// the four tabs, drawer, top bar, cheatsheet and tour (after the panels made their sections)
const shell = mountShell(director, { edit });
const manip = mountManipulation(director, look, {
  toast: (t) => shell.toast(t),
  lookVisible: () => shell.lookVisible(),
  showTab: (t) => shell.show(t),
});
shell.setUndo(manip);
mountSceneTab(director, projects, look, manip);
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
