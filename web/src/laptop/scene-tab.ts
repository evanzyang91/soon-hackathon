// Scene mode (docs/PLAN-v4.md "Scenes" + "Blocking"): what the scene is and who does what in it.
//
//   heading     the scene heading, interior / exterior · time of day, and a strip of the project's
//               scenes (click one to open it)
//   Mood        the eighteen look presets as named swatches (scrollable), the planner's choice
//               marked; a click applies the preset keeping lights and lens (as Tools › Grade's
//               preset list does), "Scene's look" goes back to the plan's
//   Cast        each character: photo, name, height, pose, eye line, the staged mark's note,
//               Select (drag the mark in the view) and Back to mark; High detail rebuilds
//   Lines       the dialogue, a click plays a line in place (the playing one highlights), Play
//               scene runs them in order with the background action; the shots covering a line
//   Background  the moving props (traffic, animals, vehicles) with on / off (a prop-remove edit,
//               so the phone drops it too); Add prop imports a .glb or generates one from a
//               description (props-add.ts), with a row per generation in progress
//   Location    the world in one line; "Change the location…" opens the chat on this scene
import { api } from '@shared/api';
import { shotNumber } from '@shared/shots';
import type { Look } from '@shared/look';
import type { LookMood } from '@shared/look-presets';
import type { LookPresetName } from '@shared/schema';
import { effectiveProps } from '../viewer/edits/model';
import { isPropRemoved, withPropRemoved } from '../viewer/manipulate/edits';
import { actorHeight } from '../viewer/actors';
import { gazeTargets } from '../viewer/gaze';
import { LOOK_PRESET_LABELS, LOOK_PRESETS, PRESET_ORDER, presetLook, seedToLook } from '../viewer/look/presets';
import type { ChatPanel } from './chat-panel';
import type { Director } from './director';
import { byId, h } from './dom';
import { icon } from './icons';
import type { LookPanel } from './look-panel';
import type { Manipulation } from './manipulate';
import { displayName, sceneReady, type ProjectsPanel } from './projects-panel';
import { mountPropAdder } from './props-add';
import { characterPhoto, projectPlan } from './references';
import type { ShotsPanel } from './shots-panel';

type Ref = NonNullable<Director['selection']>;

export interface SceneTabParts {
  projects: ProjectsPanel;
  look: LookPanel;
  manip: Manipulation;
  chat: ChatPanel;
  shots: ShotsPanel;
  /** The viewport's one-line message (Add prop reports with it). */
  toast?(text: string): void;
}

