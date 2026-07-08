# Repository Guidelines

A contributor guide for **CloudCLI**, a web/desktop UI for Claude Code, Codex, Cursor, and other AI CLIs. See `CONTRIBUTING.md` for licensing and the release process.

## Project Structure & Module Organization

- `src/` — React 18 + Vite + Tailwind frontend (components, contexts, hooks, i18n, lib, stores, types, utils).
- `server/` — Express backend in TypeScript with legacy `.js`: routes, middleware, modules, services, and CLI integrations (Claude, Codex, Cursor, Gemini).
- `shared/` — Code shared by client and server.
- `electron/` — Desktop shell (main process, windows, preload, assets).
- `database/`, `public/`, `scripts/`, `docs/`, `plugins/` — schema, static assets, build scripts, docs, optional plugins.

## Build, Test, and Development Commands

- `npm install` — Install deps. Node **>=22 <23** (see `.nvmrc`).
- `npm run dev` — Vite client + backend concurrently (recommended local workflow). Use `npm run client` or `npm run server:dev` to run one side in isolation.
- `npm run build` — Production build to `dist/` and `dist-server/`. `npm run typecheck` validates TypeScript across `src/` and `server/`.
- `npm run lint` / `npm run lint:fix` — ESLint over `src/` and `server/`.
- `npm run desktop:dev` — Launch Electron against the local Vite server.
- `npm run server:bundle` and `npm run release` — Package the server and cut a release via `release-it`.

## Coding Style & Naming Conventions

- TypeScript `strict` on both sides; `@/` maps to `src/` (frontend) or `server/` (backend).
- React components: PascalCase (`ChatPanel.tsx`); hooks start with `use`; utilities camelCase. Backend handlers use `kebab-case.{js,ts}` (e.g., `notification-orchestrator.js`).
- 2-space indent, single quotes, no trailing semicolons — match the surrounding file.
- ESLint enforces import order, unused-import removal, React Hooks rules, Tailwind class order, and module boundaries. Run `npm run lint:fix` before committing.

## Testing Guidelines

- Tests live next to the code (e.g., `src/components/chat/.../*.test.tsx`, `server/modules/sqlite/tests/*.test.ts`). Name files `*.test.{ts,tsx,js}`.
- Frontend uses Vitest; backend uses Node's built-in test runner. Run a single file with `npx vitest run <path>` or `node --test <path>`.
- Cover every bug fix and new public function or route handler. Keep tests deterministic and avoid network calls.

## Commit & Pull Request Guidelines

- Commits follow **Conventional Commits** (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, …) with an optional scope, e.g. `feat(i18n): add Japanese`. Use imperative present tense; mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- Husky runs `commitlint` on commit messages and `lint-staged` (ESLint) on staged `src/` and `server/` files.
- PRs need a clear conventional title, a what/why summary, linked issues, screenshots or recordings for UI changes, and a green `npm run build` and `npm run lint`. One feature or fix per PR.

## Agent-Specific Notes

- Prefer narrow tests (`npx vitest run <path>`) over the full suite to iterate quickly.
- Do not edit generated outputs (`dist/`, `dist-server/`) or vendored assets under `public/`.
- Native modules (`node-pty`, `better-sqlite3`, `bcrypt`) are platform-specific; run `npm run fix:native` after dependency changes if Electron or the server fails to start.
