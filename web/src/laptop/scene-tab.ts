// Right panel "Scene" tab: the open project's scenes (switch scene), the world (splat quality,
// provider, measured scale and floor offset), the cast (build detail + the High detail rebuild
// button, select / reset to blocking) and an outliner of what can be grabbed in the viewport
// (props, lights, dropped cameras: click to select, × to delete — the same undoable actions as
// the viewport's toolbar).
import { api } from '@shared/api';
import { effectiveProps } from '../viewer/edits/model';
import { isPropRemoved } from '../viewer/manipulate/edits';
import { actorHeight } from '../viewer/actors';
import { floorOffset } from '../viewer/transform';
import type { Director } from './director';
import { byId, h } from './dom';
import { scaleHeadline } from './hud';
import type { LookPanel } from './look-panel';
import type { Manipulation } from './manipulate';
import { sceneReady, type ProjectsPanel } from './projects-panel';
import { characterPhoto, projectPlan } from './references';

type Ref = NonNullable<Director['selection']>;

export function mountSceneTab(director: Director, projects: ProjectsPanel, look: LookPanel, manip: Manipulation) {
  const scenes = byId('st-scenes');
  const world = byId('st-world');
  const worldKind = byId('st-world-kind');
  const cast = byId('st-cast');
  const objects = byId('st-objects');

  const selected = (r: Ref) => director.selection?.type === r.type && director.selection.id === r.id;
  const selectBtn = (r: Ref, title: string) =>
    h(
      'button',
      {
        type: 'button',
        class: `small${selected(r) ? ' on' : ''}`,
        title,
        'data-testid': `select-${r.type}`,
        onclick: () => director.select(selected(r) ? null : r),
      },
      selected(r) ? 'Selected' : 'Select',
    );

  const renderScenes = () => {
    const p = projects.current();
    scenes.replaceChildren();
    if (!director.runtime && !p) {
      scenes.append(h('div', { class: 'muted small' }, 'Open a scene from the projects drawer (☰).'));
      return;
    }
    const title = p?.title || director.runtime?.manifest.plan.slug || '';
    scenes.append(h('div', { class: 'st-project' }, h('b', {}, title), p?.mock ? h('span', { class: 'badge' }, 'MOCK') : null));
    for (const job of p?.scenes ?? []) {
      const ready = sceneReady(job);
      const current = director.projectId === p!.id && director.sceneIndex === job.sceneIndex;
      scenes.append(
        h(
          'button',
          {
            type: 'button',
            class: `st-scene${current ? ' current' : ''}`,
            'data-testid': 'scene-tab-scene',
            disabled: !ready,
            title: ready ? (current ? 'The open scene' : 'Open this scene') : 'Not ready yet',
            onclick: () => !current && void director.openScene(p!.id, job.sceneIndex, job.manifestUrl ?? api.manifest(p!.id, job.sceneIndex)),
          },
          h('span', { class: 'scene-idx' }, job.sceneIndex + 1),
          h('span', { class: 'st-scene-name' }, job.heading ?? job.slug),
        ),
      );
    }
  };

  const renderWorld = () => {
    const rt = director.runtime;
    world.replaceChildren();
    worldKind.textContent = rt ? (rt.placeholder ? 'placeholder world' : rt.manifest.world.provider === 'mock' ? 'mock world' : 'Marble world') : '';
    if (!rt) return;
    const w = rt.manifest.world;
    const plan = rt.manifest.plan;
    const rows: (HTMLElement | string)[] = [];
    rows.push(h('div', {}, `${plan.interior ? 'Interior' : 'Exterior'} · ${plan.timeOfDay}`));
    if (w.caption) rows.push(h('div', { class: 'muted st-caption', title: w.caption }, w.caption));
    const cal = w.scaleCalibration;
    if (cal) {
      const ref = scaleHeadline(cal);
      rows.push(
        h(
          'details',
          { class: 'st-scale' },
          h('summary', {}, `Scale ×${cal.factor.toFixed(2)}${ref ? ` (${ref})` : ''} · ${cal.confidence}`),
          ...cal.evidence.split(' · ').map((e) => h('div', { class: 'muted' }, e)),
        ),
      );
    }
    const floor = floorOffset(w);
    if (floor) rows.push(h('div', { class: 'muted' }, `Floor raised ${(floor * 100).toFixed(0)} cm to the visible ground`));
    rows.push(h('div', { class: 'muted' }, rt.collider ? 'Collider loaded: dragged actors stay out of walls' : w.colliderGlb ? 'Collider loading…' : 'No collider: actors move freely'));
    world.append(...rows);
  };

  const renderCast = () => {
    const p = projects.current();
    const rt = director.runtime;
    cast.replaceChildren();
    if (!rt) {
      cast.append(h('div', { class: 'muted small' }, 'No scene open.'));
      return;
    }
    const builds = new Map((p?.actors ?? []).map((a) => [a.characterId, a]));
    for (const id of rt.manifest.plan.characterIds.length ? rt.manifest.plan.characterIds : [...rt.actors.keys()]) {
      const a = builds.get(id);
      const ref: Ref = { type: 'actor', id };
      const row = a && p ? projects.actorRow(p, a) : h('div', { class: 'actor-row', 'data-character': id }, h('span', { class: 'actor-name' }, id));
      // the height the actor is drawn at (viewer/actors actorHeight): body, else asset, else plan
      const asset = rt.manifest.actors.find((x) => x.characterId === id);
      const tall =
        (rt.actors.get(id)?.object.userData.heightMeters as number | undefined) ??
        (asset ? actorHeight(asset, rt.manifest.characters.find((c) => c.id === id)) : undefined);
      const name = row.querySelector('.actor-name');
      let after: Element | null = name;
      if (tall) {
        const chip = h('span', { class: 'muted small actor-height', 'data-testid': 'actor-height', title: 'Standing height: the actor is scaled to it' }, `${tall.toFixed(2)} m`);
        if (after) after.after(chip);
        else row.append(chip);
        after = chip;
      }
      // the director's photo beside it; the plan is current (the chat may have just set it), the
      // manifest the fallback
      const character = (p && projectPlan(p, renderCast)?.characters.find((c) => c.id === id)) ?? rt.manifest.characters.find((c) => c.id === id);
      if (character?.referenceImage) {
        const photo = characterPhoto(rt.manifest.projectId, id, character.referenceImage);
        if (after) after.after(photo);
        else row.prepend(photo);
      }
      const tools = h(
        'div',
        { class: 'actor-tools' },
        rt.actors.has(id) ? selectBtn(ref, 'Select in the view (drag to move, ring turns)') : null,
        rt.actors.has(id)
          ? h('button', { type: 'button', class: 'small', title: "Back to the screenplay's blocking mark", 'data-testid': 'reset-actor', onclick: () => manip.manipulator.reset(ref) }, 'Reset')
          : null,
      );
      cast.append(h('div', { class: 'st-cast-item' }, row, tools));
    }
  };

  const objectRow = (r: Ref, name: string, kind: string, deletable = true) =>
    h(
      'div',
      { class: `st-object${selected(r) ? ' selected' : ''}`, 'data-testid': 'object-row', 'data-type': r.type, 'data-id': r.id },
      h('button', { type: 'button', class: 'link', title: 'Select in the view', onclick: () => director.select(selected(r) ? null : r) }, name),
      h('span', { class: 'muted small' }, kind),
      deletable ? h('button', { type: 'button', class: 'icon', title: `Delete (⌫ in the view; ⌘Z brings it back)`, onclick: () => manip.manipulator.remove(r) }, '×') : null,
    );

  const renderObjects = () => {
    const rt = director.runtime;
    objects.replaceChildren();
    if (!rt) return;
    const doc = rt.edits;
    const groups: [string, HTMLElement[]][] = [];
    const props = [
      ...rt.dynamics.items.map((i) => i.element),
      ...(doc ? effectiveProps(doc.edits).added : []),
    ].filter((el) => !isPropRemoved(doc, el.id));
    groups.push(['Props', props.map((el) => objectRow({ type: 'prop', id: el.id }, el.label || el.kind, el.kind))]);
    const lights = look.session.look?.lights ?? [];
    groups.push(['Lights', lights.map((l) => objectRow({ type: 'light', id: l.id }, l.name, `${l.kind}${l.enabled ? '' : ' · off'}`))]);
    groups.push(['Cameras', director.cameras.map((c) => objectRow({ type: 'camera', id: c.id }, c.name, c.id === director.activeCameraId ? 'active' : `${Math.round(c.fovDeg)}°`))]);
    for (const [title, rows] of groups) {
      objects.append(h('div', { class: 'st-group' }, title));
      if (rows.length) objects.append(...rows);
      else
        objects.append(
          h('div', { class: 'muted small' }, title === 'Lights' ? 'None — add one in the Look tab.' : title === 'Cameras' ? 'None — drop one with C.' : 'None.'),
        );
    }
    objects.append(h('div', { class: 'muted small st-tip' }, 'Click anything in the view to select it; click the world to select a region of splats.'));
  };

  let lookOff: (() => void) | null = null;
  const watchLook = () => {
    lookOff?.();
    lookOff = director.runtime?.look.onChange(() => renderObjectsSoon()) ?? null;
  };
  let soon: ReturnType<typeof setTimeout> | null = null;
  const renderObjectsSoon = () => {
    if (soon) return;
    soon = setTimeout(() => {
      soon = null;
      renderObjects();
    }, 120);
  };

  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      watchLook();
      renderScenes();
      renderWorld();
      renderCast();
      renderObjects();
      // the collider arrives later (World says so)
      void director.runtime?.colliderReady.then(() => renderWorld());
    }
    if (c === 'cameras' || c === 'undo') renderObjectsSoon();
    if (c === 'selection') {
      renderCast();
      renderObjects();
    }
  });
  projects.onChange(() => {
    renderScenes();
    renderCast();
  });
  renderScenes();
  renderWorld();
  renderCast();
  renderObjects();
}

