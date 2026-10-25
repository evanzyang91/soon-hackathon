// Laptop director entry (web/index.html): Script (the drawer) → Scene · Shots · Camera (the right
// panel's modes) → Export (the top bar); Tools (grade, re-prompt, objects, developer) in a drawer.
import './style.css';
import { api } from '@shared/api';
import { mountCameraPanel } from './camera-panel';
import { HttpChatApi, type ChatApi } from './chat-client';
import { createFakeChatApi } from './chat-fake';
import { mountChatPanel } from './chat-panel';
import { installDebugHook } from './debug';
import { Director } from './director';
import { byId } from './dom';
import { mountEditPanel } from './edit-panel';
import { mountExport } from './export';
import { mountGuideToggle, mountHud } from './hud';
import { mountIcons } from './icons';
import { mountLookPanel } from './look-panel';
import { mountManipulation } from './manipulate';
import { mountProjectsPanel } from './projects-panel';
import { mountSceneTab } from './scene-tab';
import { mountShell } from './shell';
import { mountShotsPanel, type ShotsPanel } from './shots-panel';
import { mountObjects, mountTools } from './tools';

// index.html asks for its icons by name (<span data-icon>)
mountIcons();

const canvas = byId<HTMLCanvasElement>('viewport');
const stage = byId('stage');
const director = new Director(canvas);

const fit = () => {
  const r = stage.getBoundingClientRect();
  director.view.resize(r.width, r.height);
};
new ResizeObserver(fit).observe(stage);
fit();

// ?fakechat=1: the project chat runs on an in-memory server (chat-fake.ts) — UI work and evidence
// without the chat routes; real projects stay listed and can be chatted with (nothing is sent)
const realChat = new HttpChatApi();
const chatApi: ChatApi = new URLSearchParams(location.search).has('fakechat') ? createFakeChatApi(realChat) : realChat;
const projects = mountProjectsPanel(director, { list: () => chatApi.listProjects() });
const chat = mountChatPanel(director, projects, chatApi);
mountHud(director, projects);

// Tools: the Look panel in Grade, the Edit panel in Re-prompt (their sections live in index.html)
const look = mountLookPanel(director, byId('tool-grade-body'));
mountEditPanel(byId('edit-panel'), director);
const tools = mountTools(director);
const shell = mountShell(director, { tools });

let shots: ShotsPanel | null = null;
const manip = mountManipulation(director, look, {
  toast: (t) => shell.toast(t),
  lookVisible: () => tools.lookVisible(),
  openReprompt: () => tools.open('reprompt'),
  goToShot: (id) => {
    shell.show('shots');
    shots?.select(id);
  },
});
shell.setUndo(manip);
shots = mountShotsPanel(director, manip, { toast: (t) => shell.toast(t), showMode: () => shell.show('shots') });
mountGuideToggle(shots);
mountSceneTab(director, { projects, look, manip, chat, shots });
mountCameraPanel(director);
mountObjects(director, look, manip);
mountExport(director, projects, shots, (t, ms) => shell.toast(t, ms));
installDebugHook(director);
director.start();

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
