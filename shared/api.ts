// HTTP API between the browsers and server/index.ts. Owned by the lead.
//
// POST   /api/projects              body { title?: string, screenplay: string, draft?: boolean }  → ProjectStatus (202)
//        draft: true runs only the parse stage and seeds the project chat (the screenplay as the
//        first user message + the assistant's plan card); the director amends the plan in the
//        chat and starts the rest with /generate. Photos for the first message are uploaded
//        after the draft exists (uploads need a project id) and sent as the next chat message.
//        Default false: everything runs (as before).
// GET    /projects/:id/plan.json     the ScreenplayPlan once parse is done (static)
// GET    /api/projects               → ProjectStatus[]
// GET    /api/projects/:id           → ProjectStatus
// POST   /api/projects/:id/retry     body { sceneIndex: number, stage: StageName } → ProjectStatus
// POST   /api/projects/:id/actors/:characterId/rebuild  body { detail: 'standard' | 'high' } → ProjectStatus (202)
//        rebuilds one character at that detail (high ≈ 5 min per actor on Modal) and, when it
//        succeeds, rewrites every scene manifest to reference the new build; the previous build
//        stays in place until then.
// GET    /projects/:id/**            static built assets (manifests, spz, ply, mp3, glb, uploads)
//
// Project chat (shared/chat.ts; the screenplay box is the first message of a conversation):
// POST   /api/projects/:id/uploads   raw image body (content-type image/png | image/jpeg | image/webp,
//                                    ≤ 12 MB, query ?name=<original file name>) → Attachment (201);
//                                    stored as uploads/<sha256-16>.<ext> (same bytes → same id),
//                                    served at /projects/:id/uploads/<file>
// GET    /api/projects/:id/chat      → ProjectChat (200; an empty thread when nothing was sent yet)
// POST   /api/projects/:id/chat      body ChatRequest { text, attachments?: [{ id, hint? }] }
//                                    → ChatResponse { chat: ProjectChat, status: ProjectStatus }
//        The server appends the user message, asks the chat planner (Claude with the images, or
//        the MOCK keyword planner) for a reply + actions, applies every free action at once
//        (plan patches, reference assignments, dialogue → TTS, actor rebuilds), returns expensive
//        ones (world regeneration: ~5 min + 1,580 credits; re-plan of a live project) as
//        needs-confirm, and appends the assistant message. Synchronous (5–20 s).
// POST   /api/projects/:id/chat/confirm  body { messageId, actionId, decline?: boolean } → ChatResponse
//        runs one needs-confirm action (the action's status becomes running / done / failed), or
//        with decline: true marks it skipped. Every status change bumps the chat revision.
// POST   /api/projects/:id/generate  → ProjectStatus (202): starts world / actors / tts for a
//                                    draft project (no-op when already generating).
// GET    /api/health                 → { ok: true, mock: boolean, keys: { marble, modal, anthropic, tts } }
// GET    /api/rooms/new              → { room: string, phoneUrl: string }   (relay)
// WS     /ws                         shared/protocol.ts
//
// GET    /api/projects/:id/scenes/:n/edits            → SceneEdits (shared/look.ts); 200 with defaults when absent
// PUT    /api/projects/:id/scenes/:n/edits            body SceneEdits (revision must match current, else 409 with
//                                                     { error, current: SceneEdits } so the client can merge) → SceneEdits
//        SceneState.look rules: the laptop sends the FULL live look while it has unsaved changes or an active
//        per-camera lens override, at ≤ 10 Hz; the phone keeps the last live look until it has fetched the
//        announced `editsRevision`, then the file is the truth.
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
  plan: (id: string) => `/projects/${id}/plan.json`,
  editsFile: (id: string, sceneIndex: number) => `/projects/${id}/scene-${sceneIndex}/edits.json`,
  edits: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/edits`,
  reprompt: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/reprompt`,
  regen: (id: string, sceneIndex: number) => `/api/projects/${id}/scenes/${sceneIndex}/regen`,
  uploads: (id: string) => `/api/projects/${id}/uploads`,
  upload: (id: string, file: string) => `/projects/${id}/${file}`,
  chat: (id: string) => `/api/projects/${id}/chat`,
  chatConfirm: (id: string) => `/api/projects/${id}/chat/confirm`,
  generate: (id: string) => `/api/projects/${id}/generate`,
} as const;