export function mountSceneTab(director: Director, parts: SceneTabParts) {
  const { projects, look, manip, chat, shots } = parts;
  const adder = mountPropAdder(director, manip, { toast: (t) => parts.toast?.(t) });
  const heading = byId('st-heading');
  const scenes = byId('st-scenes');
  const mood = byId('st-mood');
  const cast = byId('st-cast');
  const lines = byId('line-list');
  const background = byId('st-background');
  const location = byId('st-location');

  byId('sc-playall').addEventListener('click', () => void director.playAll());
  byId('sc-stop').addEventListener('click', () => director.stopLines());

  // ---- heading + the project's scenes -----------------------------------------------------------
  const renderHeading = () => {
    const rt = director.runtime;
    heading.replaceChildren();
    if (!rt) {
      heading.append(h('div', { class: 'empty' }, 'Open a scene from the script drawer.'));
      return;
    }
    const plan = rt.manifest.plan;
    heading.append(
      h('h1', { class: 'title scene-title', 'data-testid': 'scene-heading' }, plan.heading),
      h('div', { class: 'muted small' }, `${plan.interior ? 'Interior' : 'Exterior'} · ${plan.timeOfDay}`),
    );
  };
  const renderScenes = () => {
    const p = projects.current();
    scenes.replaceChildren();
    if (!p || p.scenes.length < 2) return;
    for (const job of p.scenes) {
      const ready = sceneReady(job);
      const current = director.projectId === p.id && director.sceneIndex === job.sceneIndex;
      scenes.append(
        h(
          'button',
          {
            type: 'button',
            class: `small st-scene${current ? ' current on' : ''}`,
            'data-testid': 'scene-tab-scene',
            disabled: !ready,
            title: `${job.heading ?? job.slug}${ready ? (current ? ' (open)' : '') : ' (not ready yet)'}`,
            onclick: () => !current && void director.openScene(p.id, job.sceneIndex, job.manifestUrl ?? api.manifest(p.id, job.sceneIndex)),
          },
          `Sc ${job.sceneIndex + 1}`,
        ),
      );
    }
  };

  // ---- mood ---------------------------------------------------------------------------------------
  const applyLook = (next: Look | null) => {
    if (!next) return;
    look.session.apply(next, null);
    look.session.seal();
  };
  let moodKey = '';
  let moodScene: unknown = null;
  const renderMood = () => {
    const rt = director.runtime;
    const l = look.session.look;
    const seed = rt?.manifest.plan.look ?? null;
    const key = JSON.stringify([!!rt, l, seed]);
    if (key === moodKey) return;
    moodKey = key;
    mood.replaceChildren();
    if (!rt || !l) {
      mood.append(h('div', { class: 'empty' }, rt ? 'Loading the look…' : 'No scene open.'));
      return;
    }
    const same = (a: Look) => JSON.stringify(a) === JSON.stringify(l);
    const swatch = (name: string, m: LookMood, on: boolean, extra: Record<string, string>, onclick: () => void, planned = false) =>
      h(
        'button',
        {
          type: 'button',
          class: `mood${on ? ' on' : ''}${planned ? ' planned' : ''}`,
          'aria-pressed': String(on),
          onclick,
          ...extra,
        },
        h('span', { class: 'mood-chip', style: swatchCss(m) }),
        h('span', { class: 'mood-name' }, name),
      );
    if (seed) {
      const scene = seedToLook(seed, l);
      mood.append(
        swatch("Scene's look", scene, same(scene), { 'data-testid': 'mood-scene', title: `The planner's look for this scene: ${scene.name} (keeps your lights and lens)` }, () => applyLook(seedToLook(seed, look.session.look ?? l))),
      );
    }
    for (const name of PRESET_ORDER) {
      const planned = seed?.preset === name;
      const next = presetLook(name as LookPresetName, l);
      mood.append(
        swatch(
          LOOK_PRESET_LABELS[name],
          LOOK_PRESETS[name],
          same(next),
          {
            'data-testid': 'mood-swatch',
            'data-preset': name,
            title: `${LOOK_PRESET_LABELS[name]}${planned ? ' — the planner’s choice for this scene' : ''} (keeps your lights and lens; fine-tune in Tools › Grade)`,
          },
          () => applyLook(presetLook(name as LookPresetName, look.session.look ?? l)),
          planned,
        ),
      );
    }
    // a newly opened scene shows its current mood once its look is in (the row scrolls sideways,
    // nothing else moves)
    const on = mood.querySelector<HTMLElement>('.mood.on');
    if (moodScene !== rt && on) {
      moodScene = rt;
      mood.scrollLeft = Math.max(0, on.offsetLeft - mood.clientWidth / 2 + on.offsetWidth / 2);
    }
  };

  // ---- cast ---------------------------------------------------------------------------------------
  const selected = (r: Ref) => director.selection?.type === r.type && director.selection.id === r.id;
  const renderCast = () => {
    const p = projects.current();
    const rt = director.runtime;
    cast.replaceChildren();
    if (!rt) {
      cast.append(h('div', { class: 'empty' }, 'No scene open.'));
      return;
    }
    const ids = rt.manifest.plan.characterIds.length ? rt.manifest.plan.characterIds : [...rt.actors.keys()];
    if (!ids.length) cast.append(h('div', { class: 'empty' }, 'Nobody in this scene.'));
    const builds = new Map((p?.actors ?? []).map((a) => [a.characterId, a]));
    const speaker = rt.manifest.plan.dialogue.find((l) => l.id === director.speakingLineId)?.characterId ?? null;
    const spots = [...rt.actors.values()].filter((a) => a.object.visible).map((a) => ({ id: a.characterId, x: a.object.position.x, z: a.object.position.z }));
    const gaze = gazeTargets(spots, speaker);
    const nameOf = (id: string) => displayName(rt.manifest.characters.find((c) => c.id === id)?.name ?? id);
    for (const id of ids) {
      const a = builds.get(id);
      const ref: Ref = { type: 'actor', id };
      const row = a && p ? projects.actorRow(p, a) : h('div', { class: 'actor-row', 'data-character': id }, h('span', { class: 'actor-name' }, nameOf(id)));
      // the height the actor is drawn at (viewer/actors actorHeight): body, else asset, else plan
      const asset = rt.manifest.actors.find((x) => x.characterId === id);
      const tall =
        (rt.actors.get(id)?.object.userData.heightMeters as number | undefined) ??
        (asset ? actorHeight(asset, rt.manifest.characters.find((c) => c.id === id)) : undefined);
      const nameEl = row.querySelector('.actor-name');
      let after: Element | null = nameEl;
      if (tall) {
        const chip = h('span', { class: 'muted small actor-height num', 'data-testid': 'actor-height', title: 'Standing height: the actor is scaled to it' }, `${tall.toFixed(2)} m`);
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
      const block = rt.manifest.plan.blocking.find((b) => b.characterId === id);
      const looks = gaze.get(id);
      const meta = h(
        'div',
        { class: 'muted small cast-meta', 'data-testid': 'cast-meta' },
        block?.pose ?? 'standing',
        looks ? ` · eye line on ${nameOf(looks)}` : '',
      );
      // why the staging step (server/pipeline/staging.ts) put them there; absent for blind marks
      const why = block?.note
        ? h('div', { class: 'muted small st-cast-note', title: 'Where the pipeline staged the mark on the set; Back to mark returns here', 'data-testid': 'cast-note' }, `Mark: ${block.note}`)
        : null;
      const on = rt.actors.has(id);
      const tools = on
        ? h(
            'div',
            { class: 'actor-tools' },
            h(
              'button',
              { type: 'button', class: `small${selected(ref) ? ' on' : ''}`, title: 'Select in the view: drag to move the mark, the ring turns them', 'data-testid': 'select-actor', onclick: () => director.select(selected(ref) ? null : ref) },
              selected(ref) ? 'Selected' : 'Select',
            ),
            h('button', { type: 'button', class: 'small', title: "Back to the screenplay's mark (drops your moves)", 'data-testid': 'reset-actor', onclick: () => manip.manipulator.reset(ref) }, 'Back to mark'),
          )
        : null;
      cast.append(h('div', { class: 'st-cast-item', 'data-character': id }, row, meta, why, tools));
    }
  };

  // ---- lines --------------------------------------------------------------------------------------
  const renderLines = () => {
    lines.replaceChildren();
    const rt = director.runtime;
    if (!rt) return;
    const names = new Map(rt.manifest.characters.map((c) => [c.id, c.name]));
    const dialogue = [...rt.manifest.plan.dialogue].sort((a, b) => a.order - b.order);
    if (!dialogue.length) lines.append(h('div', { class: 'muted' }, 'No dialogue in this scene.'));
    const list = shots.shots();
    const n = director.sceneIndex ?? 0;
    for (const l of dialogue) {
      const speaking = director.speakingLineId === l.id;
      const hasAudio = rt.manifest.audio.some((a) => a.lineId === l.id);
      const covered = list.map((s, i) => (s.lines.includes(l.id) ? shotNumber(n, i) : null)).filter((x): x is string => !!x);
      lines.append(
        h(
          'button',
          {
            class: `line${speaking ? ' speaking' : ''}`,
            'data-testid': 'line',
            'data-line': l.id,
            title: hasAudio ? 'Play line' : 'Play line (no audio — caption only)',
            onclick: () => void director.playLine(l.id),
          },
          h('span', { class: 'line-play' }, icon('play')),
          h('span', { class: 'line-body' },
            h('span', { class: 'who' }, names.get(l.characterId) ?? l.characterId),
            l.parenthetical ? h('span', { class: 'paren' }, `(${l.parenthetical.replace(/^\(|\)$/g, '')})`) : null,
            h('span', { class: 'text' }, l.text),
            hasAudio ? null : h('span', { class: 'muted small' }, ' · no audio'),
          ),
          covered.length
            ? h('span', { class: 'line-shots muted small num', title: `Covered by ${covered.join(', ')}` }, covered.length > 3 ? `${covered.slice(0, 3).join(' ')} +${covered.length - 3}` : covered.join(' '))
            : h('span', { class: 'line-shots muted small', title: 'No shot covers this line yet (Shots › a shot › Lines it covers)' }, '—'),
        ),
      );
    }
  };

  // ---- background -----------------------------------------------------------------------------------
  const renderBackground = () => {
    const rt = director.runtime;
    background.replaceChildren();
    if (!rt) return;
    const doc = rt.edits;
    const props = [...rt.dynamics.items.map((i) => i.element), ...(doc ? effectiveProps(doc.edits).added : [])];
    if (!props.length) background.append(h('div', { class: 'empty' }, 'No background action in this scene.'));
    for (const el of props) {
      const on = !isPropRemoved(doc, el.id);
      const box = h('input', { type: 'checkbox', checked: on, 'data-testid': 'background-toggle', title: on ? 'Switch off (the phone drops it too)' : 'Switch on' });
      box.addEventListener('change', () => {
        const id = el.id;
        void manip.store.commit((d) =>
          box.checked
            ? { ...d, edits: d.edits.map((e) => (e.kind === 'prop-remove' && e.elementId === id ? { ...e, enabled: false } : e)) }
            : withPropRemoved(d, id),
        );
        setTimeout(renderBackground, 50);
      });
      background.append(
        h(
          'label',
          { class: `list-row bg-row${on ? '' : ' off'}`, 'data-testid': 'background-row', 'data-id': el.id },
          box,
          h('span', { class: 'bg-name', title: el.model?.source ? `${el.label} (${el.model.source})` : el.label }, el.label || el.kind),
          h('span', { class: 'muted small' }, el.kind),
        ),
      );
    }
    background.append(...adder.nodes());
  };

  // ---- location -------------------------------------------------------------------------------------
  const renderLocation = () => {
    const rt = director.runtime;
    location.replaceChildren();
    if (!rt) return;
    const w = rt.manifest.world;
    const kind = rt.placeholder ? 'Stand-in set (the world did not load)' : w.provider === 'mock' ? 'Offline set' : 'Generated world';
    const n = rt.manifest.plan.index;
    location.append(
      h('div', { class: 'loc-line small', 'data-testid': 'location', title: w.caption ?? '' }, h('span', { class: `dot ${rt.placeholder ? 'warn' : 'ok'}` }), h('span', { class: 'loc-text' }, `${kind}${w.caption ? ` · ${w.caption}` : ''}`)),
      h(
        'button',
        {
          type: 'button',
          class: 'small',
          'data-testid': 'change-location',
          title: 'Describe a different place or attach a photo of it in the chat (a new world takes ~5 min and asks first)',
          onclick: () => director.projectId && chat.compose(director.projectId, `Scene ${n + 1}: `, `scene:${n}`),
        },
        'Change the location…',
      ),
    );
  };

  // ---- wiring ---------------------------------------------------------------------------------------
  let watched: unknown = null;
  let lookOff: (() => void) | null = null;
  const watchLook = () => {
    if (watched === director.runtime) return;
    watched = director.runtime;
    lookOff?.();
    lookOff = director.runtime?.look.onChange(() => {
      renderMoodSoon();
      renderBackgroundSoon();
    }) ?? null;
  };
  const soon = (fn: () => void) => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return () => {
      if (t) return;
      t = setTimeout(() => {
        t = null;
        fn();
      }, 120);
    };
  };
  const renderMoodSoon = soon(renderMood);
  const renderBackgroundSoon = soon(renderBackground);
  adder.onChange(renderBackgroundSoon);
  const renderCastSoon = soon(renderCast);

  director.on((c) => {
    if (c === 'scene' || c === 'loading') {
      watchLook();
      renderHeading();
      renderScenes();
      renderMood();
      renderCast();
      renderLines();
      renderBackground();
      renderLocation();
    }
    if (c === 'lines') {
      renderLines();
      renderCastSoon();
    }
    if (c === 'selection' || c === 'undo') renderCastSoon();
    if (c === 'undo') renderBackgroundSoon();
  });
  projects.onChange(() => {
    renderScenes();
    renderCast();
  });
  shots.onChange(soon(renderLines));
  renderHeading();
  renderScenes();
  renderMood();
  renderCast();
  renderLines();
  renderBackground();
  renderLocation();
}

