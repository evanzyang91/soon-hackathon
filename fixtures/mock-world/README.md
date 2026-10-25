# Mock sets (MOCK=1 and MARBLE_DRY_RUN=1)

Each folder here is one procedural set: `<set>/world.spz` and `<set>/thumbnail.png`. They are generated,
not downloaded, by `server/pipeline/mock-world.ts`. Run
`pnpm tsx server/pipeline/cli.ts make-mock-world [set|all]` to rebuild them (default: all). They are
original, deterministic and license-free.

A mock world is used whenever Marble is not called: in MOCK mode, without `WLT_API_KEY`, and under
`MARBLE_DRY_RUN=1`. `server/pipeline/mock-set.ts` `pickMockSet(scene, style)` chooses the set from the
scene heading. If the heading has no keyword, at least two keywords in the world prompt can decide, and
after that the interior flag and the screenplay's style. The world stage copies the chosen folder,
records it in `WorldAsset.caption` (`mock set: forest`) and names it in the stage note
(`mock world: forest set`).

| Set | Splats | SPZ | What it is | Typical headings |
| --- | ---: | ---: | --- | --- |
| `street` | 33,183 | 148 KB | The original stage: concrete checker floor, a road at z ≈ −10.5, a brick backdrop with lit windows, a sky card, a crate and a pillar | CITY STREET, ROOFTOP, BUS STOP, any other exterior |
| `forest` | 25,177 | 126 KB | A grass clearing with an earth path, mossy trunks, canopy, low mist, a treeline and a pale sky | FOREST, WOODS, GLADE, JUNGLE, CLEARING |
| `hall` | 30,482 | 148 KB | A stone great hall: flagstones and a red runner, columns on both sides, torches under tall windows, a dais with a throne, banners, a rose window and a dark beamed ceiling | THRONE HALL, BALLROOM, CASTLE, CHURCH, TEMPLE (interior) |
| `cave` | 23,704 | 139 KB | A rock floor under a rough vault, stalagmites and stalactites, and a glowing teal pool at the back | CAVE, MINE, TUNNEL, CRYPT, CELLAR |
| `desert` | 24,082 | 123 KB | Rippled sand with a wheel track, dune ridges, distant mesas and a huge warm sky with a low sun | DESERT, DUNES, CANYON, LUNAR, MARTIAN |
| `station` | 32,427 | 144 KB | A sci-fi cargo deck: deck plates with hazard lanes, ribbed bulkheads, ceiling strip lights, cargo containers and a viewport onto stars and a planet | STATION, STARSHIP, HANGAR, AIRLOCK; CORRIDOR, DECK, LAB in science fiction; any sci-fi interior |
| `shore` | 23,813 | 126 KB | Sand and pebbles, wet sand and foam, the sea out to the horizon with wave streaks, cliffs on the left and a cloudy sky | BEACH, HARBOUR, DOCK, PIER, LAKE, RIVER, COAST |
| `village` | 32,002 | 151 KB | A dirt main street between timber storefronts with signs, porches and posts, a cross street at z ≈ −10.5, hills and sky. It works as a western main street or a medieval lane | VILLAGE, TOWN, MAIN STREET, MARKET, SQUARE, COURTYARD, SALOON (exterior); a fantasy / western / period exterior |
| `room` | 18,465 | 92 KB | A cosy room: a plank floor and a rug, three walls with wainscoting, a bright window, a fireplace, an armchair, and a table with two chairs | KITCHEN, SALOON (interior), any other interior |
| `field` | 27,583 | 137 KB | Open grass with a farm track, a fence line, golden crops, a red barn, a treeline and a big sky | FIELD, MEADOW, FARM, CORNFIELD, PRAIRIE, MOOR, CEMETERY |

Every set follows the same layout rules, so actors, dynamics and the ground field behave the same way on
every set:

- It is stored in Marble's OpenCV frame (Y down, +Z forward). The manifest therefore says
  `opencvFrame: true`, `metricScaleFactor: 1` and `groundPlaneOffset: 0`, so the viewer runs the same
  180° X flip it runs for a real Marble world. SPZ v2, SH degree 0, at most 160 KB and about 33k splats
  or fewer, so SwiftShader in the e2e specs renders it no slower than the original stage.
- The floor is flat at exactly y = 0 across the stage area: x −6…6, z −10…1. The exterior sets cover
  the ground field's whole default grid, x −8.5…8.5, z −12.6…2.4, with a 0.14 m lattice. The shallow
  `room` ends at its back wall, z −8.6.
- The floor is open where the planner stands actors: z −1.5…−4, |x| ≤ 2.5.
- A clear, flat lane crosses the view at z ≈ −10.5 for mock cars, buses and riders. The `room` keeps
  z ≈ −6 clear instead.
- From the start camera at (0, 1.6, 0), looking down −Z with the laptop's 60° vertical field of view, the
  frame is 98–100 % non-black in GPU Chromium. `docs/images/genre-mock-sets.png` is the contact sheet.
- Nothing flat and opaque sits below the floor or within knee height of it inside the ground grid. Mist,
  glow, ferns and rubble are transparent or round splats, which the ground field skips.
- `thumbnail.png` (192×108) is the start view rendered offline by the small CPU splatter in
  `mock-world.ts`, not a painted card.

The `street` set is byte-for-byte the original `world.spz` (sha256 `a84419ab…`). It was checked in
headless Chromium with `@sparkjsdev/spark` 2.4.
