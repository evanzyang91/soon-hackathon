# Previz Stage

Screenplay → Marble gaussian-splat scenes → fly on laptop, film with phone (browser only).
Read `docs/PLAN.md` first. Contracts in `shared/` are the source of truth; propose changes to
them in your report instead of editing them.

## Commands

- `pnpm install`
- `pnpm dev` — HTTPS server (tsx watch) + Vite on https://localhost:5173 (phone URL printed + QR)
- `pnpm typecheck` · `pnpm e2e` (Playwright, MOCK=1) · `pnpm check` (both)
- No unit-test files: the project is evaluated by the e2e run and by rendered evidence
  (screenshots / contact sheets in `docs/images/`), not by vitest cases.

## Conventions

- TypeScript strict, ESM, 2-space, single quotes, no semicolons-debate: prettier config in package.json.
- three ^0.186 + @sparkjsdev/spark ^2.4. Marble SPZ needs `rotation.x = Math.PI` (OpenCV → Y up).
- Server is Node 24 + `tsx`; no framework beyond `ws` and the built-in `http`/`https`.
- Secrets only from `.env` via `server/env.ts`; never log key values.
- `MOCK=1` must make every stage succeed offline using `fixtures/`.
- Put temporary files in the session scratchpad, not in the repo.
