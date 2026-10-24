# Actor worker (WP D): reference image → LHM gaussian avatar on Modal

Runs LHM (code revision `4f88aaeb`, `3DAIGC/LHM-500M-HF` weights at `dd639290`) in a pinned CUDA
image on Modal. Every GPU call checkpoints its outputs to a Volume and then returns a small
receipt, so nothing is paid for twice. Input is one generated full-body reference PNG.
Output is a frozen gaussian PLY, a looping idle/talk PLY sequence (the fallback the browser can
always play, `web/src/viewer/actors/splat-actor.ts`) and a **runtime rig**: the canonical splats
with skin weights and the SMPL-X skeleton, which the browser animates on the GPU from a shared
library of text-to-motion clips (`web/src/viewer/actors/skinned-actor.ts`; see
"Performance motion" below). `--detail high` swaps in LHM-1B-HF and fine-tunes the avatar
against its reference before any of those outputs are written ("High detail" below).

| File | Role |
| --- | --- |
| `modal_lhm.py` | GPU app `previz-stage-lhm`: `actor()` on an L4 (4 CPU, 64 GiB, 30 min timeout, `max_containers=1`, `retries=0`) |
| `modal_lhm_stage.py` | CPU-only app `previz-stage-lhm-setup`: `stage_weights()` (one-time, resumable), `audit()`, `check()` |
| `lhm_image.py` | The CUDA image, shared by both apps (pinned CUDA 12.1 / torch 2.3.0 / LHM revision) |
| `run_actor.py` | Local CLI used by `server/pipeline/actors.ts` |
| `lhm_stages/lhm_actor.py` | Runs inside the GPU container: rembg mask → Multi-HMR pose → LHM canonical inference (→ fine-tune, high detail) → frozen + animated frames → packaging |
| `lhm_stages/finetune_actor.py` | High detail: photometric fine-tune of the canonical gaussians against the reference at the source pose / camera (torch; the camera geometry is pure numpy and unit tested) |
| `lhm_stages/idle_motion.py` | Procedural SMPL-X idle/talk loop (numpy) |
| `lhm_stages/package_actor.py` | Raw LHM PLYs → avatar-local frames + `sequence.json` + motion track (numpy, no plyfile) |
| `lhm_stages/rig_export.py` | Runs inside the GPU container: canonical-state.pt + LHM's dense SMPL-X buffers → `canonical.npz` (zero-pose splats, 55-joint weights, skeleton) + LHM reference poses |
| `lhm_stages/rig_build.py` | numpy: `canonical.npz` → `rig.json` + `rig-splats.bin` (top-4 skin, rebound at the source pose, validated against LHM); runs in the worker and offline |
| `lhm_stages/rig_math.py` | FK, LBS, Spark-style dual-quaternion skinning, quaternions (numpy, shared) |
| `modal_motion.py` | GPU app `previz-stage-motion`: HY-Motion 1.0 text-to-motion on an L40S (`stage()` CPU, `generate()` GPU), run once for the library |
| `motion_library.py` | CLI: generate clips, build seamless loops (`motion-library/`), upload them to the Volume |
| `motion-library/` | The built motion library every actor ships with (`motion-library.json` + `motion-clips.bin`, 160 KB) |
| `lhm_stages/recovery.py` | Receipts, Volume checkpoint manifests, verified download |
| `lhm_stages/weights.py` | Pinned revisions, weight URLs, Volume layout |
| `tests/` | pytest for motion, packaging, recovery and the rig / motion library; `make_synthetic_actor.py` makes a synthetic actor |

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
python3 worker/run_actor.py --stage-high   # + LHM-1B-HF (6.85 GB, 48 s, ~$0.002) for --detail high
python3 worker/run_actor.py --check     # auth + CUDA image build + LHM imports + weight audit; no GPU
python3 worker/run_actor.py --image ref.png --out DIR [--mask m.png] [--frames 48] [--talk-frames 24] [--fps 12]
                            [--detail high] [--no-finetune] [--finetune-iters 600] [--finetune-seconds 100]
