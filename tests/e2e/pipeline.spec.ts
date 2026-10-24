// (a) MOCK pipeline over HTTP: screenplay → 3 scenes → manifests that validate and whose assets
// are served.
import { expect, test } from '@playwright/test';
import { SceneManifest } from '../../shared/schema.ts';
import { createReadyProject } from './helpers.ts';

test('screenplay → 3 scene manifests that validate, with every asset served', async ({
  request,
}) => {
  const project = await createReadyProject(request);
  expect(project.mock).toBe(true);
  expect(project.title).toBe('The Last Bus');
  expect(project.scenes).toHaveLength(3);

  const headings: string[] = [];
  for (const job of project.scenes) {
    for (const stage of ['world', 'actors', 'tts', 'manifest'] as const)
      expect(job.stages[stage].status, `scene ${job.sceneIndex} ${stage}`).toBe('done');
    expect(job.manifestUrl).toBe(`/projects/${project.id}/scene-${job.sceneIndex}/manifest.json`);

    const res = await request.get(job.manifestUrl!);
    expect(res.ok()).toBe(true);
    const manifest = SceneManifest.parse(await res.json());
    expect(manifest.projectId).toBe(project.id);
    expect(manifest.plan.index).toBe(job.sceneIndex);
    expect(manifest.world.provider).toBe('mock');
    expect(manifest.actors.length).toBe(manifest.plan.characterIds.length);
    expect(manifest.audio.length).toBe(manifest.plan.dialogue.length);
    expect(job.heading).toBe(manifest.plan.heading);
    headings.push(manifest.plan.heading);

    // asset paths are project-root relative (shared/schema.ts)
    const root = `/projects/${project.id}/`;
    const assets = [
      manifest.world.spz.k500,
      ...manifest.audio.map((a) => a.url),
      ...(manifest.world.thumbnail ? [manifest.world.thumbnail] : []),
    ];
    for (const rel of assets) {
      const asset = await request.get(root + rel);
      expect(asset.status(), rel).toBe(200);
      expect((await asset.body()).byteLength, rel).toBeGreaterThan(100);
    }
    if (job.thumbnailUrl) expect((await request.get(job.thumbnailUrl)).status()).toBe(200);
  }
  expect(headings).toEqual(['EXT. CITY STREET - NIGHT', 'INT. KITCHEN - MORNING', 'EXT. ROOFTOP - DUSK']);

  // the project list knows it
  const list = (await (await request.get('/api/projects')).json()) as { id: string }[];
  expect(list.map((p) => p.id)).toContain(project.id);
});
