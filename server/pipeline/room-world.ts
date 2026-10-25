// "My room becomes the set": the ARKit app's room scan (video + LiDAR floor) → a Marble world of
// the real room, placed so it sits exactly over the room the phone walks in.
//
//   scene-<n>/room-capture/capture.json  RoomCapture (uploaded by the phone, free)
//   scene-<n>/room-capture/video.mp4     the scan's camera feed (≤ 100 MB, Marble's limit)
//
// Building it (paid: Marble generation, laptop only) uploads the video as a Marble video prompt.
// Marble does not document the frame of a video world; like an image prompt's world, its origin is
// taken to be the first frame's camera, looking down −Z. Then, with what ARKit measured at that
// first frame (`start`: position and heading in the scan's pose offset frame) and the LiDAR floor:
//
//   scale     = real camera height above the floor / the world's camera height above its ground
//               (the densest splat layer under the start view, calibrate-ground.ts)
//   floor     = that ground (groundPlaneOffset = the measured camera height, so y = 0 is the floor)
//   roomAlign = turn by the start heading, shift to the start position: scene frame = offset frame
//   start     = the scan's Recentre point at standing height, so a phone that restores the scan's
//               frame (the iOS app does) walks the generated room 1:1 with the real one.
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { RoomScan } from '../../shared/protocol.ts';
import { Vec3, type WorldAsset } from '../../shared/schema.ts';
import { splatGround } from './calibrate-ground.ts';
import { exists, readJson, writeJsonAtomic } from './fsutil.ts';
import { ASSET_FILE, generateWorld, MAX_VIDEO_BYTES, type GenerateWorldOptions } from './marble.ts';

export const CAPTURE_DIR = 'room-capture';
export const CAPTURE_FILE = 'capture.json';
export const VIDEO_FILE = 'video.mp4';

export const RoomCapture = z.object({
  schema: z.literal('previz.room-capture/1'),
  /** The scanned room, pose offset frame of the scan (shared/protocol.ts RoomScan). */
  room: RoomScan,
  /** The phone camera at the video's first frame, in the same frame: position and heading. */
  start: z.object({ position: Vec3, yaw: z.number() }),
  /** Seconds of video and its size (the upload itself is VIDEO_FILE). */
  video: z.object({ seconds: z.number().positive(), bytes: z.number().int().positive() }),
  createdAt: z.string(),
});
export type RoomCapture = z.infer<typeof RoomCapture>;

/** A scale outside this means the measurement (or the first-frame assumption) went wrong. */
export const SCALE_RANGE = [0.4, 2.5] as const;

/** Unit quaternion [x, y, z, w] for a yaw about +Y. */
const yawQuat = (yaw: number): [number, number, number, number] => [
  0,
  Math.sin(yaw / 2),
  0,
  Math.cos(yaw / 2),
];

/**
 * The scanned-room placement of a freshly generated world. `worldCameraHeight` is the source
 * camera's height above the world's measured ground (Marble metres, before any calibration);
 * null or implausible keeps Marble's scale and puts the camera at the real height.
 */
export function alignRoomWorld(
  asset: WorldAsset,
  capture: RoomCapture,
  worldCameraHeight: number | null,
): WorldAsset {
  const { room, start } = capture;
  const realHeight = start.position[1] - room.floorY;
  let factor = 1;
  let confidence: 'high' | 'medium' | 'low' = 'low';
  let evidence = `phone ${realHeight.toFixed(2)} m above the LiDAR floor; world ground not measured: Marble scale kept`;
  // transform.ts puts the source camera at y = groundPlaneOffset × factor (whatever Marble's
  // metric scale factor), with the floor at y = 0: so groundPlaneOffset is the camera's height
  // above the floor in the uncalibrated world, and the calibrated world has it at realHeight.
  let groundPlaneOffset = realHeight;
  if (worldCameraHeight !== null && worldCameraHeight > 0.2) {
    const f = realHeight / worldCameraHeight;
    if (f >= SCALE_RANGE[0] && f <= SCALE_RANGE[1]) {
      factor = f;
      confidence = 'high';
      evidence = `phone ${realHeight.toFixed(2)} m above the LiDAR floor at the first frame; world camera ${worldCameraHeight.toFixed(2)} m above its ground → ×${f.toFixed(3)}`;
      groundPlaneOffset = worldCameraHeight;
    } else {
      evidence = `phone ${realHeight.toFixed(2)} m vs world camera ${worldCameraHeight.toFixed(2)} m → ×${f.toFixed(2)} is implausible: Marble scale kept`;
    }
  }
  const { floorOffsetMeters: _drop, ...rest } = asset;
  return {
    ...rest,
    source: 'room-scan',
    groundPlaneOffset,
    scaleCalibration: {
      factor,
      method: 'lidar-camera-height',
      confidence,
      evidence,
      headline:
        confidence === 'high' ? `scanned room ×${factor.toFixed(2)}` : 'scanned room (unscaled)',
    },
    roomAlign: { yaw: start.yaw, x: start.position[0], z: start.position[2] },
    startCamera: {
      position: [0, Math.max(1, -room.floorY), 0],
      quaternion: yawQuat(0),
      fovDeg: 50,
    },
  };
}

