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

## Processes: kill what you start

ALWAYS KILL PROCESSES WHEN THEY ARE FINISHED BEING USED. Every server, Vite instance, Playwright run,
headless Chromium or Python worker you start for a check, a screenshot or a test must be stopped by
you before you move on or report (`kill <pid>` of the process you started, or `pkill -f "PORT=<your
port>"` / `pkill -f "E2E_PORT=<your port>"`; verify with `pgrep -fl`). On 2026-10-25 leaked test
browsers and servers from parallel agents filled the user's process table until no shell or
Terminal could start and the machine had to be restarted. Rules:
- Start a background server only when a foreground command cannot do the job, give it a port of
  your own, and keep its pid; stop it in the same task that started it (a `trap`/`finally`, not
  "later").
- At most two Playwright / e2e runs on the machine at the same time; sub-agents coordinate ports
  through the lead and never run `pnpm e2e` while another agent's run is in progress.
- Before reporting, run `pgrep -fl "chrome-headless-shell|Chrome for Testing|tsx server/index.ts|playwright"`
  and kill anything of yours that is still there; say in the report that you did.
- Never leave a GPU Chromium, a `vite` or a `tsx watch` behind in a worktree that is about to be removed.

## Conventions

- TypeScript strict, ESM, 2-space, single quotes, no semicolons-debate: prettier config in package.json.
- three ^0.186 + @sparkjsdev/spark ^2.4. Marble SPZ needs `rotation.x = Math.PI` (OpenCV → Y up).
- Server is Node 24 + `tsx`; no framework beyond `ws` and the built-in `http`/`https`.
- Secrets only from `.env` via `server/env.ts`; never log key values.
- `MOCK=1` must make every stage succeed offline using `fixtures/`.
- Put temporary files in the session scratchpad, not in the repo.
