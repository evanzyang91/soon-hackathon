# Previz Stage v3 — every genre looks like itself

Builds on docs/PLAN.md and docs/PLAN-v2.md. The v3 actor work (ground field, scale decision,
per-character heights, vision staging, project chat) is documented in README.md. This document is
the genre work: a fantasy, science-fiction, horror, western or period screenplay must come out
looking like one, on a real Marble world and in MOCK mode, without the director touching a slider.

Contracts (lead-owned, in `shared/`): `schema.ts` (`VisualStyle`, `LookSeed`, `LookPresetName`,
`LutPreset`, the extended `DynamicElementKind`, `ScreenplayPlan.style`, `ScenePlan.look`),
`look-presets.ts` (`LOOK_PRESETS`, `LOOK_PRESET_LABELS`, `LOOK_PRESET_GROUPS`, `presetLook`,
`seedToLook`). Fixture screenplays for five genres are in `fixtures/genres/*.fountain`.

## What is wrong today

- Every scene opens ungraded: `edits.json` starts as `defaultLook()`; the four presets exist but
  nothing chooses one. A candlelit throne hall and a sodium-lit bus stop render with the same neutral
  grade, and the director has to know the Look tab exists.
- The planner has no notion of genre. `worldPrompt` is asked for as a "rich photographic
  description" with no style words, so a high-fantasy clearing and a present-day park get the same
  register; the mock planner's heuristic prompt is "Photorealistic exterior <location>".
- Actor references are "photoreal studio shot of: <description>"; wardrobe depends entirely on the
  description, so costumes drift between characters of the same story.
- Moving props cover modern traffic only (car, bus, bicycle, bird, pedestrian, generic). A dragon
  overhead, a stagecoach, a maintenance drone or a black dog all become the purple `generic` marker.
- MOCK mode (and `MARBLE_DRY_RUN=1`, the only mode allowed while Marble credits are capped) shows
  one concrete stage with a road and a brick wall for every heading, so a genre screenplay cannot be
  reviewed without spending credits.

## 1. The planner reads the genre (`style`) and suggests a look per scene (`look`)

`ScreenplayPlan.style: VisualStyle` = `{ genre, era, worldStyle, palette }`, free text, a few
words each, chosen once for the screenplay. `ScenePlan.look: LookSeed` = a `LookPresetName` plus
optional adjustments in Look units (exposure, contrast, saturation, temperature, tint, lut,
lutStrength, vignette, grain, bloom, fog, skyTint) and `mood` words for the name.

- Claude planner (`server/pipeline/screenplay.ts`): the system prompt asks for the style first and
  for every `worldPrompt` to be written in that register (opening with the render style, e.g.
  "Photoreal cinematic film still of …" or "Lush painterly-realistic …", then the set), still
  without people, animals, vehicles or story; `look` per scene from time of day, interior, weather
  and mood words in the action; `dynamics.kind` from the full `DynamicElementKind` list.
- Mock planner (`server/pipeline/fountain.ts`): keyword heuristics give the style (dragon, sword,
  kingdom → high fantasy; station, orbit, android → science fiction; cellar, blood, scream → horror;
  saloon, sheriff, wagon → western; ballroom, carriage, 18xx → period drama; else contemporary) and
  a `LookSeed` per scene (interior + night → candlelit for fantasy/period, warm-interior otherwise;
  exterior night → night-street / moonlit / horror; dusk → golden-hour; day exterior → genre
  default …); `heuristicWorldPrompt` opens with `style.worldStyle`.
- Older plans without `look` get one derived the same way from heading, time of day and interior
  (`lookSeedFor(plan, style)` in `server/pipeline/look-seed.ts`), so the live bus-stop project
  benefits without re-planning.
- Actor references (`server/pipeline/actors.ts referencePrompt`) append one sentence of
  `style.genre` + `style.era` so wardrobe stays consistent across the cast; the photo path is unchanged.
