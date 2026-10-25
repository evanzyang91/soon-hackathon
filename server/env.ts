import { config } from 'dotenv';

// .env.local wins over .env (dotenv never overrides a variable that is already set).
config({ path: '.env.local', quiet: true });
config({ path: '.env', quiet: true });

const flag = (v: string | undefined) => v === '1' || v === 'true';

export const env = {
  port: Number(process.env.PORT ?? 5173),
  mock: flag(process.env.MOCK),
  marbleModel: process.env.MARBLE_MODEL ?? 'marble-1.1',
  /** Log the Marble generate request instead of sending it; the pipeline gets the mock world. */
  marbleDryRun: flag(process.env.MARBLE_DRY_RUN),
  /** Measure each new Marble world's real scale after download (CALIBRATE=0 turns it off). */
  calibrate: process.env.CALIBRATE !== '0',
  /** The Claude-vision half of calibration (renders + 2 requests, ~$0.1/world); CALIBRATE_VISION=0 skips it. */
  calibrateVision: process.env.CALIBRATE_VISION !== '0',
  /** Stage the actors on each new live Marble world with Claude vision (staging.ts); STAGING=0 skips it. */
  staging: process.env.STAGING !== '0',
  keys: {
    marble: process.env.WLT_API_KEY ?? '',
    anthropic: process.env.ANTHROPIC_API_KEY ?? '',
    openai: process.env.OPENAI_API_KEY ?? '',
    elevenlabs: process.env.ELEVENLABS_API_KEY ?? '',
    modalTokenId: process.env.MODAL_TOKEN_ID ?? '',
    modalTokenSecret: process.env.MODAL_TOKEN_SECRET ?? '',
  },
  /** Project outputs; served at /projects/<id>/ . */
  dataDir: process.env.DATA_DIR ?? new URL('../data/projects/', import.meta.url).pathname,
  /** Pre-generated Marble worlds reused by live projects (server/pipeline/world-library.ts). */
  worldLibraryDir:
    process.env.WORLD_LIBRARY_DIR ?? new URL('../data/marble/', import.meta.url).pathname,
  /** Pre-built LHM avatars reused by live projects (server/pipeline/actor-library.ts). */
  actorsLibraryDir:
    process.env.ACTORS_LIBRARY_DIR ?? new URL('../data/actors-library/', import.meta.url).pathname,
  /**
   * Found models for background action (server/pipeline/models.ts): FOUND_MODELS=0 off, =1 on
   * (MOCK too: it downloads from Hugging Face), unset = on for live projects only.
   */
  foundModels: (process.env.FOUND_MODELS === '0' ? 'off' : flag(process.env.FOUND_MODELS) ? 'on' : 'auto') as
    | 'on'
    | 'off'
    | 'auto',
  /** Downloaded open-licence models (data/models-library/<uid>/model.glb + model.json), served at /models/. */
  modelsLibraryDir:
    process.env.MODELS_LIBRARY_DIR ?? new URL('../data/models-library/', import.meta.url).pathname,
} as const;

/** Presence only — never the values. Safe to return from /api/health. */
export const keyPresence = () => ({
  marble: !!env.keys.marble,
  modal: !!env.keys.modalTokenId || !!process.env.MODAL_PROFILE,
  anthropic: !!env.keys.anthropic,
  tts: !!env.keys.openai || !!env.keys.elevenlabs,
});
