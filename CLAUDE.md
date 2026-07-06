# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

CloudCLI (npm: `@cloudcli-ai/cloudcli`, formerly `claudecodeui`) is a web/desktop UI for Claude Code, Cursor CLI, Codex, and Gemini CLI. It is a Vite + React frontend served by an Express backend, packaged as an Electron desktop app, and shipped as a single npm binary (`cloudcli`).

## Common commands

Requires Node.js 22+ (`.nvmrc` pins `v22`). Use npm — `package.json` declares `"type": "module"` and lockfile is `package-lock.json`.

- `npm run dev` — run server (`tsx`) + Vite client together (`concurrently --kill-others`).
- `npm run client` — Vite dev server only (port `VITE_PORT`, default 5173).
- `npm run server:dev` — Express server only via `tsx` (auto-reload on file change with `server:dev-watch`).
- `npm run build` — production build of both frontend (`vite build` → `dist/`) and server (`tsc` + `tsc-alias` → `dist-server/`).
- `npm run build:client` / `npm run build:server` — build each side independently. `build:server` deletes `dist-server` first.
- `npm start` — `build` then run the compiled server (`node dist-server/server/index.js`). The `cloudcli` binary in `package.json#bin` resolves to `dist-server/server/cli.js`.
- `npm run typecheck` — `tsc --noEmit` against both `tsconfig.json` (frontend) and `server/tsconfig.json` (backend). Always run before pushing.
- `npm run lint` / `npm run lint:fix` — ESLint over `src/` and `server/` (two different configs in `eslint.config.js`).
- `npm run desktop` / `npm run desktop:dev` — launch the Electron shell. `desktop:dev` points Electron at the Vite dev server (`ELECTRON_DEV_URL=http://127.0.0.1:5173`).
- `npm run desktop:dist:mac` / `:win` — produce signed desktop installers via `electron-builder`. `npm run desktop:pack` produces an unpacked dir build.
- `npm run server:bundle` — build + run `scripts/release/build-server-bundle.js` for the npm tarball.
- `npm run release` — interactive release via `release-it` + `@release-it/conventional-changelog` (requires `GITHUB_TOKEN`).
- `node scripts/fix-node-pty.js` — postinstall for the **server's own** `node-pty` (macOS spawn-helper perms). Runs automatically via `postinstall`.
- `node scripts/fix-plugin-native-modules.js` — recompile native bindings (`node-pty`, `better-sqlite3`, etc.) for installed plugins under `~/.claude-code-ui/plugins/*`. Run after a Node upgrade or when a plugin crashes with "Cannot find module 'node-pty'". Accepts an optional plugin dir name (`… web-terminal`) and `--dry-run`. The install/update flows in `server/utils/plugin-loader.js` already call `npm rebuild` automatically — this script is the manual escape hatch for plugins installed before that fix.

### Tests

There is **no top-level `npm test`**. Tests are colocated `*.test.ts` / `*.test.js` next to the files they cover and are run with `tsx` or `node --test` (no test framework is configured in `package.json`). Run them directly, e.g.:

```bash
npx tsx --test server/modules/database/tests/projects.db.integration.test.ts
npx tsx --test server/modules/providers/tests/skills.test.ts
npx tsx --test server/modules/websocket/tests/chat-run-registry.test.ts
node --test server/services/tests/notification-orchestrator.test.js
```

Backend tests live under `server/**/tests/**`. Frontend tests are rare; one Vitest-style example is `src/components/chat/tools/components/ContentRenderers/QuestionAnswerContent.test.tsx`.

## Architecture

Two compile targets share one repo:

- **Frontend** (`src/`, Vite, TypeScript+JSX, Tailwind, React 18) — built into `dist/` and served as static files by Express.
- **Backend** (`server/`, Express, better-sqlite3, mixed JS+TS) — built by `tsc` (with `tsc-alias`) into `dist-server/`. The backend is still mostly JS — `server/tsconfig.json` enables `allowJs` with `checkJs: false` to allow incremental TS adoption.
- **`shared/`** — code used by both sides (e.g. `shared/networkHosts.js` for `getConnectableHost` / `normalizeLoopbackHost`). Imported by both `vite.config.js` and `server/index.js`.