// ---- mood swatches ----------------------------------------------------------------------------------

type RGB = [number, number, number];
/** A neutral exterior (sky, middle distance, ground) the swatch grades. */
const SCENE: RGB[] = [
  [0.58, 0.66, 0.76],
  [0.5, 0.46, 0.41],
  [0.27, 0.25, 0.23],
];
/** What each LUT does to a frame, roughly: a colour it multiplies toward, and how much colour it keeps. */
const LUT_TINT: Record<Look['lut'], { tint: RGB; sat: number }> = {
  neutral: { tint: [1, 1, 1], sat: 1 },
  'teal-orange': { tint: [1, 0.78, 0.6], sat: 1.1 },
  noir: { tint: [1, 1, 1], sat: 0 },
  kodak: { tint: [1, 0.9, 0.76], sat: 1.05 },
  bleach: { tint: [0.95, 0.97, 1], sat: 0.45 },
  'cool-night': { tint: [0.62, 0.74, 1], sat: 0.8 },
  golden: { tint: [1, 0.8, 0.52], sat: 1.1 },
  sepia: { tint: [1, 0.82, 0.6], sat: 0.25 },
  verdant: { tint: [0.72, 0.95, 0.66], sat: 1.05 },
  cyber: { tint: [0.92, 0.55, 1], sat: 1.25 },
  ice: { tint: [0.78, 0.92, 1], sat: 0.7 },
  ember: { tint: [1, 0.62, 0.38], sat: 1.1 },
};
const hex = (s: string): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(s);
  const n = m ? parseInt(m[1]!, 16) : 0x808080;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** A CSS background that reads like the mood on a plain exterior: sky, middle distance, ground. */
