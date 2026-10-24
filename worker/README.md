# Actor worker (WP D): reference image → LHM gaussian avatar on Modal

A trimmed port of OrbisEngine's `worker/modal_lhm.py`. Same CUDA image, same LHM code revision
(`4f88aaeb`), same `3DAIGC/LHM-500M-HF` weights (`dd639290`), and the same rule of checkpointing
to a Volume and then returning a small receipt. Input is one generated full-body reference PNG.
Output is a frozen gaussian PLY plus a looping idle/talk PLY sequence that the browser plays
(`web/src/viewer/actors/splat-actor.ts`).

| File | Role |
| --- | --- |
| `modal_lhm.py` | GPU app `previz-stage-lhm`: `actor()` on an L4 (4 CPU, 64 GiB, 30 min timeout, `max_containers=1`, `retries=0`) |
| `modal_lhm_stage.py` | CPU-only app `previz-stage-lhm-setup`: `stage_weights()` (one-time, resumable), `audit()`, `check()` |
| `lhm_image.py` | The CUDA image, shared by both apps (exactly Orbis's pins) |
| `run_actor.py` | Local CLI used by `server/pipeline/actors.ts` |
| `lhm_stages/lhm_actor.py` | Runs inside the GPU container. Port of Orbis `lhm_person.py`: rembg mask → Multi-HMR pose → LHM canonical inference → frozen + animated frames → packaging |
| `lhm_stages/idle_motion.py` | Procedural SMPL-X idle/talk loop (numpy) |
| `lhm_stages/package_actor.py` | Raw LHM PLYs → avatar-local frames + `sequence.json` + motion track (numpy, no plyfile) |
| `lhm_stages/recovery.py` | Receipts, Volume checkpoint manifests, verified download (port of Orbis `lhm_recovery.py`) |
| `lhm_stages/weights.py` | Pinned revisions, weight URLs, Volume layout |
| `tests/` | pytest for motion, packaging and recovery; `make_synthetic_actor.py` makes a synthetic actor |

## Setup

Only the `modal` client is needed locally. Inference and packaging run remotely.

```sh
python3 -m venv worker/.venv            # optional: actors.ts prefers worker/.venv/bin/python
worker/.venv/bin/pip install modal numpy pytest
# otherwise the system python3 needs `modal` (numpy + pytest only for the tests)
```

Auth comes from `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` in the environment. If they are absent,
`run_actor.py` reads them from the repo's `.env.local` / `.env`. Values are never printed.
`server/pipeline/actors.ts` passes them from `server/env.ts` to the child process.

**L4 needs billing.** Modal refuses to create any app that contains an L4 function until the
workspace has a payment method ("Please add a payment method to use L4 GPU functions"). Until
then `actors.ts` falls back to the procedural mannequin. `--check` and `--stage` run in the
CPU-only setup app, so they work without one.

## Commands

```sh
python3 worker/run_actor.py --stage     # one time: ~22 GB into Volume previz-stage-lhm-cache (CPU only)
python3 worker/run_actor.py --check     # auth + CUDA image build + LHM imports + weight audit; no GPU
python3 worker/run_actor.py --image ref.png --out DIR [--mask m.png] [--frames 48] [--talk-frames 24] [--fps 12]
python3 worker/run_actor.py --recover DIR/recovery-receipt.json   # re-download; never re-runs inference
modal deploy worker/modal_lhm.py        # optional: run_actor then uses the deployed function
cd worker && python3 -m pytest -q tests
```

The last stdout line is always `RESULT {json}`. Exit codes: 0 ok, 1 failed, 2 usage,
3 = the checkpoint is still running (call `--recover` again later; `actors.ts` polls).

`--stage` downloads the Volume layout below, and every phase writes a receipt under
`/cache/setup-receipts/`:

| Volume path | Source |
| --- | --- |
| `data/pretrained_models/`, `data/gfpgan/` | LHM prior archive, 18.8 GB uncompressed tar on Alibaba OSS. Stream-extracted with pinned Range + If-Match, so a rerun resumes instead of restarting. Measured 2026-10-24: 2,127 s (~9 MB/s), ~$0.075 CPU |
| `huggingface/hub/models--3DAIGC--LHM-500M-HF` | `snapshot_download` at the pinned revision |
| `torch/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth`, `gfpgan/weights/GFPGANv1.3.pth`, `data/gfpgan/weights/{detection_Resnet50_Final,parsing_parsenet}.pth` | Same auxiliary weights Orbis stages |
| `u2net/u2net.onnx` | rembg person matte (used when no mask is sent) |

## What one GPU call does

1. **Mask.** Uses the caller's `mask.png` if given. Otherwise rembg u2net alpha > 127, largest
   component, 2 px dilation, which is LHM upstream's own fallback when SAM2 is absent. A
   generated light-grey studio reference segments cleanly. The mask box must be portrait.
2. **Pose.** Multi-HMR on the masked reference (verbatim from Orbis).
3. **Head crop.** The VGG head detector, restricted to the mask (verbatim from Orbis).
4. **Canonical inference.** Orbis `preprocess` (1.1× box, 5:3 framing, white background), then
   `model.infer_single_view(..., smplx_params=source pose)`.
5. **Upright root.** If the Multi-HMR root is within 35° of upright (`root_pose = [π,0,0]`,
   meaning SMPL-X +Y up and facing the camera), the avatar is posed with the exact upright root.
   That keeps a reference shot from slightly above from producing a leaning actor.
6. **Frames.** Frozen pose, then `--frames` idle frames and `--talk-frames` talk frames, each
   through `model.animation_infer_gs` (LHM's native SMPL-X LBS).
7. **Package.** `package_actor.py` writes `sequence/`; the volume checkpoint manifest is
   finalized and committed before the receipt returns.

### Why procedural motion

LHM's sample motions (`motion_video.tar`, 3.5 GB at
`https://virutalbuy-public.oss-cn-hangzhou.aliyuncs.com/share/aigc3d/data/LHM/motion_video.tar`
→ `train_data/motion_video/mimo1/smplx_params`) are reachable, but they are full-body dance clips
with root translation. That is wrong for an actor standing on a blocking mark. `idle_motion.py`
instead perturbs the reference's own Multi-HMR pose:

- **Idle:** breathing (spine pitch), weight-shift sway, a slow head turn, and arms that breathe
  with the chest.
- **Talk:** idle plus nods, a small right-arm gesture, and syllable-rhythm jaw opening (SMPL-X
  `jaw_pose` x up to 0.22 rad).

Every term is `sin(2π(k·i/N + p)) − sin(2πp)` with integer `k`, so frame 0 is exactly the source
pose (the frozen avatar) and the loop is seamless. Both loops start at the same pose, so
switching idle ↔ talk at frame 0 doesn't pop. Leg joints never move, so the feet stay planted.

## Output layout (`--out DIR`)

```
DIR/recovery-receipt.json           written BEFORE submission (status: prepared → waiting → checkpoint_available → recovered)
DIR/recovery-manifest.json          volume manifest snapshot (sizes + SHA-256 of every output)
DIR/sequence/sequence.json          see below
DIR/sequence/frame_000.ply …        avatar-local gaussian frames (idle first, then talk)
DIR/sequence/motion.u16             wander.person-motion/1 track (motion.f32 with --lossless)
DIR/frozen.ply                      frozen avatar, same frame as the sequence
DIR/result.json, modal-run.json     timings, VRAM, cost estimate, revisions, mask report, root delta
DIR/inference.log, mask.png, observed-mask.png, pose-input.png, estimated-joints.png,
DIR/model-input.png, head-input.png, source.png, source-pose.json, cache-links.json
```

`raw/` (the LHM camera-frame frames, Orbis-equivalent `person-posed.ply`) and
`canonical-state.pt` stay in the Volume. Download them with `--include-raw` to repackage locally
(`python3 worker/lhm_stages/package_actor.py DIR/raw DIR/sequence --idle 48 --talk 24`).

### PLY frames

Binary little-endian, one `vertex` element, all float32, in LHM `save_ply` order: `x y z nx ny
nz f_dc_0..2 opacity scale_0..2 rot_0..3`. `rot` is (w,x,y,z), opacity is a logit, and scale is
a log. This is the layout Orbis `gaussian-ply.ts`, Spark and SuperSplat read. Raw LHM frames are
in the Multi-HMR camera frame (OpenCV: x right, y down, z forward, subject facing the camera).
Packaging applies Rz(π), `(x,y,z) → (−x,−y,z)`, a proper rotation (no mirror), plus a
translation measured on frame 0. That gives the **avatar-local OpenGL frame**: +Y up, the avatar
faces **−Z** (the ActorHandle forward; the caller only sets `rotation.y = yaw`), feet at y = 0,
and x/z centred on the opaque median. Units stay LHM-native (SMPL-X metres).

### `sequence.json`

Fields from Orbis's person sequences, which Orbis's loader reads unchanged:

| Field | Value |
| --- | --- |
| `frame_format` | `"gaussian-ply"` |
| `frames` | `["frame_000.ply", …]`, idle frames then talk frames |
| `count`, `fps`, `duration` | `len(frames)`, e.g. `12`, `count/fps` |
| `timestamps` | `i/fps` |
| `frame_sha256` | SHA-256 of each PLY |
| `gaussiansPerFrame` | splat count (~40 k for LHM-500M) |
| `allNativeGaussianAttributesFinite`, `people_only`, `canonicalShapeFixed` | `true` |
| `coordinates` | human-readable frame description |
| `motion` | `wander.person-motion/1` record: `file`, `dtype` (`uint16` by default, `float32` with `--lossless`), `frames`, `splats`, `channels` = `x,y,z,rot_0,rot_1,rot_2,rot_3`, `frameFiles`, `base` {file, bytes, sha256} = frame_000, `bytes`, `sha256`, `min`, `scale`, `maxAbsError`, `layout`, `plyBytes`. The payload is frame-major, then splat, then channel, little-endian; `value = code·scale + min`. Written only when every static attribute is bit-identical across frames (always true for LBS); otherwise `motionSkipped` gives the reason. Orbis's viewer reads uint16 tracks only with `?motionquantize=1`; ours reads both. |

Fields added for Previz Stage:

| Field | Value |
| --- | --- |
| `schema` | `"previz.actor-sequence/1"` |
| `avatarFrame` | `{up:[0,1,0], forward:[0,0,-1], feetY:0, centered:true, nativeCoordinates:"opencv-camera", fromNative:{rotation, translation}}`. A sequence without it is treated as raw camera frame and rotated/grounded in the browser |
| `bounds` | frame 0, avatar frame: `feetY`, `topY`, `center` [x,z], `opaqueHeight`, `opaqueMin`/`opaqueMax` (0.5th–99.5th percentile of splats with opacity > 0.5), raw `min`/`max`, `opaqueSplats` |
| `nativeHeight` | `bounds.opaqueHeight`. Faint floaters cannot set the stature. `actors.ts` re-measures it from frame_000.ply for the manifest |
| `loops` | `{idle:{start:0,count:N}, talk:{start:N,count:M}}` (talk is absent when `--talk-frames 0`) |
| `motionSource`, `rootPose`, `lowerBodyProvenance` | provenance text |

Size at the defaults (48 + 24 frames, ~40 k splats): ~2.7 MB per PLY (~195 MB on disk). The
browser fetches only `frame_000.ply` + `motion.u16` (~40 MB) and decodes one frame at a time into
a single SplatMesh.

## Cost / time (estimates, not measured on GPU)

Receipts compute `seconds × (L4 $0.000222 + 4 CPU × $0.0000131 + 64 GiB × $0.00000222)` ≈
$0.00042/s, the same list prices Orbis uses. Orbis's single-frame LHM-500M runs on an L4 take a
few minutes including model load. 72 extra `animation_infer_gs` calls + PLY writes add roughly a
minute. The first call also pulls the ~15 GB image. Expect about 5–10 min and $0.15–0.25 per
actor. One-time staging is CPU-only. Measured: priors 2,127 s (~$0.075), model + aux 108 s (~$0.004).

## Verification status

- Verified: Modal auth; the CUDA image builds on Modal (pytorch3d, diff-gaussian-rasterization
  and simple-knn compile; `import torch, pytorch3d, diff_gaussian_rasterization, gsplat, rembg;
  from LHM.models import model_dict` passes); every weight is staged in Volume
  `previz-stage-lhm-cache` (`--check` reports `ready: true`); the full local
  path up to Modal's GPU refusal; packaging, motion and recovery under pytest; the browser
  playing a packaged synthetic sequence (`npx tsx scripts/actor-browser-check.ts`).
- **Not verified:** any L4 inference (`lhm_actor.py` end to end). It needs a payment method on
  the Modal workspace. The code follows Orbis's validated `lhm_person.py` call sequence line for
  line where it overlaps. New code paths that have never run on a GPU: the rembg mask, the
  upright-root swap, the per-frame `animation_infer_gs` loop with modified `body_pose` /
  `jaw_pose`, and in-worker packaging.