### Path aliases

Both sides use `@/*` but resolve differently:

- Frontend (`tsconfig.json`): `@/*` → `src/*`. Vite alias matches.
- Backend (`server/tsconfig.json`): `@/*` → `server/*` (rootDir is one level up so compiled output lands under `dist-server/server/`). `tsc-alias` rewrites the imports post-build.

When writing a backend file, prefer `@/shared/...`, `@/modules/...`, `@/utils/...`. When writing a frontend file, prefer `@/components/...`, `@/contexts/...`, etc.

### Runtime wiring (`server/index.js`)

`server/index.js` is the composition root. It:

1. Reads `.env` via `./load-env.js` before importing anything else.
2. Resolves the app root with `utils/runtime-paths.js` (works for both source layout and `dist-server/` layout, and for `git` vs `npm` installs).
3. Creates one Express app + http server, then attaches **one WebSocket server** built by `modules/websocket/index.ts#createWebSocketServer`. The single `ws` server is reused for `/ws` (chat), `/shell` (PTY), and `/plugin-ws/:name` (plugin proxy). Provider spawn/abort callbacks are dependency-injected into the WebSocket module from `index.js` — the websocket module itself does not import any provider runtime.
4. Mounts REST routes. Most are protected by `middleware/auth.js#authenticateToken`; `/api/auth`, `/health`, and static files are public. The agent route uses API-key auth.
5. Initializes the SQLite database (`modules/database/index.ts`), starts `initializeSessionsWatcher()` (the provider session synchronizer watcher) and `startEnabledPluginServers()`.
6. Serves the SPA: `dist/` static files, then `app.get('*')` falls back to `dist/index.html`. Cache-Control is `no-cache` for HTML and `immutable, max-age=31536000` for hashed assets.

Vite dev server proxies `/api`, `/ws`, `/shell`, `/plugin-ws` to the backend on `SERVER_PORT` (default `3001`), so the frontend can use relative URLs.

### Backend module layout (`server/modules/`)

Modules are the unit of architecture. ESLint enforces this via `eslint-plugin-boundaries` (`eslint.config.js#boundaries/elements`):

- Each folder under `server/modules/` is one `backend-module`. Cross-module imports must go through the folder's `index.ts` / `index.js` barrel — internal files are forbidden.
- Shared contract files (`server/shared/types.ts`, `server/shared/interfaces.ts`) are value-imported only via `import type` from modules.
- Legacy files (`server/projects.js`, `server/sessionManager.js`, `server/utils/runtime-paths.js`) are explicitly classified as `backend-legacy-runtime` for the provider migration.

Current modules:

- `modules/database/` — SQLite (`better-sqlite3`). Repositories live in `repositories/` (`projects.db.ts`, `sessions.db.ts`, `users.ts`, `credentials.ts`, `api-keys.ts`, etc.). Schema in `schema.ts`, migrations in `migrations.ts`. The `db` import re-exported from `index.ts` is the canonical entry point.
- `modules/projects/` — project CRUD, clone, star, TaskMaster detection, plus the `projects-with-sessions-fetch.service.ts` that broadcasts `loading_progress` over `/ws`.
- `modules/providers/` — the **provider registry**. The full guide for adding a provider lives in `server/modules/providers/README.md`; the short version: each provider exposes `auth`, `models`, `mcp`, `skills`, `sessions`, `sessionSynchronizer` facets and lives under `list/<provider>/<provider>.*.provider.ts`. Register new providers in `provider.registry.ts` and update the type unions in both `server/shared/types.ts` and `src/types/app.ts`. Current providers: `claude`, `codex`, `cursor`, `gemini`, `opencode`.
- `modules/websocket/` — owns the single `ws` server. The README in that folder documents the message envelope, the per-run `seq` event log, the PTY lifecycle for `/shell`, and the plugin WebSocket proxy.
- `modules/notifications/` — web-push + notification preferences + notification orchestration.
- `modules/browser-use/` — Browser-Use MCP integration; owns its own routes (`browser-use.routes.ts`, `browser-use-mcp.routes.ts`) and service. **Per-chat-run session lifecycle:** each chat run gets its own auto-created `BrowserUseSession` (one per run, reused across tool calls, closed when the run completes) correlated via a sidecar file at `~/.cloudcli/browser-use/current-chat-run.json` written by `modules/websocket/services/chat-run-registry.service.ts` on `startRun` and cleared on `completeRun`. The MCP stdio server at `server/browser-use-mcp.ts` reads the sidecar with a 1s TTL cache and injects `chatRunId` into every tool call so the HTTP bridge in `browser-use-mcp.routes.ts` can resolve or auto-create the right session. **Live WebSocket broadcast:** every session mutation is pushed to the UI via three extra `GatewayEventKind` values — `browser_use_session_created`, `browser_use_session_updated`, `browser_use_session_closed` (declared in `server/shared/types.ts`, consumed by `src/components/browser-use/view/BrowserUsePanel.tsx` via `useWebSocket().subscribe`). Backward-compatible: existing MCP tools that pass `sessionId` directly keep working; the auto-management is additive.
- `modules/tasks/` — Native per-project task queue (no external dependency). Companion to Browser-Use: provides a CloudCLI-managed `cloudcli-tasks` MCP server (see pattern below). Owns `tasks.routes.ts` (REST: `/api/tasks/*` with `authenticateToken`), `tasks-mcp.routes.ts` (token-gated HTTP bridge: `/api/tasks-mcp/tools/:toolName`), and `tasks.service.ts`. Persistence is **per-project YAML** at `<projectPath>/.cloudcli/tasks/<id>.yml` (active) or `<projectPath>/.cloudcli/tasks/quarantine/<id>.yml` (quarantined); project paths are resolved through `projectsDb.getProjectPathById(projectId)` so the queue travels with the workspace. Writes use atomic `.tmp + rename` and a per-file `proper-lockfile` flock to serialize concurrent agent + operator edits. `app_config` only stores the toggle + MCP token under `tasks_settings` and `tasks_mcp_token`. The MCP stdio server at `server/tasks-mcp.ts` follows the Browser-Use pattern and exposes 9 tools: `tasks_list`, `tasks_get`, `tasks_create`, `tasks_update_status`, `tasks_approve`, `tasks_cancel`, `tasks_quarantine`, `tasks_restore`, `tasks_delete`. The MCP server requires `projectId` on every call — agents never set it; the stdio server reads `~/.cloudcli/tasks/current-chat-run.json` (which `chat-run-registry.service.ts#writeTasksSidecar` writes on `startRun` and `clearTasksSidecar` removes on `completeRun`, now including the DB-assigned `projectId`) and injects it as `chatRunId` + `projectId` into every tool call. Live WebSocket broadcast carries `{kind: 'tasks_queue_updated', projectId, tasks, timestamp}` so the UI re-pulls when its `projectId` matches. **MCP server naming convention** (`src/components/mcp/view/McpServers.tsx`): any server whose name starts with `cloudli-` is auto-detected as managed by CloudCLI, gets the lock badge + "Gestionado por CloudCLI." subtitle (i18n strings at `settings.mcpServers.managed.{badge,hint}` in en/es/fr), and cannot be edited/deleted from the UI. Use this naming for any new managed MCP.

### Frontend layout (`src/`)

Most feature folders follow the same `view / hooks / utils / types / constants` split. Top-level structure:

