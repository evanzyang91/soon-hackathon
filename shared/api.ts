// HTTP API between the browsers and server/index.ts. Owned by the lead.
//
// POST   /api/projects              body { title?: string, screenplay: string }  → ProjectStatus (202)
// GET    /api/projects               → ProjectStatus[]
// GET    /api/projects/:id           → ProjectStatus
// POST   /api/projects/:id/retry     body { sceneIndex: number, stage: StageName } → ProjectStatus
// POST   /api/projects/:id/actors/:characterId/rebuild  body { detail: 'standard' | 'high' } → ProjectStatus (202)
//        rebuilds one character at that detail (high ≈ 5 min per actor on Modal) and, when it
//        succeeds, rewrites every scene manifest to reference the new build; the previous build
//        stays in place until then.
// GET    /projects/:id/**            static built assets (manifests, spz, ply, mp3, glb)
// GET    /api/health                 → { ok: true, mock: boolean, keys: { marble, modal, anthropic, tts } }
// GET    /api/rooms/new              → { room: string, phoneUrl: string }   (relay)
// WS     /ws                         shared/protocol.ts
//
// GET    /api/projects/:id/scenes/:n/edits            → SceneEdits (shared/look.ts); 200 with defaults when absent
// PUT    /api/projects/:id/scenes/:n/edits            body SceneEdits (revision must match current, else 409) → SceneEdits
// POST   /api/projects/:id/scenes/:n/reprompt         body { prompt: string, selection?: { point?: Vec3, region?: {center, size, shape} },
//                                                     view?: { image: string (jpeg base64 ≤ 300 KB), position, quaternion, fovDeg, aspect } }
//                                                     → { plan: EditPlan, edits: SceneEdits }  (cheap scopes are applied and saved;
//                                                       world-regen and clarify are returned unapplied)
// POST   /api/projects/:id/scenes/:n/regen            body { plan: EditPlan['regen'] } → ProjectStatus (202; runs the world stage again)
//
// Manifest URL shape: /projects/<id>/scene-<index>/manifest.json
// Edits file:         /projects/<id>/scene-<index>/edits.json
export const api = {
  projects: '/api/projects',
  project: (id: string) => `/api/projects/${id}`,
  retry: (id: string) => `/api/projects/${id}/retry`,
  rebuildActor: (id: string, characterId: string) =>
    `/api/projects/${id}/actors/${encodeURIComponent(characterId)}/rebuild`,
  health: '/api/health',
  newRoom: '/api/rooms/new',
  ws: '/ws',
  manifest: (id: string, sceneIndex: number) => `/projects/${id}/scene-${sceneIndex}/manifest.json`,
  editsFile: (id: string, sceneIndex: number) => `/projects/${id}/scene-${sceneIndex}/edits.json`,
  edits: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/edits`,
  reprompt: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/reprompt`,
  regen: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/regen`,
} as const;
