// Project chat: the screenplay box is the first message of a conversation about the project.
// After it, the director amends the plan in words ("make Leo older and taller", "Maya's second
// line is 'I let it go.'", "scene 2 is a diner, not a kitchen"), attaches reference photos of the
// people and places ("this is Leo", "use this for the kitchen"), and asks for the generation to
// start. Stored per project as <project>/chat.json (ProjectChat, revisioned like edits.json) and
// served by the routes in shared/api.ts. Owned by the lead.
//
// Flow: POST chat → the user message is appended → the chat planner (server/pipeline/chat/) reads
// the plan, the thread and the attached images and answers with a reply plus typed actions →
// free actions are applied at once, expensive ones wait for POST chat/confirm → the assistant
// message (reply + actions with their status) is appended. The laptop renders the thread and the
// action cards; ProjectStatus.chatRevision tells it when to refetch.
import { z } from 'zod';

/** An uploaded image (POST /api/projects/:id/uploads). `file` is project-root-relative. */
export const Attachment = z.object({
  /** sha256 prefix of the bytes: the same picture uploaded twice is one attachment. */
  id: z.string(),
  kind: z.literal('image'),
  /** "uploads/<id>.png" — served at /projects/<projectId>/<file>. PNG, JPEG or WebP. */
  file: z.string(),
  name: z.string().optional(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().nonnegative(),
  /**
   * What the director said it is, when they said it: "character:<id>" or "scene:<index>" with
   * the 0-based ScenePlan.index (the same index the API routes and ChatAction.sceneIndex use;
   * "scene 2" in spoken text is the 1-based form the planner maps to index 1).
   */
  hint: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

export const ActionStatus = z.enum(['applied', 'needs-confirm', 'running', 'done', 'failed', 'skipped']);
export type ActionStatus = z.infer<typeof ActionStatus>;

/** What a user message changed, or proposed. `summary` is the director's-words description. */
export const ChatAction = z.discriminatedUnion('type', [
  /** A free change to plan.json (character / scene / line field). */
  z.object({
    type: z.literal('plan-patch'),
    id: z.string(),
    /** "character:leo" | "scene:1" | "line:s1-l3" | "project" */
    target: z.string(),
    /** Field path inside the target, e.g. "description", "heightMeters", "worldPrompt", "text", "voice.id". */
    field: z.string(),
    before: z.unknown().optional(),
    after: z.unknown(),
    summary: z.string(),
    status: ActionStatus,
    /** What the change triggers downstream ("rebuilds Leo", "re-voices 2 lines", "needs a new world"). */
    effect: z.string().optional(),
    note: z.string().optional(),
  }),
  /** A photo becomes a character's reference → the actor is (re)built from it. */
  z.object({
    type: z.literal('character-reference'),
    id: z.string(),
    characterId: z.string(),
    attachmentId: z.string(),
    summary: z.string(),
    status: ActionStatus,
    note: z.string().optional(),
  }),
  /** A photo becomes a scene's environment reference → the world is (re)generated from it. */
  z.object({
    type: z.literal('world-reference'),
    id: z.string(),
    sceneIndex: z.number().int().nonnegative(),
    attachmentId: z.string(),
    isPano: z.boolean().default(false),
    summary: z.string(),
    status: ActionStatus,
    /** Shown on the confirm card: "~5 min · 1,580 Marble credits". */
    cost: z.string().optional(),
    note: z.string().optional(),
  }),
  /** Regenerate a world (prompt / reference changed on a live project) — always needs-confirm. */
  z.object({
    type: z.literal('regenerate-world'),
    id: z.string(),
    sceneIndex: z.number().int().nonnegative(),
    summary: z.string(),
    status: ActionStatus,
    cost: z.string(),
    note: z.string().optional(),
  }),
  /** Rebuild an actor (description / height / reference changed). Free enough to apply at once. */
  z.object({
    type: z.literal('rebuild-actor'),
    id: z.string(),
    characterId: z.string(),
    summary: z.string(),
    status: ActionStatus,
    note: z.string().optional(),
  }),
  /** Re-voice lines (text / voice changed). Applied at once. */
  z.object({
    type: z.literal('revoice'),
    id: z.string(),
    lineIds: z.array(z.string()),
    summary: z.string(),
    status: ActionStatus,
    note: z.string().optional(),
  }),
  /** Re-run the screenplay planner on an amended screenplay (structure changes). Needs-confirm on a live project. */
  z.object({
    type: z.literal('replan'),
    id: z.string(),
    /** The amended screenplay text, when the director changed the script itself. */
    screenplay: z.string().optional(),
    summary: z.string(),
    status: ActionStatus,
    cost: z.string().optional(),
    note: z.string().optional(),
  }),
  /** Start generation of a draft project (= POST /generate). */
  z.object({
    type: z.literal('generate'),
    id: z.string(),
    summary: z.string(),
    status: ActionStatus,
    note: z.string().optional(),
  }),
]);
export type ChatAction = z.infer<typeof ChatAction>;

export const ChatMessage = z.object({
  id: z.string(),
  at: z.string(), // ISO
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  attachments: z.array(Attachment).optional(),
  /** Assistant messages: what was done / proposed, in order. */
  actions: z.array(ChatAction).optional(),
  /** Assistant messages: a compact plan summary card is shown when true (after parse / replan). */
  planCard: z.boolean().optional(),
  /** USD spent answering (planner + vision), when known. */
  costUsd: z.number().nonnegative().optional(),
  /** "claude" | "mock" — which planner answered. */
  source: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const ProjectChat = z.object({
  version: z.literal(1),
  /**
   * Bumped on EVERY change to the document: an appended message and an action's status change
   * (needs-confirm → running → done / failed) alike; mirrored into ProjectStatus.chatRevision so
   * the laptop refetches whenever it differs.
   */
  revision: z.number().int().nonnegative(),
  /**
   * A draft project's thread starts with two messages the server writes itself: the director's
   * screenplay as the first user message (full text) and the assistant's plan card reply.
   */
  messages: z.array(ChatMessage),
});
export type ProjectChat = z.infer<typeof ProjectChat>;

export const emptyChat = (): ProjectChat => ({ version: 1, revision: 0, messages: [] });

/** What POST chat and POST chat/confirm answer. */
export interface ChatResponse {
  chat: ProjectChat;
  status: import('./schema.ts').ProjectStatus;
}

export const ChatRequest = z.object({
  text: z.string().trim().max(8000),
  attachments: z.array(z.object({ id: z.string(), hint: z.string().optional() })).max(12).optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Confirms a needs-confirm action (runs it), or with `decline` marks it skipped. */
export const ChatConfirmRequest = z.object({
  messageId: z.string(),
  actionId: z.string(),
  decline: z.boolean().optional(),
});
export type ChatConfirmRequest = z.infer<typeof ChatConfirmRequest>;