- `App.tsx` wires the provider tree (`Theme → Auth → WebSocket → Plugins → TasksSettings → TaskMaster → ProtectedRoute → Router`). Router basename auto-detects reverse-proxy prefixes by inspecting `manifest.json`, the module script URL, and icon links — see `DEPLOYMENT_ASSET_DIRECTORIES` at the top of `App.tsx`.
- `components/app/AppContent.tsx` is the main shell — composes Sidebar + MainContent + CommandPalette and consumes the `useProjectsState` hook for the canonical "selected project / selected session / active tab" state.
- `contexts/` — `WebSocketContext.tsx` (chat + shell socket with subscribe/send), `AuthContext.jsx`, `ThemeContext.jsx`, `PluginsContext.tsx`, `TaskMasterContext.ts`, `PermissionContext.tsx`, `PaletteOpsContext.tsx`, `TasksSettingsContext.jsx`.
- `stores/useSessionStore.ts` — zustand-style session store (the only Zustand usage; the rest of state lives in context+hooks).
- `hooks/` — reusable hooks (`useDeviceSettings`, `useFileOpenResolver`, `useLocalStorage`, `useProjectsState`, `useSessionProtection`, `useUiPreferences`, `useVersionCheck`, `useVoiceConfig`, `useWebPush`).
- `i18n/` — `i18next` setup; locale JSONs under `i18n/locales/`. Always run new user-facing strings through `t(...)`.
- `lib/` — `voiceApi.ts`, `voicePlayer.ts`, `utils.js` (cn helper etc.).
- `utils/api.js` — the shared API client (use `api.xxx(...)` from components instead of hand-rolling `fetch`).
- `types/app.ts` — shared types including the `LLMProvider` union; must stay in sync with `server/shared/types.ts`.

## Conventions

### Conventional Commits required