python3 worker/run_actor.py --recover DIR/recovery-receipt.json   # re-download; never re-runs inference
python3 worker/run_actor.py --rig DIR [DIR ...]   # add the runtime rig to finished actors (no inference)
python3 worker/motion_library.py --generate | --build [--review] | --upload    # the shared clips (once)
python3 worker/lhm_stages/rig_build.py DIR      # rebuild DIR/sequence/rig* from DIR/rig-canonical.npz
modal deploy worker/modal_lhm.py        # optional: run_actor then uses the deployed function
cd worker && python3 -m pytest -q tests
```

The last stdout line is always `RESULT {json}`. Exit codes: 0 ok, 1 failed, 2 usage,
3 = the checkpoint is still running, or a network error interrupted the download of a finished
one (call `--recover` again later; `actors.ts` polls; inference is never resubmitted).

`--stage` downloads the Volume layout below, and every phase writes a receipt under
`/cache/setup-receipts/`:

| Volume path | Source |
| --- | --- |
| `data/pretrained_models/`, `data/gfpgan/` | LHM prior archive, 18.8 GB uncompressed tar on Alibaba OSS. Stream-extracted with pinned Range + If-Match, so a rerun resumes instead of restarting. Measured 2026-10-24: 2,127 s (~9 MB/s), ~$0.075 CPU |
| `huggingface/hub/models--3DAIGC--LHM-500M-HF` | `snapshot_download` at the pinned revision |
| `huggingface/hub/models--3DAIGC--LHM-1B-HF` | `--stage-high`: the 1B checkpoint at `92372582`, same architecture with 15 instead of 5 transformer layers |
| `torch/hub/checkpoints/dinov2_vitl14_reg4_pretrain.pth`, `gfpgan/weights/GFPGANv1.3.pth`, `data/gfpgan/weights/{detection_Resnet50_Final,parsing_parsenet}.pth` | The auxiliary weights LHM loads at inference (DINOv2 backbone, GFPGAN face restoration + detection) |
| `u2net/u2net.onnx` | rembg person matte (used when no mask is sent) |

## What one GPU call does

1. **Mask.** Uses the caller's `mask.png` if given. Otherwise rembg u2net alpha > 127, largest
   component, 2 px dilation, which is LHM upstream's own fallback when SAM2 is absent. A
   generated light-grey studio reference segments cleanly. The mask box must be portrait.
2. **Pose.** Multi-HMR on the masked reference.
3. **Head crop.** The VGG head detector, restricted to the mask.
4. **Canonical inference.** LHM's own preprocessing (1.1× box, 5:3 framing, white background), then
   `model.infer_single_view(..., smplx_params=source pose)`.
5. **Upright root.** If the Multi-HMR root is within 35° of upright (`root_pose = [π,0,0]`,
   meaning SMPL-X +Y up and facing the camera), the avatar is posed with the exact upright root.
   That keeps a reference shot from slightly above from producing a leaning actor.
6. **Frames.** Frozen pose, then `--frames` idle frames and `--talk-frames` talk frames, each
   through `model.animation_infer_gs` (LHM's native SMPL-X LBS).
7. **Package.** `package_actor.py` writes `sequence/`.
8. **Runtime rig.** `rig_export.py` + `rig_build.py` write `sequence/rig.json` and
   `rig-splats.bin` (and `rig-canonical.npz`, kept in the Volume), copy the motion library from
   `/cache/motion-library` and point `sequence.json` at both. A failure here is logged in
   `result.json` (`rig.error`) and leaves a complete baked actor. The volume checkpoint manifest
   is finalized and committed before the receipt returns.

### Why procedural motion (the baked fallback)

This is the motion baked into the PLY sequence, which the browser plays only for actors without a
runtime rig (older builds, or a rig that fails to load). Rigged actors perform the HY-Motion
library instead ("Performance motion" below).

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
DIR/sequence/motion.u16             previz.actor-motion/1 track (motion.f32 with --lossless)
DIR/sequence/rig.json, rig-splats.bin   runtime rig (canonical splats + skin + skeleton), see "Formats"
DIR/sequence/motion-library.json, motion-clips.bin   the shared motion library (copied per actor)
DIR/frozen.ply                      frozen avatar, same frame as the sequence
DIR/result.json, modal-run.json     timings, VRAM, cost estimate, revisions, mask report, root delta
DIR/inference.log, mask.png, observed-mask.png, pose-input.png, estimated-joints.png,
DIR/model-input.png, head-input.png, source.png, source-pose.json, cache-links.json
```

`raw/` (the LHM camera-frame frames, including the source-pose `person-posed.ply`), `canonical-state.pt`
and `rig-canonical.npz` stay in the Volume. Download them with `--include-raw` to repackage locally
(`python3 worker/lhm_stages/package_actor.py DIR/raw DIR/sequence --idle 48 --talk 24`).

### PLY frames

Binary little-endian, one `vertex` element, all float32, in LHM `save_ply` order: `x y z nx ny
nz f_dc_0..2 opacity scale_0..2 rot_0..3`. `rot` is (w,x,y,z), opacity is a logit, and scale is
a log. This is the layout Spark and SuperSplat read. Raw LHM frames are
in the Multi-HMR camera frame (OpenCV: x right, y down, z forward, subject facing the camera).
Packaging applies Rz(π), `(x,y,z) → (−x,−y,z)`, a proper rotation (no mirror), plus a
translation measured on frame 0. That gives the **avatar-local OpenGL frame**: +Y up, the avatar
faces **−Z** (the ActorHandle forward; the caller only sets `rotation.y = yaw`), feet at y = 0,
and x/z centred on the opaque median. Units stay LHM-native (SMPL-X metres).