export function swatchCss(m: LookMood): string {
  const lut = LUT_TINT[m.lut] ?? LUT_TINT.neutral;
  const k = m.lutStrength;
  const grade = (c: RGB, i: number): string => {
    let v: RGB = [...c];
    if (i === 0 && m.skyTint.strength > 0) v = mix(v, hex(m.skyTint.color), Math.min(1, m.skyTint.strength * 0.8));
    if (i < 2 && m.fog.density > 0) v = mix(v, hex(m.fog.color), Math.min(0.85, m.fog.density * (i === 0 ? 0.9 : 0.6)));
    const e = 2 ** m.exposure;
    v = [v[0] * e * (1 + 0.28 * m.temperature + 0.08 * m.tint), v[1] * e * (1 - 0.16 * m.tint), v[2] * e * (1 - 0.28 * m.temperature + 0.08 * m.tint)];
    v = v.map((x) => (x - 0.42) * m.contrast + 0.42) as RGB;
    const l = (x: RGB) => 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    const sat = m.saturation * (1 + (lut.sat - 1) * k);
    const y = l(v);
    v = v.map((x) => y + (x - y) * sat) as RGB;
    v = mix(v, [v[0] * lut.tint[0], v[1] * lut.tint[1], v[2] * lut.tint[2]], k * 0.8);
    v = v.map((x) => x + (x < 0.4 ? m.shadows * 0.12 : m.highlights * 0.12)) as RGB;
    const [r, g, b] = v.map((x) => Math.round(255 * Math.min(1, Math.max(0, x))));
    return `rgb(${r} ${g} ${b})`;
  };
  const [sky, mid, ground] = SCENE.map(grade);
  const vig = Math.min(0.75, m.vignette * 0.9);
  return `background: radial-gradient(ellipse at 50% 45%, transparent 45%, rgb(0 0 0 / ${vig.toFixed(2)}) 100%), linear-gradient(180deg, ${sky} 0%, ${sky} 38%, ${mid} 58%, ${ground} 100%);`;
}
