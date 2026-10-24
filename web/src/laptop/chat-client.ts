// Project chat client (shared/chat.ts, routes in shared/api.ts): the `ChatApi` the chat panel
// talks to, its fetch implementation, and the image preparation every attachment goes through
// before upload. `FakeChatApi` (chat-fake.ts) implements the same interface in memory for
// `?fakechat=1` and unit tests.
import { api } from '@shared/api';
import type { Attachment, ChatRequest, ProjectChat } from '@shared/chat';
import type { ProjectStatus, ScreenplayPlan } from '@shared/schema';
import {
  confirmChatAction,
  createDraftProject,
  createProject,
  generateProject,
  getChat,
  getPlan,
  listProjects,
  sendChat,
  uploadAttachment,
} from './api';
import type { ChatResponse } from '@shared/chat';

export type { ChatResponse };

export interface ChatApi {
  /** true for the in-memory fake (the panel says so in its header). */
  readonly fake: boolean;
  listProjects(): Promise<ProjectStatus[]>;
  /** The project's plan.json; call only once parse is done (it does not exist before). */
  getPlan(projectId: string): Promise<ScreenplayPlan>;
  /** URL of a project-root-relative file (an upload, a reference image). */
  fileUrl(projectId: string, file: string): string;
  /** Prepares (≤ 1600 px PNG) unless already prepared, then uploads → Attachment. */
  uploadImage(projectId: string, image: File | Blob, name?: string): Promise<Attachment>;
  getChat(projectId: string): Promise<ProjectChat>;
  send(projectId: string, req: ChatRequest): Promise<ChatResponse>;
  /** Runs a needs-confirm action; `decline` marks it skipped instead. */
  confirm(
    projectId: string,
    messageId: string,
    actionId: string,
    decline?: boolean,
  ): Promise<ChatResponse>;
  generate(projectId: string): Promise<ProjectStatus>;
  /** Chat-first project: only the parse stage runs until generate(); photos follow as a chat message. */
  createDraft(screenplay: string, title?: string): Promise<ProjectStatus>;
  /** Everything runs at once (the pre-chat Generate). */
  createProject(screenplay: string, title?: string): Promise<ProjectStatus>;
}

// ---- image preparation ------------------------------------------------------------------------

/** Long side of an uploaded image: enough for Marble and the actor reference, small to send. */
export const MAX_IMAGE_SIDE = 1600;
/** The server's upload limit (shared/api.ts). */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
/** Inputs above this are refused before decoding (a decode of a huge file can stall the tab). */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

export interface PreparedImage {
  blob: Blob;
  name: string;
  width: number;
  height: number;
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Size that fits `max` on the long side, never upscaled. */
export function fitWithin(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, max / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** "Kitchen photo.jpeg" → "Kitchen photo.png" (the bytes are re-encoded as PNG). */
export function pngName(name: string | undefined) {
  const base = (name ?? '').trim().replace(/\.[a-z0-9]{2,5}$/i, '') || 'image';
  return `${base}.png`;
}

// blobs that already went through prepareImage (uploadImage does not re-encode them)
const prepared = new WeakSet<Blob>();

/**
 * Decodes an image, downscales it to ≤ 1600 px on the long side and re-encodes it as PNG via a
 * canvas: JPEG / WebP / pasted bitmaps all become PNG, which the server and Marble want. Throws an
 * Error whose message can be shown as is.
 */
export async function prepareImage(file: Blob, name?: string): Promise<PreparedImage> {
  const label = name || (file instanceof File ? file.name : '') || 'The image';
  if (file.type && !file.type.startsWith('image/')) throw new Error(`${label} is not an image.`);
  if (file.size > MAX_INPUT_BYTES)
    throw new Error(
      `${label} is ${mb(file.size)}; images up to ${mb(MAX_INPUT_BYTES)} can be attached.`,
    );
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${label} could not be read; attach a PNG, JPEG or WebP.`);
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot resize images (no 2D canvas).');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`${label} could not be encoded as PNG.`);
  if (blob.size > MAX_UPLOAD_BYTES)
    throw new Error(
      `${label} is ${mb(blob.size)} as a ${width}×${height} PNG; the upload limit is 12 MB.`,
    );
  prepared.add(blob);
  return {
    blob,
    name: pngName(name ?? (file instanceof File ? file.name : undefined)),
    width,
    height,
  };
}

/** prepareImage, skipped for a blob it already produced. */
export async function ensurePrepared(
  image: Blob,
  name?: string,
): Promise<PreparedImage | { blob: Blob; name: string }> {
  if (prepared.has(image)) return { blob: image, name: pngName(name) };
  return prepareImage(image, name);
}

// ---- fetch implementation --------------------------------------------------------------------

export class HttpChatApi implements ChatApi {
  readonly fake = false;
  listProjects = listProjects;
  getPlan = getPlan;
  fileUrl = (id: string, file: string) =>
    /^(blob:|data:|\/|https?:)/.test(file) ? file : api.upload(id, file);
  getChat = getChat;
  send = sendChat;
  confirm = confirmChatAction;
  generate = generateProject;
  createDraft = createDraftProject;
  createProject = createProject;

  async uploadImage(id: string, image: File | Blob, name?: string) {
    const ready = await ensurePrepared(
      image,
      name ?? (image instanceof File ? image.name : undefined),
    );
    return uploadAttachment(id, ready.blob, ready.name);
  }
}
