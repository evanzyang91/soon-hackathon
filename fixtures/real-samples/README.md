# Real-key samples (WP D)

Produced once on 2026-10-24 through the real code paths (`server/pipeline/tts.ts`,
`server/pipeline/actors.ts`) with the keys in `.env.local`. Tests never read these files; they
show what the real providers return.

| File | What | Committed |
| --- | --- | --- |
| `s1-l1.mp3` | OpenAI `gpt-4o-mini-tts`, voice `coral`, line "Did you hear that? Somebody's on the stairs." with parenthetical `(whispering)`. MPEG-2 Layer III, 24 kHz mono. `tts.ts` measured 3.360 s; macOS `afinfo` agrees (3.360000 s). | yes (54 KB) |
| `reference.png` | Actor reference for MAYA ("early thirties, short dark curly hair, mustard-yellow raincoat over a grey hoodie, dark jeans, white canvas sneakers"), 1024x1536, prompt = `referencePrompt()` in actors.ts. The account rejects `gpt-image-1` ("does not exist"), so the fallback chain produced it with `gpt-image-1.5` (quality `medium`, 13.8 s). | no (2.1 MB, see `.gitignore`) |
| `reference-512.jpg` | 512 px JPEG preview of `reference.png`. | yes |

The LHM stage was then run on this reference on a real Modal L4 (after billing was enabled):
480 s wall clock including the download, of which 162 s in the L4 worker, about $0.075 of GPU.
It produced 72 frames at 12 fps (48 idle + 24 talk, 40,000 splats each): 226 MB as full PLYs,
49 MB slim (`frame_000.ply` + the `motion.u16` track + metadata). The slim avatar is kept in the
actors library (`data/actors-library/maya/`, gitignored) so later live projects reuse it instead
of paying again. See worker/README.md for the stage-by-stage timings.