/** Marks in front of a source camera (Marble frame, before alignment) where the floor is seen. */
const START_VIEW_MARKS = [
  [0, -1.2],
  [0.6, -1.8],
  [-0.6, -1.8],
  [0, -2.4],
] as const;

export async function readCapture(sceneDir: string): Promise<RoomCapture | null> {
  const file = join(sceneDir, CAPTURE_DIR, CAPTURE_FILE);
  if (!(await exists(file))) return null;
  return RoomCapture.parse(await readJson(file));
}

/**
 * Generates and aligns the scanned-room world into `outDir` (a fresh directory; ProjectStore.
 * replaceWorld swaps it in and keeps the previous world as world.prev-<k>). Returns a note.
 */
export async function buildRoomWorld(o: {
  sceneDir: string;
  outDir: string;
  name: string;
  model?: string;
  mock: boolean;
  log: (m: string) => void;
  generate?: (opts: GenerateWorldOptions) => Promise<WorldAsset>;
}): Promise<{ dir: string; note: string }> {
  const capture = await readCapture(o.sceneDir);
  if (!capture)
    throw new Error('no room scan uploaded for this scene yet (Scan room in the iPhone app)');
  const video = join(o.sceneDir, CAPTURE_DIR, VIDEO_FILE);
  const { size } = await stat(video);
  if (size > MAX_VIDEO_BYTES)
    throw new Error(`scan video is ${(size / 1e6).toFixed(0)} MB; Marble takes ≤ 100 MB`);
  await mkdir(o.outDir, { recursive: true });
  const local = join(o.outDir, 'room-scan.mp4');
  await copyFile(video, local); // the receipt dir keeps the exact video it was generated from
  const asset = await (o.generate ?? generateWorld)({
    prompt: `room-scan ${capture.createdAt} ${size}`,
    name: o.name,
    outDir: o.outDir,
    model: o.model,
    mock: o.mock,
    log: o.log,
    videoPrompt: { file: local },
  });
  const ground = await splatGround(o.outDir, asset, START_VIEW_MARKS).catch(() => null);
  // the source camera sits at y = groundPlaneOffset in the uncalibrated world (transform.ts)
  const cam =
    ground?.height !== null && ground?.height !== undefined
      ? asset.groundPlaneOffset - ground.height
      : null;
  const aligned = alignRoomWorld(asset, capture, cam);
  await writeJsonAtomic(join(o.outDir, ASSET_FILE), aligned);
  const note = `scanned room (${capture.room.area.toFixed(1)} m²): ${aligned.scaleCalibration!.evidence}`;
  o.log(note);
  return { dir: o.outDir, note };
}

/** Bytes of the uploaded scan video, or 0. */
export async function captureVideoBytes(sceneDir: string): Promise<number> {
  try {
    return (await stat(join(sceneDir, CAPTURE_DIR, VIDEO_FILE))).size;
  } catch {
    return 0;
  }
}

export const readCaptureVideo = (sceneDir: string) =>
  readFile(join(sceneDir, CAPTURE_DIR, VIDEO_FILE));
