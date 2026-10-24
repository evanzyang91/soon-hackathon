// WebSocket protocol between laptop (director), phone (camera) and the relay server.
// Transport: JSON text frames on wss://<host>/ws . Owned by the lead.
import { z } from 'zod';
import { Quat, Vec3 } from './schema';

/** A camera placed in the scene by the director; the phone attaches to the active one. */
export const DropCamera = z.object({
  id: z.string(),
  name: z.string(),
  position: Vec3,
  quaternion: Quat,
  fovDeg: z.number(),
});
export type DropCamera = z.infer<typeof DropCamera>;

/** Phone → relay → laptop, ≤30 Hz. */
export const PhonePose = z.object({
  type: z.literal('pose'),
  /** performance.now()-style monotonic ms on the phone. */
  t: z.number(),
  /** Orientation of the phone camera in the world frame (after re-center). */
  q: Quat,
  /** Handheld translation nudge in meters, world frame, relative to the attached camera. */
  nudge: Vec3,
  /** Vertical field of view in degrees (three.js PerspectiveCamera convention). */
  fovDeg: z.number(),
  /** Viewport width / height of the phone's render; 16:9 is assumed when absent. */
  aspect: z.number().positive().optional(),
  recording: z.boolean().default(false),
});
export type PhonePose = z.infer<typeof PhonePose>;

/** Laptop → relay → phone whenever it changes. */
export const SceneState = z.object({
  type: z.literal('scene'),
  projectId: z.string(),
  sceneIndex: z.number().int(),
  manifestUrl: z.string(),
  /** Scene clock in seconds for dynamics/dialogue sync. */
  time: z.number(),
  playing: z.boolean(),
  cameras: z.array(DropCamera),
  activeCameraId: z.string().nullable(),
  /** Dialogue line currently being spoken, if any. */
  speakingLineId: z.string().nullable(),
});
export type SceneState = z.infer<typeof SceneState>;

export const PhoneCommand = z.object({
  type: z.literal('cmd'),
  cmd: z.enum(['recenter', 'shutter', 'record-start', 'record-stop', 'next-camera']),
});
export type PhoneCommand = z.infer<typeof PhoneCommand>;

export const Hello = z.object({
  type: z.literal('hello'),
  role: z.enum(['laptop', 'phone']),
  room: z.string(), // 4–6 char code shown in the QR
});
export const Peers = z.object({
  type: z.literal('peers'),
  laptop: z.boolean(),
  phones: z.number().int(),
});

export const ClientMessage = z.discriminatedUnion('type', [Hello, PhonePose, SceneState, PhoneCommand]);
export const ServerMessage = z.discriminatedUnion('type', [Peers, PhonePose, SceneState, PhoneCommand]);
export type ClientMessage = z.infer<typeof ClientMessage>;
export type ServerMessage = z.infer<typeof ServerMessage>;
