# Previz Stage v2 — look development, scoped re-prompting, intuitive editing, ARKit camera

Builds on docs/PLAN.md. Contracts: `shared/look.ts` (Look + SceneEdit), additions to
`shared/protocol.ts` (SceneState.look / editsRevision) and `shared/api.ts` (reprompt + edits routes).

## 1. Look development on the laptop → identical render on the phone

A **Look** is a small JSON document per scene (`scene-<n>/edits.json`), edited live on the laptop
and broadcast in `SceneState.look`, so the phone — the "final cinematography" view — renders the
same frame the director graded. Everything in a Look is applied at render time; nothing is baked.

| Group | Controls | How it renders |
| --- | --- | --- |
| Exposure & grade | exposure, contrast, saturation, temperature, tint, shadows/highlights, lift/gamma/gain | fullscreen post pass (shader) over the composited frame |
| Film | vignette, grain, bloom, LUT presets (neutral, teal-orange, noir, kodak, bleach) | same post pass |
| Atmosphere | fog colour + density, haze, sky tint | post pass with depth (Spark `depthWrite`) + splat colour modifier |
| Lens | depth of field (focus distance, f-stop), focal length is the camera's | Spark DOF (`focalDistance`, `apertureAngle`) |
| Lights | key/fill/practical: point, spot, sun — position, colour, intensity, radius, soft | three.js lights on mesh actors/props + a Spark world modifier that brightens/tints splats by distance/angle to each light (fake relighting; honest limit: a baked splat cannot cast new shadows) |

"Click to focus": clicking the viewport sets `dof.focusDistance` from the splat raycast hit.
Looks have presets, undo/redo, and a per-camera override (a dropped camera can carry its own lens settings).

## 2. Scoped re-prompting (edit only what the prompt touches)

The director types a prompt ("make the pillow on the left red", "move the car closer", "make the
sky stormy"). The server asks Claude for an **EditPlan**: a scope and a list of typed ops. The
scope decides the cost:

| Scope | Examples | Cost | Mechanism |
| --- | --- | --- | --- |
| `look` | warmer, more contrast, night mood, add a key light from the left | instant | patch Look |
| `transform` | move Leo closer, make the car bigger, rotate the bench | instant | actor / prop / light / camera transform |
| `prop` | add a bicycle leaning on the shelter, remove the bus | instant | DynamicElement add/remove (procedural props; image-to-3D later) |
| `splat-region` | pillow red, remove the lamp, make the plant taller, shift the chair left | instant, no re-render | Spark `SplatEdit` SDF region: colour (multiply / hue / set), opacity 0 (remove), displace (move), scale (grow/shrink via displacement field) |
| `world-regen` | different sky, make it winter, turn the kitchen into a diner | ~5 min + 1,580 credits, **requires confirmation** | re-generate the Marble world: preferred path edits the world's own panorama with an image model (inpaint sky / season) and feeds it to Marble as an image prompt so the layout stays; fallback is the text prompt with the delta |

Rules the planner must follow:
- Choose the **cheapest scope that satisfies the prompt**; never regenerate for something a region edit or a grade can do.
- A `splat-region` op needs a 3D target. Resolution order: (1) the director's click/drag selection in the viewport (raycast on splats); (2) Claude vision on the current render returns a pixel box for the named object, unprojected through a splat raycast at its centre and sized from the box; (3) if neither resolves, ask the director to click the object. Never guess a region silently.
- Every applied edit is appended to `edits.json` with the prompt that produced it; edits are
  individually toggleable/deletable and undoable; a regen replaces the world but keeps edits that
  still make sense (look, actors, props; region edits are dropped with a note).
- The response always says what it did and did not do ("Recoloured 1 region (pillow, 0.4 m). Did not change the sofa.").

## 3. Intuitive laptop editing

- Direct manipulation: drag actors, props, lights and dropped cameras on the floor plane; handles for rotate/scale; snap to floor; shift-drag to raise. Click a splat object to select a region (auto-sized sphere, adjustable), then colour/hide/move it from a mini-toolbar.
- Panels: **Scene** (projects/scenes/actors), **Look** (grade/lens/lights with presets), **Edit** (re-prompt box with history and scope chips), **Shoot** (cameras, phone, dialogue, record). One obvious primary action per panel, hover hints, keyboard cheatsheet (`?`).
- Every edit syncs to the phone within one broadcast; the phone HUD shows the look name.

## 4. ARKit camera app (prototype)

Justified: ARKit's visual-inertial tracking gives true 6DoF position (the browser has none) and a
yaw that does not drift or jump the way `DeviceOrientation` does, so both location and direction
are strictly more accurate. Scope: SwiftUI + ARKit app that joins the same relay room, streams
`PhonePose` with a real `offset` (and `source: 'arkit'`), shows the laptop's scene as a WebView of
`/phone.html?pose=external` (the web renderer, fed poses from the native side) so the look pipeline is
shared, and offers re-centre / shutter / record. Generated with xcodegen; **compiles only once Xcode is
installed** (pending the macOS upgrade); until then it ships as reviewed source.

## Work packages

| WP | Scope | Owns |
| --- | --- | --- |
| F look | Look post pass, Spark DOF/depth, light modifiers, Look panel, phone render parity, presets/undo | `web/src/viewer/look/**`, `web/src/laptop/look-panel.ts`, `server/pipeline/edits.ts` (persistence), phone look application |
| G reprompt | EditPlan planner (Claude), region resolution (click + vision), SplatEdit application, prop/transform ops, regen via edited pano, history/undo | `server/pipeline/reprompt/**`, `web/src/viewer/edits/**`, `web/src/laptop/edit-panel.ts` |
| H ux | Direct manipulation, panel shell/IA, onboarding, keyboard | `web/src/laptop/**` shell, `web/src/viewer/manipulate/**` |
| I arkit | iOS app source (xcodegen), pose bridge, docs | `ios/**` |
| E2 verify | e2e for look parity + scoped edits (mock planner), real-key smoke, fresh-clone gate | tests |