`commitlint.config.js` enforces `@commitlint/config-conventional`. Husky runs `commit-msg` (commitlint) and `pre-commit` (lint-staged: `eslint` over staged `src/**` and `server/**`). Use types from CONTRIBUTING.md (`feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `chore`, `ci`, `test`, `build`). `feat` → minor bump, `fix` → patch; release-it reads commits to generate the changelog.

### Provider messages normalize to one envelope

All `/ws` server→client chat frames carry a `kind` field (either a `NormalizedMessage` kind or a gateway kind like `chat_subscribed`, `session_upserted`, `loading_progress`, `protocol_error`). Every provider run ends with exactly one `complete` message built by `createCompleteMessage()` in `server/shared/utils.ts`. The frontend should never see provider-specific event shapes.

### Sandbox boundary

Docker sandbox is an opt-in CLI command (`cloudcli sandbox ...`); it is not part of the server runtime. Templates live in `server/cli.js#SANDBOX_TEMPLATES`.

### Plugins are external processes

Plugins install via Settings → Plugins and are launched as separate Node processes; the backend reaches them via `utils/plugin-process-manager.js#getPluginPort` and the `/plugin-ws/:pluginName` proxy. The reference starter plugin lives at `plugins/starter/`.

**Native bindings.** Plugin installs use `npm install --ignore-scripts` for safety, which skips `node-gyp` for native deps like `node-pty`. `server/utils/plugin-loader.js#runNpmRebuild` runs `npm rebuild` right after install/update so those bindings exist by the time the plugin subprocess boots. If you see `Cannot find module 'node-pty'` (or similar) in `cloud-cli2026-error-*.log`, the binary is missing for the current Node ABI — fix it with `node scripts/fix-plugin-native-modules.js` (or pass the plugin dir name to scope it).

### i18n: Spanish is the default; no hardcoded English UI

The default UI language is **Spanish (`'es'`)** — set in `src/i18n/config.js#getSavedLanguage` (with `fallbackLng: 'en'`). Every user-facing string MUST go through `useTranslation()` / `t()` — never a hardcoded English literal in JSX, error messages, placeholders, aria-labels, button labels, or page chrome. When you add or change a translation key, update BOTH `src/i18n/locales/en/<ns>.json` AND `src/i18n/locales/es/<ns>.json` in the same commit (Spanish users see whatever is in `es`).

View-specific namespaces living under `settings.json` (both en + es):

- `settings.aboutTab` — Acerca de / About tab content (tagline, links, hosted CTA, Pro feature cards, license footer).
- `settings.onboarding` — first-run wizard: git step (`git.title`, `git.nameLabel`, `git.errors.*`), agents step (`agents.title`, `agents.providerTitles.<provider>`, `agents.status.*`, `agents.loginButton`), step progress (`steps.git`, `steps.agents`, `steps.required`), wizard buttons (`buttons.previous`, `buttons.next`, `buttons.saving`, `buttons.completing`, `buttons.completeSetup`, `buttons.completeFailed`).

For **curated plugins** (those listed as recommendations in `src/components/plugins/view/PluginSettingsTab.tsx#OFFICIAL_PLUGIN_RECOMMENDATIONS` and `#UNOFFICIAL_PLUGIN_RECOMMENDATIONS`), the installed `PluginCard` prefers the translated name/description from `pluginSettings.<translationKey>.name` / `.description` over the raw `plugin.displayName` / `plugin.description` from the plugin's own `manifest.json` (e.g. the project-stats plugin shows "Estadísticas del proyecto" even though its manifest is English-only). Third-party plugins without a matching recommendation still show their hardcoded manifest values.

### Security defaults

All Claude Code tools are disabled by default in the UI — users opt in via Settings. Backend API routes (except `/api/auth`, `/health`, static, and `/api/browser-use-mcp`) require `authenticateToken`. Workspace path operations (`server/utils/...`, project file APIs) must validate that resolved paths stay under the project root before any filesystem mutation.

## Environment

- Node 22+ (`.nvmrc`). `postinstall` runs `scripts/fix-node-pty.js` to patch the native `node-pty` for the current Node ABI; if `npm install` fails on `node-pty`, this script is the first place to look.
- Vite dev server proxy assumes the backend on `SERVER_PORT` (default `3001`) and frontend on `VITE_PORT` (default `5173`); change with env vars (see `.env.example`). `HOST=0.0.0.0` exposes on the LAN; use `127.0.0.1` to lock down.
- `CONTEXT_WINDOW` (default `160000`) controls the session token-usage denominator for Claude providers.
- `CLAUDE_CLI_PATH` overrides the Claude binary name (defaults to `claude`).
- `DATABASE_PATH` overrides the SQLite file location (default `~/.cloudcli/auth.db`).
- `FS_CONCURRENCY` (default `64`) bounds parallel filesystem ops in `getFileTree` — important for NFS/SMB workspaces.

## Entry points

- npm binary: `dist-server/server/cli.js` (`cloudcli start | status | sandbox | browser-use-mcp | tasks-mcp | help | version`).
- HTTP server: `dist-server/server/index.js` (or `server/index.js` via `tsx`).
- Electron shell: `electron/main.js` (build with `npm run desktop:dist:mac` / `:win`).
- Frontend: `src/main.jsx` → `src/App.tsx`.

## Built-in MCP servers ("Managed by CloudCLI")

MCP servers whose name starts with `cloudcli-` are owned by CloudCLI itself — registered/unregistered automatically when the user toggles the corresponding feature, exposed read-only in Settings → MCP Servers with the lock badge. The pattern (codified by `modules/browser-use/` and now `modules/tasks/`) is:

1. **Module** under `server/modules/<name>/` with `index.ts` barrel, `<name>.service.ts`, `<name>.routes.ts` (REST), `<name>-mcp.routes.ts` (HTTP bridge).
2. **Stdio MCP** at `server/<name>-mcp.ts` (top-level, not in the module folder). JSON-RPC newline-delimited, 1-second sidecar cache, `fetch` to the bridge with bearer token.
3. **Sidecar** at `~/.cloudcli/<name>/current-chat-run.json` written by `chat-run-registry.service.ts` on `startRun`, cleared on `completeRun` (read-before-delete to avoid clobbering newer runs).
4. **REST mount** in `server/index.js` before the protected routes: `app.use('/api/<name>-mcp', <name>McpRoutes)` (token-gated by `<name>Service.getMcpToken()`) and `app.use('/api/<name>', authenticateToken, <name>Routes)`.
5. **CLI subcommand** in `server/cli.js#startMcpFn()` + `case '<name>-mcp':` in the main switch.
6. **MCP registration** via `providerMcpService.addMcpServerToAllProviders({ name: 'cloudcli-<name>', scope: 'user', transport: 'stdio', command, args, env: { CLOUDCLI_<NAME>_MCP_TOKEN, CLOUDCLI_<NAME>_API_URL } })`, triggered from the service's `updateSettings({ enabled: true })`.
7. **Shutdown hook** in `server/index.js#shutdownRuntimeServices()` calls `<name>Service.stopAll()` for in-memory cleanup.
8. **Settings persistence** in `app_config` keys: `<name>_settings` (feature toggle + any extra fields you need), `<name>_mcp_token`. Domain state can live elsewhere — for `cloudcli-tasks` it lives as per-project YAML under `<projectPath>/.cloudcli/tasks/`.

To add a new managed MCP: copy a sibling (`browser-use` is the most complete example), pick a `cloudcli-<feature>` name, and follow the eight steps above. i18n strings `settings.mcpServers.managed.{badge,hint}` and the read-only badge UI in `src/components/mcp/view/McpServers.tsx#isManagedServer` are already in place — the prefix check is the only "magic" you need.

## Task queue (native vs plugin)

CloudCLI has **two ways** to manage queued agent tasks. They serve different needs; do not conflate:

- **Native module** `modules/tasks/` + `cloudcli-tasks` MCP — built-in, ships with CloudCLI, persists per-project YAML, exposes REST + MCP, no external process. Use when the agent needs `tasks_create` / `tasks_list` / `tasks_update_status` / `tasks_approve` / `tasks_cancel` / `tasks_quarantine` / `tasks_restore` tools available across Claude/Codex/Cursor/Gemini/OpenCode without any installation.
- **External plugin** `TadMSTR/cloudcli-plugin-task-queue` (installed via Settings → Plugins) — separate Node subprocess, reads YAML from `~/.claude/task-queue/*.yml`, requires the `task-queue-mcp` service in `:8485` for mutations. Use when you need the schema-locked YAML interop with a separate task dispatcher.

### Native module (`modules/tasks/`)

**Data model** — `Task` (`server/modules/tasks/tasks.service.ts`) is the single source of truth. Fields:

- `id` (UUID v4), `projectId` (DB-assigned `projects.project_id`; **mandatory**), `agent` (free-form role string the MCP stamps from `chatRunId`).
- Title / description / prompt + the 7-status lifecycle: `submitted → pending → approved → in_progress → completed | failed | cancelled`. Quarantined is a boolean flag encoded by the file living under `quarantine/`.
- Semantic taxonomy: `taskType` ∈ {build, deploy, fix, research, review, audit, notify, other}, `priority` ∈ {normal, high, urgent}, `riskLevel` ∈ {low, medium, high}.
- `contextRefs: string[]` (paths the agent must consult), `history: TaskHistoryEntry[]` (append-only audit log with `at`, `actor`, `role` ∈ {agent, operator}, `action` ∈ {created, status_changed, approved, cancelled, quarantined, restored, note}, optional `fromStatus`/`status`/`note`).
- Lifecycle timestamps: `createdAt`, `updatedAt`, `startedAt` (set on `running`-equivalent transition), `completedAt` (set on any terminal status).
- `createdBy` is the MCP stamp `mcp:chat-run:<uuid>` so we can correlate the agent that originally filed the task.

**Storage** — One YAML file per task under `<projectPath>/.cloudcli/tasks/<id>.yml`. Quarantined tasks live in `<projectPath>/.cloudcli/tasks/quarantine/<id>.yml`. The path is **always resolved through `projectsDb.getProjectPathById(projectId)`** — the service refuses an unknown projectId with `null` rather than touching the filesystem. Writes use `yaml.dump` to a `.tmp` sibling + `fs.renameSync`, guarded by `proper-lockfile` `lock()` / `release()` with `{ retries: 8, minTimeout: 25, maxTimeout: 250 }` and `stale: 5000`. Tests live under `server/modules/tasks/tests/tasks.service.test.ts` (run with `npx tsx --tsconfig server/tsconfig.json --test …`).

**MCP surface** — `server/tasks-mcp.ts` (stdio, registered as `cloudcli-tasks`, command `cloudcli tasks-mcp`, env `CLOUDCLI_TASKS_API_URL` + `CLOUDCLI_TASKS_MCP_TOKEN`) proxies to `/api/tasks-mcp/tools/:toolName` (token-gated HTTP bridge in `tasks-mcp.routes.ts`). The 9 tools:

- `tasks_list(projectId, status?, taskType?, priority?, agent?, limit?)` — read-only, also returns per-status stats.
- `tasks_get(projectId, id)`.
- `tasks_create(projectId, agent?, title*, description?, prompt*, taskType?, riskLevel?, priority?, contextRefs?)` — the stdio server injects `projectId` + `chatRunId` from the sidecar when missing.
- `tasks_update_status(projectId, id, status, result?, error?, note?)` — records a `status_changed` history entry stamped with the operator/agent role.
- `tasks_approve`, `tasks_cancel`, `tasks_quarantine`, `tasks_restore` — operator actions with role `operator`, optional `note`.
- `tasks_delete(projectId, id)` — explicit delete (rare; usually `cancel` or `quarantine` is preferred).

**REST** — `/api/tasks/*` behind `authenticateToken` mirrors the MCP surface: `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, plus `POST /api/tasks/:id/{approve,cancel,quarantine,restore}`, `GET /api/tasks/stats?projectId=…`, `GET/PUT /api/tasks/settings`. Every endpoint requires `projectId` either as query or body — there is no global list.

**Sidecar pattern** — `chat-run-registry.service.ts#writeTasksSidecar` (called from `startRun`) writes `{ chatRunId, userId, projectId, updatedAt }` to `~/.cloudcli/tasks/current-chat-run.json`. The stdio MCP server reads it with a 1-second TTL cache (in-process) and injects `projectId` into every tool call. `clearTasksSidecar` (from `completeRun`) does a read-before-delete so a slow finish can't clobber a newer run. The `projectId` is resolved from `session.project_path → projectsDb.getProjectByPath()`.

**UI** — `src/components/task-queue/`:

- `TaskQueuePanel.tsx` is mounted by `MainContent.tsx` under the `taskQueue` tab in the **header** (NOT inside the Settings dialog — the tab is the user-facing surface). It receives `selectedProject` and calls `/api/tasks?projectId=<active>&limit=200&includeQuarantined=true`. Live updates via `subscribe(...)` filter on `message.kind === 'tasks_queue_updated' && message.projectId === selectedProject.projectId`.
- Layout mirrors the TadMSTR plugin: a compact header bar (`Task Queue  N tasks  ·  ● live  ↻`), one row of `<select>` filters (Agent / Status / Type) plus `X of Y tasks`, then sections grouped by agent (`SYSADMIN (1)` / `DEVELOPER (1)`), each containing horizontal rows with project name + status dot + status text + `<type> <title> — description` + relative time + outlined action buttons (Approve verde / Cancel rojo / Quarantine gris / Restore celeste). Clicking the title or project opens `TaskDetailModal.tsx` (history timeline + context refs + note textarea).
- **`CreateTaskModal` was removed** — the UI does not file tasks. Agents create them via MCP. The `tasks-create` entry point lives entirely on the MCP side.
- `TaskQueueSettingsTab.tsx` only exposes the toggle `Enable native task queue` (no project picker — the active project is always implicit).
- i18n namespace `taskQueue` (en + es) covers `filters.{agentLabel,statusLabel,typeLabel}`, `status.*`, `types.*`, `agents.*`, `actions.{approve,cancel,quarantine,restore,refresh,close,copy,copied,copyPath}`, `header.{live,countOf,tasksCount,tasksCount_other}`, `detail.{historyTitle,historyCreated,historyApproved,historyCancelled,historyQuarantined,historyRestored,historyNote,historyStatusChange,quarantinedBadge,noteLabel,notePlaceholder}`. `settings.tasksQueue` namespace only carries the toggle's title/description.

**Why per-project instead of global** — Tasks are filed by the agent currently running against a chat session, which already belongs to one project. Scoping storage by `projectsDb.getProjectPathById()` keeps the queue travelling with the workspace (survives projects being renamed/archived/recreated), matches how `TaskMaster` stores data under `<projectPath>/.taskmaster/`, and lets the UI filter by `selectedProject` without broadcasting cross-project.

### External plugin (`TadMSTR/cloudcli-plugin-task-queue`)

Separate Node subprocess, reads YAML from `~/.claude/task-queue/*.yml`, requires the `task-queue-mcp` HTTP service in `:8485` for mutations, exposes UI in a tab plugin slot. Use when you need the schema-locked YAML interop with a separate task dispatcher.

**Skill `/task-queue`** (installed at `~/.claude/skills/task-queue/SKILL.md`) teaches Claude (me) how to use the **plugin**. If the native module is enabled instead, prefer its MCP tools over writing YAML manually.