- The chat planner / `plan-patch` accepts `style.*` and `scene.look.*` fields ("make the whole film
  look like a western", "scene 2 colder and foggier"); the plan card shows the style line.

## 2. The manifest stage seeds the scene's look

When a scene's manifest is written and `scene-<n>/edits.json` does not exist, the server writes one
with `look = seedToLook(plan.look ?? lookSeedFor(plan, style))`, `revision 1`, and a history entry
`{ prompt: 'suggested look from the plan', plan: { scope: 'look', … } }` (`server/pipeline/look-seed.ts`,
called from the manifest step in `project.ts`). An existing edits.json is never touched: the
director's grade always wins. The laptop and phone already load the look from that file, so no
viewer change is needed for the first frame to be graded; the phone HUD shows the look name
("Candlelit · cold, eerie, damp stone"). `cli look <projectDir> <n> [--write] [--preset <name>]`
prints or (re)writes the seeded look for an existing project.

## 3. Presets for every genre (`shared/look-presets.ts`) and the Look panel

18 full-look presets in three groups (Daylight: daylight-neutral, overcast, golden-hour, blue-hour,
storm, snowfall · Night & interiors: night-street, warm-interior, candlelit, moonlit · Genre:
enchanted, cold-steel, neon-noir, horror, western-dust, film-noir, period-warm, dreamlike) and five
new LUTs (sepia, verdant, cyber, ice, ember; analytic `LutParams` in `web/src/viewer/look/grade.ts`).
Each preset must read as its name on the four real worlds (city street night, kitchen morning,
rooftop dusk, the bus stop) and on the mock sets, and stay distinct from its neighbours. The Look
panel lists them by group, shows the plan's suggested look as **Scene's look** (one click back to
it), and keeps the LUT list. The viewer's `presets.ts` re-exports the shared table.

## 4. Moving props for any era (`web/src/viewer/props.ts`)

New kinds: truck, motorcycle, dog, horse (ridden when the label says rider/rides/on horseback),
wagon (two horses + a covered or open cart; "stagecoach" closed), boat (hull + cabin, bobbing),
dragon (body, neck, tail, two flapping wings; flies along its path), drone (small body, four rotors,
hover bob), spacecraft (hull + wings + engine glow). Each is primitives + the label colour, animates
with distance / time like the existing props, and has a bounding size that reads at 10–15 m.

## 5. Mock sets per scene type (`fixtures/mock-world/<set>/`)

`server/pipeline/mock-world.ts` builds ten small deterministic SPZ sets (≤ 160 KB each, floor at
y = 0, Marble OpenCV frame, open floor in the foreground, a path for ground dynamics at z ≈ −10.5):
`street` (today's), `forest` (clearing: grass, trunks, canopy, mist), `hall` (stone great hall:
flagstones, columns, torch glow, dais), `cave` (rock, stalagmites, a glowing pool), `desert` (sand,
mesas, big sky), `station` (deck plates, strip lights, bulkheads, viewport with stars), `shore`
(sand, water to the horizon, cliffs), `village` (dirt road, timber fronts; western main street or
medieval lane), `room` (cosy interior: boards, walls, a window, a table), `field` (open grass, a fence line, a treeline, big sky). `pickMockSet(plan, style)`
chooses from heading + worldPrompt keywords + interior; the chosen set is recorded in
`WorldAsset.caption` ("mock set: forest") and the world stage note. `cli make-mock-world [set|all]`.

## 6. Verification

- `tests/e2e/genres.spec.ts`: the fantasy fixture through the MOCK pipeline: `plan.style.genre`
  contains "fantasy", every scene has `plan.look`, scene 0's world caption names the forest set,
  edits.json revision 1 with the seeded name, the laptop opens scene 1 with the HUD showing the
  look name and a graded (non-neutral) frame; the existing specs still pass.
- Evidence (`docs/images/genre-*`): per genre, the laptop viewer in MOCK before (street set, neutral)
  and after (genre set, seeded look); the four real worlds with their seeded looks before/after; the
  Claude planner's style + look + world prompt for two fixtures (`cli parse`, ~$0.05 each). No Marble
  generation: credits stay where they are.

## Work packages

| WP | Scope | Owns |
| --- | --- | --- |
| G1 planner + seed | style + look + kinds in both planners, `look-seed.ts` + manifest seeding, `cli look`, actor reference style sentence, chat plan-patch `style` / `look`, plan card line, tests | `server/pipeline/screenplay.ts`, `fountain.ts`, `look-seed.ts`, `actors.ts` (referencePrompt), `project.ts` (manifest step only), `cli.ts` (look), `chat/patch.ts`, `chat/plan-card.ts`, `chat/planner.ts` |
| G2 mock sets | nine procedural sets, `pickMockSet`, `mockWorld(set)`, CLI, fixture README, tests | `server/pipeline/mock-world.ts`, `mock-set.ts`, `marble.ts` (mockWorld), `fixtures/mock-world/**` |
| G3 looks | preset values + five LUTs tuned on real worlds and mock sets, Look panel groups + Scene's look, phone HUD name, grade tests | `shared/look-presets.ts` (values), `web/src/viewer/look/**`, `web/src/laptop/look-panel.ts` |
| G4 props | nine new procedural props with animation, prop tests, planner prompt list stays in G1 | `web/src/viewer/props.ts`, `dynamics.ts`, `web/src/viewer/actors/dev` harness additions |
| G5 verify | genres e2e spec, evidence images, README + this document's results | `tests/e2e/genres.spec.ts`, `docs/images/genre-*`, README sections |
