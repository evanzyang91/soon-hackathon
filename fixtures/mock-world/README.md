# Mock world (MOCK=1)

`world.spz` and `thumbnail.png` are generated, not downloaded, by
`server/pipeline/mock-world.ts`. Run `pnpm tsx server/pipeline/cli.ts make-mock-world` to rebuild them.
They are original, deterministic, and license-free.

- About 33k splats, 150 KB, SPZ v2, SH degree 0.
- The scene is a small stage: a checker floor at y = 0, a road across the view at z ≈ -10.5 (where the
  mock car and bus dynamics drive), a brick backdrop with lit windows at z = -18, a sky card at z = -30,
  a crate, and a pillar.
- It is stored in Marble's OpenCV frame (Y down, +Z forward). The manifest therefore says
  `opencvFrame: true`, `metricScaleFactor: 1`, and `groundPlaneOffset: 0`, so the viewer runs the same
  180° X flip it runs for a real Marble world.
- It was checked in headless Chromium with `@sparkjsdev/spark` 2.4: `SplatMesh` decodes all splats,
  and from the start camera at (0, 1.6, 0) looking down -Z the view is about 99% non-black.

Spark's sample `butterfly.spz` (https://sparkjs.dev/assets/splats/butterfly.spz, 4 MB) was not used. It
is only about 2 units across and sits at the origin, which puts it out of view of the start camera.