### `sequence.json`

Playback fields (the baked loop):

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
| `motion` | `previz.actor-motion/1` record: `file`, `dtype` (`uint16` by default, `float32` with `--lossless`), `frames`, `splats`, `channels` = `x,y,z,rot_0,rot_1,rot_2,rot_3`, `frameFiles`, `base` {file, bytes, sha256} = frame_000, `bytes`, `sha256`, `min`, `scale`, `maxAbsError`, `layout`, `plyBytes`. The payload is frame-major, then splat, then channel, little-endian; `value = code·scale + min`. Written only when every static attribute is bit-identical across frames (always true for LBS); otherwise `motionSkipped` gives the reason. The viewer reads both dtypes. |

Fields added for Previz Stage:

| Field | Value |
| --- | --- |
| `schema` | `"previz.actor-sequence/1"` |
| `avatarFrame` | `{up:[0,1,0], forward:[0,0,-1], feetY:0, centered:true, nativeCoordinates:"opencv-camera", fromNative:{rotation, translation}}`. A sequence without it is treated as raw camera frame and rotated/grounded in the browser |
| `bounds` | frame 0, avatar frame: `feetY`, `topY`, `center` [x,z], `opaqueHeight`, `opaqueMin`/`opaqueMax` (0.5th–99.5th percentile of splats with opacity > 0.5), raw `min`/`max`, `opaqueSplats` |
| `nativeHeight` | `bounds.opaqueHeight`. Faint floaters cannot set the stature. `actors.ts` re-measures it from frame_000.ply for the manifest |
| `loops` | `{idle:{start:0,count:N}, talk:{start:N,count:M}}` (talk is absent when `--talk-frames 0`) |
| `motionSource`, `rootPose`, `lowerBodyProvenance` | provenance text |
| `detail`, `model`, `finetune` | `"standard"` / `"high"`, the checkpoint, and for high the fine-tune summary (applied, iterations, source-view metrics). `actor-library.ts` reads `detail` so a refreshed library copy is reused as high detail |

Size at the defaults (48 + 24 frames, 40,000 splats, measured): 2.72 MB per PLY, 226 MB for
`sequence/` in the Volume. By default `run_actor` downloads only `sequence.json`,
`frame_000.ply` and `motion.u16` (40.3 MB), about 49 MB per actor with the metadata images;
`--all-frames` fetches every PLY. The browser uses the same three files and decodes one frame at a
time into a single SplatMesh.

## Cost / time (measured 2026-10-24, real reference `fixtures/real-samples/reference.png`)

| Run | Frames | Worker s | Wall s | Billed (Modal dashboard) |
| --- | --- | --- | --- | --- |
| debug, cold image pull | 12 + 6 | 166 | 290 (all files downloaded) | $0.074 |
| full | 48 + 24 | 162 | 480 (all 233 MB downloaded at ~0.7 MB/s) | $0.075 |
| + keyframe-only download | 12 + 6 | 139 | 182 | $0.063 |
| + portable numba cache | 12 + 6 | 96 | ~100 + recover | $0.048 |

On an L4 with LHM-500M: peak VRAM 11.9 GB. The mask step took 66 s, of which ~50 s was rembg's
pymatting numba compile on import; it is now cached in the Volume (`NUMBA_CACHE_DIR`,
`NUMBA_CPU_NAME=generic`) and takes 18 s. Multi-HMR pose ~20 s, LHM load + canonical inference
~50 s. All 72 `animation_infer_gs` frames + PLY writes take ~12 s (18 frames: 3 s), so frame
count barely moves the cost. Expect about $0.05–0.06 and 2–4 min wall per actor (the download
dominates on a slow link). Receipts estimate `seconds × (L4 $0.000222 + 4 CPU × $0.0000131 +
64 GiB × $0.00000222)` ≈ $0.00042/s, which runs ~10% under the bill because container start
isn't timed. One-time staging is CPU-only: priors 2,127 s (~$0.075), model + aux 108 s
(~$0.004).

## High detail (`--detail high`): LHM-1B + a fine-tune against the reference

