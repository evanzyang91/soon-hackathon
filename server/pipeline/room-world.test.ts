import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Vec3, WorldAsset } from '../../shared/schema.ts';
import { applyWorldTransform, worldTransform } from '../../web/src/viewer/transform.ts';
import { generateWorld } from './marble.ts';
import {
  alignRoomWorld,
  buildRoomWorld,
  CAPTURE_DIR,
  CAPTURE_FILE,
  VIDEO_FILE,
  type RoomCapture,
} from './room-world.ts';

const capture: RoomCapture = {
  schema: 'previz.room-capture/1',
  room: {
    type: 'room',
    source: 'lidar',
    outline: [
      [-2, -3],
      [2, -3],
      [2, 1],
      [-2, 1],
    ],
    floorY: -1.3,
    ceiling: 2.5,
    area: 16,
  },
  start: { position: [1, 0.2, -2], yaw: 0.5 },
  video: { seconds: 20, bytes: 1000 },
  createdAt: '2026-10-24T18:00:00.000Z',
};

const marble: WorldAsset = {
  provider: 'marble',
  spz: { k500: 'world_500k.spz' },
  metricScaleFactor: 1.7,
  groundPlaneOffset: 0,
  opencvFrame: true,
  floorOffsetMeters: 0.3,
};

const near = (a: Vec3, b: Vec3) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 6));

describe('scanned-room alignment', () => {
  it('puts the first-frame camera where the phone stood, facing its heading, floor at y = 0', () => {
    const a = alignRoomWorld(marble, capture, 0.9);
    expect(a.source).toBe('room-scan');
    expect(a.floorOffsetMeters).toBeUndefined();
    expect(a.scaleCalibration).toMatchObject({ method: 'lidar-camera-height', confidence: 'high' });
    expect(a.scaleCalibration!.factor).toBeCloseTo(1.5 / 0.9); // real 1.5 m vs world 0.9 m
    const t = worldTransform(a);
    // the phone's scene position = anchor (start camera) + its offset at the first frame
    const anchor = a.startCamera!.position;
    const phone: Vec3 = [anchor[0] + 1, anchor[1] + 0.2, anchor[2] - 2];
    near(applyWorldTransform(t, [0, 0, 0]), phone); // Marble's source camera
    // its view direction (OpenCV +Z) turns to the phone's heading (yaw 0.5, front −Z)
    const ahead = applyWorldTransform(t, [0, 0, 1]);
    const dir = [ahead[0] - phone[0], ahead[2] - phone[2]];
    expect(Math.atan2(-dir[0]!, -dir[1]!)).toBeCloseTo(0.5, 6);
    // the world's ground under the camera (0.9 m below it, Marble metres) is the scene floor
    const groundRaw: Vec3 = [0, 0.9 / marble.metricScaleFactor, 0]; // OpenCV: +y is down
    expect(applyWorldTransform(t, groundRaw)[1]).toBeCloseTo(0, 6);
    // and the scene floor is the real floor: anchor y + the scan's floorY
    expect(anchor[1] + capture.room.floorY).toBeCloseTo(0, 6);
  });

  it('an unmeasured or implausible world keeps Marble scale but still stands at the real height', () => {
    for (const h of [null, 0.05, 9]) {
      const a = alignRoomWorld(marble, capture, h);
      expect(a.scaleCalibration).toMatchObject({ factor: 1, confidence: 'low' });
      const t = worldTransform(a);
      expect(applyWorldTransform(t, [0, 0, 0])[1]).toBeCloseTo(a.startCamera!.position[1] + 0.2, 6);
    }
  });

  it('builds from the uploaded scan (MOCK world here) and refuses without one', async () => {
    const sceneDir = await mkdtemp(join(tmpdir(), 'room-world-'));
    const logs: string[] = [];
    const args = {
      sceneDir,
      outDir: join(sceneDir, 'world.room'),
      name: 'room',
      mock: true,
      log: (m: string) => logs.push(m),
    };
    await expect(buildRoomWorld(args)).rejects.toThrow(/no room scan/);
    await mkdir(join(sceneDir, CAPTURE_DIR), { recursive: true });
    await writeFile(join(sceneDir, CAPTURE_DIR, CAPTURE_FILE), JSON.stringify(capture));
    await writeFile(join(sceneDir, CAPTURE_DIR, VIDEO_FILE), Buffer.alloc(1000));
    let videoSent = '';
    const r = await buildRoomWorld({
      ...args,
      generate: (o) => {
        videoSent = o.videoPrompt?.file ?? '';
        return generateWorld(o);
      },
    });
    expect(videoSent).toBe(join(sceneDir, 'world.room', 'room-scan.mp4'));
    expect(r.dir).toBe(args.outDir);
    expect(r.note).toMatch(/scanned room \(16\.0 m²\)/);
    const { readFile } = await import('node:fs/promises');
    const asset = JSON.parse(
      await readFile(join(args.outDir, 'world-asset.json'), 'utf8'),
    ) as WorldAsset;
    expect(asset.source).toBe('room-scan');
    expect(asset.roomAlign).toEqual({ yaw: 0.5, x: 1, z: -2 });
  });
});
