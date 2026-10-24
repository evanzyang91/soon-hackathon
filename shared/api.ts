// HTTP API between the browsers and server/index.ts. Owned by the lead.
//
// POST   /api/projects              body { title?: string, screenplay: string }  → ProjectStatus (202)
// GET    /api/projects               → ProjectStatus[]
// GET    /api/projects/:id           → ProjectStatus
// POST   /api/projects/:id/retry     body { sceneIndex: number, stage: StageName } → ProjectStatus
// GET    /projects/:id/**            static built assets (manifests, spz, ply, mp3, glb)
// GET    /api/health                 → { ok: true, mock: boolean, keys: { marble, modal, anthropic, tts } }
// GET    /api/rooms/new              → { room: string, phoneUrl: string }   (relay)
// WS     /ws                         shared/protocol.ts
//
// Manifest URL shape: /projects/<id>/scene-<index>/manifest.json
export const api = {
  projects: '/api/projects',
  project: (id: string) => `/api/projects/${id}`,
  retry: (id: string) => `/api/projects/${id}/retry`,
  health: '/api/health',
  newRoom: '/api/rooms/new',
  ws: '/ws',
  manifest: (id: string, sceneIndex: number) => `/projects/${id}/scene-${sceneIndex}/manifest.json`,
} as const;