The laptop's per-character **High detail (~5 min per actor)** button (`POST
/api/projects/:id/actors/:characterId/rebuild {detail: 'high'}`) runs this into
`<project>/actors/<id>/high/`; the standard build stays until the new one is ready. The outputs
are the standard ones (frozen PLY, baked sequence + motion track, runtime rig, motion library), so
the viewer needs no change.

**The two levers.** (1) LHM-1B-HF instead of LHM-500M-HF: identical config except 15 transformer
layers (still 40,000 gaussians, same SMPL-X skinning, so the rig export is unchanged); 15.0 GB
peak VRAM on the L4 (500M: 11.9 GB). On its own the larger model invents facial detail rather
than matching the photo (more detail is not more likeness), so the second lever ties the detail
back to the reference. (2) A short fine-tune (`lhm_stages/finetune_actor.py`): masked L1 + 0.2
D-SSIM, quadratic tether to the initial values, hard clamp on displacement, no densify/prune,
adapted to one view:

- *Where.* LHM's posed output is in the Multi-HMR camera frame, so rendering it with Multi-HMR's
  own intrinsics (fov 60 on the 20 %-padded, 896-px letterboxed reference, mapped back with LHM's
  j2d formula) overlays the reference: silhouette IoU 0.93 on LEO with no correction (a
  similarity fix from the silhouette boxes is applied when IoU < 0.9; below 0.6 nothing is
  changed). The render window is centred on the principal point because the rasteriser assumes it.
- *What.* The canonical attributes LHM predicted: rgb, opacity (logit), log-scale (shrink only),
  and the canonical offset (±1 cm). Posing is affine in the offset (fixed LBS weights), so
  `d posed / d offset` is measured once by finite differences through `animation_infer_gs`
  (residual 5e-7) and the loop never calls LHM: 600 Adam steps take 10 s on the L4 with LHM's own
  diff-gaussian-rasterization. The updated attributes go back into `canonical-state.pt`, and
  frozen, frames and rig are produced from them as usual.
- *Only what the photo shows.* The first version optimised every splat in the frustum: the
  reference view went from 16.1 to 29.6 dB, but turn views showed rainbow speckles on the back and
  arms (barely visible splats took arbitrary colours) and white streaks where edge splats learned
  the studio background (`docs/images/actor-detail-finetune-turns.png` shows the shipped version).
  Shipped: a splat may change only if it is the front-most surface at its pixel (camera z within
  3 cm of the rendered depth), lands inside the reference mask eroded by 4 px, and faces the
  camera (local-PCA normal, weight fading from |cos| 0.25 to 0.6); SMPL-X hand splats are excluded
  (a photo's hand pose never matches the fingers, which painted pale streaks); the background is a
  random colour each step, so edge splats must turn transparent instead of white; colours have a
  tether too. Head pixels weigh ×3.

**Measured (LEO, `the-last-bus` reference, L4):**

| Run | L4 worker s | Wall (submit → verified download) | Estimated cost | Fine-tune | Reference view PSNR / SSIM | Back view change |
| --- | --- | --- | --- | --- | --- | --- |
| dev 1, unconstrained | 153 | 210 s | $0.064 | 600 steps, 10 s, all 40k splats | 16.1 → 29.6 dB / 0.74 → 0.95 | 0.045 (speckles) |
| dev 3, shipped | 133 | 193 s | $0.055 | 600 steps, 10 s, 12.3k splats | 16.1 → 20.2 dB / 0.74 → 0.89 | 0.0016 |
| **real, through the route** | **123** | download cut by a network outage; recovered on retry in 7 s (no second GPU run) | **$0.051** | same as dev 3 | 16.1 → 20.2 dB / 0.74 → 0.89 | 0.0016 |

Real-run split: mask 4 s, Multi-HMR 18 s, LHM-1B load 44 s (6.85 GB from the Volume), canonical
inference 23 s, fine-tune 12 s, 72 frames 12 s, packaging 4 s, rig 3 s. Receipts run ~10 % under
the bill, so expect about **$0.06 and 3–4 minutes per actor** with a warm image (the button says
~5 min and ~$0.20: conservative, covering a cold image pull and a slow download). Total Modal spend
for building and verifying this: about $0.23 (1B staging $0.002, three dev runs, the real run).

**Result** (`docs/images/actor-detail-standard-vs-high.png`, same camera and frozen pose in the
bus-stop scene): visible. The face, hair and stubble are sharper and now match the reference photo
(LHM-1B alone invents a different face), and the coat's wet creases, belt and shoes come through.
The cost: front texture seen from far to the side (~60° off the reference view) shows pale
streaks at the ear and cheek and faint ones on the trousers; the back is untouched. The reference
| LHM-1B | fine-tuned triptych is `actor-detail-finetune-source.png`; ±35° and back views, LHM-1B over
fine-tuned, are `actor-detail-finetune-turns.png`. The real build is installed in
`data/projects/the-last-bus-abcb17/actors/leo/high/` and its manifest ("use standard" in the
project panel switches back without the GPU).

## Performance motion (investigation, 2026-10-24)

Goal: actors that *perform* (gestures while talking, a listening idle, sitting, walking to a
mark) instead of the baked 6 s breathing/talk loops, without getting slower or jankier.

### Findings

**(i) Runtime skinning is feasible.** LHM-500M animates with plain linear blend skinning
(`SMPLXVoxelMeshModel.transform_to_posed_verts_from_neutral_pose` at `4f88aaeb`): each of the
40,000 gaussians is one subdivided SMPL-X vertex with fixed per-vertex weights over the 55 SMPL-X
joints (`skinning_weight`; the voxel-queried weights are computed but not used). A gaussian is
warped neutral "大 pose" -> zero pose (blend of `transform_mat_neutral_pose`), gets the shape
blendshape offset, then zero pose -> target with `batch_rigid_transform` on the shaped zero-pose
joints. No pose correctives, no per-frame appearance (which is why the motion track exists at
all: colour/opacity/scale are bit-identical across frames). So the browser can reproduce LHM's
animation from: the canonical zero-pose splats, top-4 bone indices + weights per splat, and the
55-joint rest skeleton + parents. The worker already keeps `canonical-state.pt` (attrs, query
points, neutral transforms, betas) in the Volume, so MAYA and LEO can get a rig without
re-running inference (a ~1 min GPU job that loads the model for its SMPL-X buffers). Differences
from LHM: top-4 / 8-bit weights, dual-quaternion instead of linear blending (Spark's LBS mode
needs `covSplats`), and LHM's "constrain body" prior (a subset whose rotation is never posed) is
approximated. The export validates itself against `animation_infer_gs` (error report in
`rig.json`).

Spark 2.4 `SplatSkinning`: 4 bones per splat (RGBA16UI: 8-bit weight | bone << 8), up to 256
bones, dual quaternions evaluated on the GPU in the splat generator. Per frame the CPU only runs
FK for 55 joints and uploads a 4x55 float texture. Caveat found in the source:
`setBoneQuatPos` composes `rest^-1 * quat` and translates by `pos - restPos` (a rotation about the
origin), so we keep identity rests and pass the full rigid skinning transform `A_j` per bone.

**(ii) Motion source: HY-Motion 1.0, once, as a shared library.** HY-Motion 1.0 (Tencent, Dec
2025; 1.0 B DiT flow matching, Qwen3-8B + CLIP-L text encoders; weights 4.2 + 16.4 + 1.7 GB,
not gated, community licence: Tencent claims no rights in outputs, territory excludes EU/UK/KR)
outputs SMPL body rotations: root + 21 joints as 6D, root translation, 30 fps. Those 22 joints are
SMPL-X's first 22 joints in the same order, so local rotations transfer with no IK; only the root
translation is rescaled by leg length. It needs >= 26 GB VRAM, so it runs on an L40S. MoMask /
MotionGPT / MotionLCM generate HumanML3D joint *positions* (263-d features); getting SMPL-X
rotations needs SMPLify-style fitting per clip (minutes, wrist/foot twist artefacts) - more
friction for worse rotations. AMASS / Motion-X are better curated but sit behind registration
forms (no unattended download). LHM's `motion_video.tar` is dance. Because SMPL-X parameters are
body-agnostic, ~6 clips are generated once (listen idle, two talk loops, sit idle, sit talk, walk
cycle), post-processed into seamless loops, cached in the Volume and under
`data/motion-library/`, and shared by every actor. Per-actor GPU cost stays one LHM pass.

**(iii) Budget, measured before any change** (scene 0 of `fixtures/screenplay.fountain` with the
library city-street world (500k), library MAYA and LEO's avatar as THEO, GPU Chromium on an
M-series Mac):

| | Laptop 1280x720 | Phone page 844x390 |
| --- | --- | --- |
| fps median / 1% low, 12 s take | 59.9 / 59.5 (vsync cap) | 59.9 / 59.5 (vsync cap) |
| main thread busy, CPU throttled 4x | 59% (script 43%) | 65% (script 45%) |
| actor download | 86 MB (2 x 43 MB) | 86 MB: 37 s at 25 Mbit/s |

Frame rate is not the bottleneck on this GPU; the phone *download* is: a baked actor costs
13.8 s at 25 Mbit/s on its own (budget: < 10 s), and the baked loop plays at 12 fps with no
interpolation (visible stepping) and pops when idle <-> talk switches mid-loop.

### Plan chosen: (A) runtime skinning — shipped

**Worker.** `rig_export.py` loads `canonical-state.pt`, reads LHM's own dense SMPL-X buffers and
writes the zero-pose splats, all 55 skin weights and the shaped skeleton (`canonical.npz`), plus
LHM's own render of two test poses. `rig_build.py` (numpy) turns that into the browser rig:

- top-4 bones with 8-bit weights summing to 255, in Spark's skin-texture word layout;
- **rebound at the source pose**: each splat gets the inverse of its own source-pose dual-quaternion
  transform applied to LHM's exact source-pose output, so the runtime reproduces the frozen
  avatar exactly at the source pose and only drifts from LHM's 55-weight LBS as the pose moves
  away from it. Measured on MAYA / LEO (native mm, p99): source 0 / 0, talking gesture 6.6 / 7.3,
  walking stride 10 / 11, seated 28 / 40, T-pose 11 / 11. The numpy re-implementation of LHM's
  posing itself agrees with `animation_infer_gs` to 0.0003 mm / 0.00003°. Top-4 / 8-bit weights
  alone cost ≤ 3 mm; the rest is dual-quaternion vs linear blending (DQ keeps volume at elbows
  and hips, which is what the residual measures). `validation` in `rig.json` records all of it;
- the "constrain body" prior (2.7 % of splats, never rotated by LHM) is matched at the source
  pose and then rotates with its bones.

New actors get the rig in the same GPU call (+3.5 s, the model is already loaded; measured on a
real L4 run: $0.034 for 12 + 6 baked frames and the rig). Existing actors: `run_actor.py --rig
DIR` runs a ~50 s L4 job (~$0.02, no inference) or rebuilds locally for free from a downloaded
`rig-canonical.npz`. MAYA (`data/actors-library/maya`) and the bus-stop project's MAYA / LEO have
rigs installed; every pre-rig sequence keeps working unchanged.

**Motion library.** `modal_motion.py` runs HY-Motion 1.0 once on an L40S: 6 prompts x 4 seeds in
85 s (load 20 s, ~10 s per prompt for 4 seeds, peak 24.9 GB VRAM, ~$0.06), plus one re-run of two
prompts (~$0.03). `motion_library.py` makes each seed a loop: heading canonicalised to +Z; the
window whose end matches its start (pose and velocity) cut out and its seam cross-faded over
0.6 s; heading drift removed; **root motion re-derived from the feet** (foot locking: contacts are
low *and* slow in the world, the root moves opposite their velocity), which removes the
generator's own foot skate (raw HY-Motion walks skate 0.2–0.9 m/s in contact; the shipped walk
cycle 0.04 m/s); the walk keeps its forward speed separately. Seeds were reviewed on MAYA
(contact sheets per seed) and pinned in `PICK`:

| Clip | Prompt gist | Loop | Seed |
| --- | --- | --- | --- |
| `idle-listen` | stands listening, small nods and weight shifts | 6.7 s | 11 |
| `talk-1` | talks, both hands gesturing in front of the body | 6.3 s | 41 |
| `talk-2` | talks, opens both palms as if asking, lowers them | 5.0 s | 11 |
| `sit-idle` | seated, hands on thighs, looking around | 4.2 s | 41 |
| `sit-talk` | seated upright, talking with both hands | 5.2 s | 11 |
| `walk` | relaxed walk, one gait cycle (1.0 m/s source) | 1.2 s | 37 |

The built library (160 KB) is committed in `worker/motion-library/`, cached in
`data/motion-library/` (with every raw seed) and uploaded to the Volume (`/cache/motion-library`)
where `actor()` copies it into each new actor's `sequence/`.

**Viewer** (`web/src/viewer/actors/rig.ts`, pure and unit-tested; `skinned-actor.ts`): one
`SplatMesh` + `SplatSkinning` (dual quaternions). Every render frame: sample the clip (nlerp
between 30 fps frames), cross-fade 0.25 s with smoothstep, entering the new clip at its frame
closest to the current pose (no pops), damp the clip's own head turning by 60 % while there is a
look target and add the look yaw (heads turn to the speaker), open the jaw with the voice level,
FK, then ground the lowest foot joint. Silent → `idle-listen`; speaking → `talk-1` / `talk-2`
alternating per line; `setPose('sitting')` → the seated pair; `setPose('walking')` → the actor
waits 2.4 m behind its mark (along its facing) until the scene clock runs, then walks in at
~1.2 m/s (cycle x1.2 ≈ 120 steps/min), decelerating over the last 0.6 m, with the cycle's clip
time locked to the distance walked (no sliding at any speed) and phased so it arrives on the
passing frame, then settles into the idle over 0.45 s. Scene-clock driven, so laptop and phone
agree. If any rig file fails to load or verify, the baked sequence plays.

### Formats

`sequence.json` gains `rig: {schema: "previz.actor-rig/1", file: "rig.json", sha256, clips:
"motion-library.json", clipsSha256, clipNames}`; nothing else changes (older readers ignore it).

`rig.json`: `splats`, `bones` (55), `joints` (SMPL-X names), `parents`, `rest` (zero-pose joints,
SMPL-X frame: +Y up, faces +Z, native metres), `sourcePose` (root/body/jaw/hands axis-angle; the
viewer keeps the hands and jaw of the reference photo), `measure` (`nativeHeight` in the zero pose,
`soleY`, `footJointMinY`, `legLength`), `files.splats` (`rig-splats.bin`: bytes, sha256, layout),
`validation`. `rig-splats.bin` is struct-of-arrays, little-endian, 44 B/splat: centre f32x3, quat
int16x4 (x,y,z,w x 32767), scale f32x3 (linear), RGBA u8x4, skin u16x4 (weight | bone << 8).

`motion-library.json`: `schema` `previz.motion-library/1`, `fps` 30, `joints` 22, `file`,
`bytes`, `sha256`, `clips[]` (`name`, `pose` standing/sitting/walking, `speaking`, `frames`,
`offset`, `speed` m/s, `legLength`, provenance). Per clip at `offset`: frames x 22 x int16 [x,y,z,w]
local rotations (SMPL-X joints 0–21; joint 0 = global orientation), then frames x f32 [x,y,z]
in-place root offset. The viewer rescales root travel by the actor's leg length.

### Self-review gate (2026-10-24): ship

Same build, same take (scene 0 of `fixtures/screenplay.fountain`: library city-street world 500k,
library MAYA, LEO's avatar as THEO, the 4 dialogue lines), same camera, GPU Chromium (Metal) on an
M-series Mac; "before" = the baked sequences, "after" = the same actors with rigs.

| | Before (baked) | After (rig) |
| --- | --- | --- |
| Laptop 1280x720: fps median / 1% low | 59.9 / 59.5 | 59.9 / 59.5 |
| Phone page 844x390: fps median / 1% low | 59.9 / 59.5 | 59.9 / 59.5 |
| Laptop at 2x DPR + orbiting camera | 59.9 / 59.5 | 59.9 / 59.5 |
| Main thread busy, laptop / phone page | 28 % / 27 % (script 20 / 19 %) | 15 % / 15 % (script 3 / 4 %) |
| ... with the CPU throttled 4x | 47 % / 49 % (script 34 / 35 %) | 27 % / 18 % (script 5 / 5 %) |
| Actor pose updates per second | 12 (frame stepping) | 60 (render rate) |
| Download, two actors | 86.3 MB | 4.1 MB (2.05 MB per actor) |
| Phone at 25 Mbit/s: actor files done | 37.0 s (33.7 s window) | 10.5 s, before the 3D view is ready (10.6 s) |
| Motion | 6 s breathing + 2 s talk loop, standing only | 6 clips, gestures, listening, seated, walk-in |

Frame rate was already at the vsync cap on this GPU and stays there; the CPU cost per frame drops
5-7x (no 40,000-splat decode and repack per frame: Spark skins on the GPU from a 55-bone texture)
and the download drops 21x, which is what took the phone from 34 s to under the 10 s budget per
actor (~0.7 s per actor on an idle 25 Mbit/s link). Visual review (contact sheets at 1 fps, 50 ms
strips of every transition, close-ups of every clip, front / side / three-quarter):

- loop seams: the wrap step equals an ordinary frame step for every clip; no pops at idle ⇄ talk
  (pose-matched entry + smoothstep fade, `docs/images/perf-motion-transitions.png`);
- feet: planted in idle and talk (foot-locked roots, lowest foot grounded every frame); the walk
  is distance-locked and stops on the passing frame (`perf-motion-walk-stop.png`);
- no jitter (render-rate interpolation; no single-frame spikes in any clip), no tearing at joints;
- gestures read as conversation; heads stay on the partner.

Evidence: `docs/images/perf-motion-{before,after}-{laptop,phone}.png` (12 frames, 1 fps),
`perf-motion-{before,after}-phone.webm`, `perf-motion-walk-to-mark.png` / `perf-motion-walk.webm`,
`perf-motion-walk-stop.png`, `perf-motion-transitions.png`, `perf-motion-library.png`.

Caveats: a long coat (LEO) stretches into fuzz at the hips when seated: LHM skins clothing to
the body, and the seated clips bend the hips 90° (MAYA's hip-length jacket is clean). Seated
actors sit on nothing; the walk-in path ignores the collider (an actor can start inside a wall);
the jaw opens with voice amplitude, not visemes; the phone GPU itself was not measured (only the
844x390 page on the Mac); the motion clips come from HY-Motion's community licence (Tencent claims
no rights in outputs; the licence excludes the EU, UK and South Korea).

## Verification status

- **Verified on a real L4** (4 runs, 2026-10-24): rembg mask (portrait box, 25% area); Multi-HMR
  root 1.9° from upright, so the upright root was used; LHM canonical inference; per-frame
  `animation_infer_gs` idle/talk loop; in-worker packaging (feet at 0, 40,000 splats,
  `nativeHeight` 1.81 native units); checkpoint manifest `complete`; verified download. A local DNS
  failure during one wait was recovered with `--recover` (the detached call finished remotely,
  with no re-inference).
- **Verified in the browser:** the real 72-frame avatar renders upright, facing -Z, scaled to
  1.7 m, at ~60 fps next to a mannequin (Chrome with Metal); the idle loop plays frames 0–47, the
  talk loop frames 48–71 while speaking, and it returns to idle after `speak()` (3.36 s line →
  3.36 s).
- Also verified: Modal auth and the CUDA image build; `--check`; weight staging; packaging,
  motion and recovery under pytest; the synthetic-sequence browser check
  (`npx tsx scripts/actor-browser-check.ts`).
- **Runtime rig, verified:** export on a real L4 for MAYA and LEO (no inference) and inside a new
  actor run; LHM-exactness of the reference posing; the rig, motion library and viewer under
  pytest / vitest; the browser check on a rigged avatar
  (`npx tsx scripts/actor-browser-check.ts --sequence data/actors-library/maya --gpu`); the gate
  above.
- **High detail, verified:** LHM-1B staging; three real L4 runs plus one through the rebuild route
  (above); the fine-tune's camera geometry under pytest (`tests/test_finetune.py`); the network
  retry path for real (a DNS outage during the download → retry recovered the checkpoint).
- Not verified: phone (iOS Safari) frame rate with 40,000-splat actors.

# Prop worker: a picture of an object → TripoSR → a .glb (Modal)

"Generate from a description…" (Scene › Background › Add prop; `server/pipeline/props.ts`) draws
the object with the OpenAI image API (the object alone, centred, full view, plain white
background, soft studio light, no text, photoreal, 1024×1024), then turns that picture into a
mesh here.

| File | Role |
| --- | --- |
| `modal_prop.py` | GPU app `previz-stage-prop`: `prop()` on an L4 (4 CPU, 16 GiB, 15 min timeout, `max_containers=1`, `retries=0`), `check()` CPU only; Volume `previz-stage-prop-cache` holds the weights (`HF_HOME`, `U2NET_HOME`) |
| `run_prop.py` | Local CLI used by `props.ts`: `--image ref.png --out model.glb [--report run.json]`, `--check` |
| `prop_glb.py` | numpy only: TripoSR's frame → glTF (y up, front +z), outward winding, area-weighted normals, linear vertex colours, a rough non-metallic material, the GLB container; `python3 worker/prop_glb.py` self-checks |

**Model: TripoSR** (VAST-AI-Research/TripoSR at `107cefd`, MIT; weights `stabilityai/TripoSR` at
`5b52193`, MIT). It was picked for speed and for an image that needs no compiler: one feed-forward
pass (well under a second of GPU time), 1.7 GB of weights, plain PyTorch. The textured
alternatives paint a texture with a diffusion stage (minutes per object, compiled rasterisers, a
much heavier image) and some carry licences with territorial exclusions. The trade-off is
TripoSR's look: a vertex-coloured mesh from marching cubes, softer than a textured asset, with the
back of the object guessed.

One call: rembg (u2net) cuts the object out → TripoSR's own foreground resize to 85 % on mid grey
→ TripoSR → marching cubes at 256³ through scikit-image (a stand-in for the `torchmcubes` CUDA
extension, same vertex order) → pieces under 5 % of the largest dropped → decimated to ≤ 50,000
triangles (fast-simplification) → colours queried from the reconstruction at the kept vertices →
`prop_glb.py`. The function returns the GLB (and the cut-out it used, saved next to it as
`cutout.png`); nothing is checkpointed, because a re-run is cheap.

```sh
python3 worker/run_prop.py --check                         # auth + image build + imports (CPU only)
python3 worker/run_prop.py --image ref.png --out model.glb --report run.json
modal deploy worker/modal_prop.py                          # optional: run_prop then uses the deployed function
```

**Cost / time** (measured 2026-10-25, "a weathered wooden barrel", through the laptop):

| Run | Wall (Go → placed) | OpenAI picture | Waiting for the L4 | In the container (load · work) | Spend |
| --- | --- | --- | --- | --- | --- |
| 1, first ever | 258 s | 9.6 s | ~2 min image build + 10 s | 106 s (98 s with the first weight download · 4.4 s) | $0.056 + $0.033 |
| 2, image and weights cached | 263 s | 9.4 s | 2.6 min | 94 s (84 s · 5.6 s) | $0.056 + $0.029 |

Run 1 came out leaning 22° toward the camera (the picture was taken from a little above), which is
why `prop_glb.level` exists. Run 2 has it (17° corrected) and a lower camera in the picture prompt.
The GPU work is about 5 s; the rest is cold start. Ways to cut it, not done: bake the weights
into the image, use a memory snapshot, or keep a container warm while the director works
(`min_containers=1`, about $0.80 an hour of L4).

Progress lines start with `[prop]` (the job's note in the laptop); the last stdout line is
`RESULT {json}` with `faces`, `vertices`, `seconds` (in the container), `wallSeconds`, `timings`
and `estimatedComputeUSD`. Auth as for the actor worker (`MODAL_TOKEN_*`, or the repo's
`.env.local`).
