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
- `node scripts/fix-server-native-modules.js` — recompile the **server's own** native bindings (`better-sqlite3`, `node-pty`, `bcrypt`, `sharp`, …) against the Node ABI used by the runtime. The runtime Node is read from `NODE_BINARY` in `.env` (the same value `ecosystem.config.cjs` consumes for PM2), falling back to `process.execPath`. Runs automatically via `postinstall` and is also exposed as `npm run fix:native`. **Run this after changing `NODE_BINARY` or when the server crashes on startup with `ERR_DLOPEN_FAILED: ... better_sqlite3.node`.** Mirror of `fix-plugin-native-modules.js` for the server itself.

### Dev workflow on this project

The host system default is Node 24 (`/usr/bin/node`). This project pins Node 22 via `.env` (`NODE_BINARY=/opt/node22/bin/node`), `ecosystem.config.cjs#exec_interpreter`, and the `package.json#engines` field (with a `.nvmrc` set to `22`). Before running `npm install` from a shell that defaults to Node 24, either `nvm use`, prefix with `/opt/node22/bin/npm`, or rely on the postinstall (`scripts/fix-server-native-modules.js`) which rebuilds every native binding against `.env` `NODE_BINARY` regardless of which Node invoked npm.
- `node scripts/fix-plugin-native-modules.js` — recompile native bindings (`node-pty`, `better-sqlite3`, etc.) for installed plugins under `~/.claude-code-ui/plugins/*`. Run after a Node upgrade or when a plugin crashes with "Cannot find module 'node-pty'". Accepts an optional plugin dir name (`… web-terminal`) and `--dry-run`. The install/update flows in `server/utils/plugin-loader.js` already call `npm rebuild` automatically — this script is the manual escape hatch for plugins installed before that fix. Also exposed as `npm run fix:plugin-native`.

## Build & Deploy en el VPS — cómo compilar y actualizar (NUNCA rompas esto)

> **Regla de oro:** este proyecto SIEMPRE corre en **Node 22**, sin importar qué versión de Node tenga el host. PM2, los binarios nativos (`better-sqlite3`, `node-pty`, `bcrypt`, `sharp`) y los scripts de fix deben estar alineados a Node 22. Si se desalinean, el servidor crashea con `ERR_DLOPEN_FAILED: Module did not self-register: '.../better_sqlite3.node'` y entra en bucle de reinicios.

### El problema (por qué pasa cada vez que se actualiza)

1. El VPS trae Node 24 en `/usr/bin/node`, que es el primer `node` en `PATH`.
2. PM2 sí está bien configurado (`ecosystem.config.cjs` usa `exec_interpreter: process.env.NODE_BINARY` → `/opt/node22/bin/node`), así que el **server corre en Node 22**.
3. Pero cuando alguien hace `git pull` + `npm install` desde un shell normal, ese `npm` es el de Node 24, y los módulos nativos (`better-sqlite3`, `node-pty`, `bcrypt`, `sharp`) se compilan contra el **ABI de Node 24** (modules version 137).
4. Al reiniciar, PM2 intenta cargarlos con Node 22 (ABI 127) → **`ERR_DLOPEN_FAILED`** → bucle de crash.

La pieza de defensa está en tres archivos que **deben estar en sync siempre**:
- `.env#NODE_BINARY=/opt/node22/bin/node`
- `ecosystem.config.cjs#exec_interpreter` (lee `process.env.NODE_BINARY`)
- `package.json#engines.node = ">=22.0.0 <23.0.0"` (reforzado por `.npmrc#engine-strict=true`)
- Shebang de los scripts de fix: `#!/opt/node22/bin/node` (no `#!/usr/bin/env node`)

### El camino correcto — UN solo comando

```bash
cd /opt/cloud-cli2026
./scripts/update.sh
```

Eso es todo. `scripts/update.sh` encapsula los seis pasos críticos en orden:

1. Resuelve `NODE_BINARY` (de la variable de entorno, o de `.env`, o fallback `/opt/node22/bin/node`).
2. **Antepone `/opt/node22/bin` al `PATH`** para que `npm`, `node-gyp` y cualquier subproceso usen Node 22.
3. `git pull --rebase --autostash` (skipable con `--no-pull`).
4. `npm ci` (lockfile-driven, no toca `package.json`; `engine-strict=true` aborta si el Node no es 22).
5. `npm run fix:native` (recompila nativos explícitamente, por si `postinstall` fue skipeado por `NPM_CONFIG_IGNORE_SCRIPTS`).
6. `npm run build` → `pm2 restart cloud-cli2026` → health check en `http://127.0.0.1:${SERVER_PORT}/health`. Si el HTTP no es 200, el script imprime el último log de error de PM2 y sale con código 1.

Flags útiles:
- `./scripts/update.sh --no-pull` — si ya hiciste `git pull` a mano.
- `./scripts/update.sh --no-build` — si solo cambiaste dependencias/JS sin tocar nada que requiera `dist-server/`.
- `./scripts/update.sh --no-restart` — para validar la build sin reiniciar PM2.
- `./scripts/update.sh --hard` — borra `node_modules/` antes de `npm ci` (resuelve dependencias zombi o ABI corrupto persistente).

### El camino manual (qué hace el script por dentro, para aprender)

Si por alguna razón `update.sh` no está disponible, **todos** estos pasos deben ejecutarse con Node 22 en `PATH`. El orden importa:

```bash
export PATH=/opt/node22/bin:$PATH      # 1. forzar Node 22
cd /opt/cloud-cli2026
git pull --rebase --autostash          # 2. traer el código
npm ci --no-audit --no-fund            # 3. instalar deps con el lockfile
                                      #    (postinstall recompila nativos
                                      #     contra Node 22 vía .env NODE_BINARY)
npm run fix:native                     # 4. belt-and-suspenders
npm run build                          # 5. tsc + vite → dist/, dist-server/
pm2 restart cloud-cli2026              # 6. aplicar
sleep 2 && curl http://127.0.0.1:3030/health   # 7. verificar
```

### Lo que NUNCA hay que hacer

| ❌ Anti-patrón | Por qué rompe | ✅ Correcto |
|---|---|---|
| `npm install` desde shell con `PATH` por defecto | `npm` será Node 24 → nativos contra ABI 137 | `PATH=/opt/node22/bin:$PATH npm ci` o `./scripts/update.sh` |
| `pm2 restart` sin `npm ci` previo | Si los nativos están desalineados, PM2 no los puede cargar | Siempre `npm ci` antes de reiniciar si cambió `package.json` o `package-lock.json` |
| Cambiar `.env#NODE_BINARY` sin recompilar nativos | Los `.node` quedan compilados para el Node anterior | Después de tocar `NODE_BINARY`: `npm run fix:native` + `pm2 restart` |
| Cambiar el shebang de los scripts a `#!/usr/bin/env node` | Coge el `node` de PATH (Node 24) en invocaciones directas | Mantener `#!/opt/node22/bin/node` en `scripts/fix-*.js` |
| Borrar `.npmrc` o setear `engine-strict=false` | `npm install` con Node 24 ya no aborta, compila en silencio | `.npmrc` debe tener `engine-strict=true` |

### Diagnóstico rápido (cuando algo falla)

```bash
# 1. ¿Qué Node corrió el último npm?
head -3 /opt/cloud-cli2026/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
  | xxd | head -1   # ELF header — útil para confirmar que existe

# 2. ¿El binario carga con Node 22?
/opt/node22/bin/node -e "require('better-sqlite3')(':memory:')" && echo OK

# 3. ¿Qué Node está en PATH?
which node && node -v
# Si dice v24.x.x → estás en el shell equivocado. Usa ./scripts/update.sh

# 4. ¿Qué exec_interpreter tiene PM2?
pm2 jlist | grep -oE '"exec_interpreter":"[^"]+"' | head -1
# Debe ser /opt/node22/bin/node

# 5. ¿Qué está roto en el server?
pm2 logs cloud-cli2026 --lines 50 --nostream --err
```

Si `require('better-sqlite3')` falla con `ERR_DLOPEN_FAILED`, la solución inmediata es:

```bash
PATH=/opt/node22/bin:$PATH npm run fix:native
pm2 restart cloud-cli2026
```

### Recuperación de emergencia (módulos nativos destruidos)

Si `npm run fix:native` (o cualquier `npm rebuild`) se aborta a mitad de camino — por ejemplo, porque `sharp` falló al compilar (requiere `libvips-dev` que no está instalado) — puede dejar un paquete como `better-sqlite3` con el directorio parcialmente poblado: solo `LICENSE` y `deps/`, sin `package.json` ni `lib/` ni `build/Release/*.node`. Síntomas en logs:

```
Error: Cannot find package '/opt/cloud-cli2026/node_modules/better-sqlite3/index.js'
  code: 'ERR_MODULE_NOT_FOUND'
```

O, si el binario quedó pero compilado para el ABI equivocado:

```
Error: Module did not self-register: '.../better_sqlite3.node'
  code: 'ERR_DLOPEN_FAILED'
```

Receta de recuperación (ojo: parar PM2 primero para que no entre en bucle de crash y nos impida operar):

```bash
# 1. Parar el bucle de reinicios
pm2 stop cloud-cli2026 && pm2 delete cloud-cli2026

# 2. Reconstruir TODO node_modules desde el lockfile, SIN postinstall
#    (con --ignore-scripts evitamos que se dispare el rebuild de sharp)
export PATH=/opt/node22/bin:$PATH
npm ci --no-audit --no-fund --ignore-scripts

# 3. Recompilar SOLO los 3 nativos de producción (sharp es devDependency,
#    no se usa en runtime, y rompe sin libvips-dev)
npm rebuild --build-from-source bcrypt better-sqlite3 node-pty

# 4. Validar antes de levantar el server
node -e "require('better-sqlite3')(':memory:'); console.log('OK')"
node -e "require('bcrypt'); console.log('OK')"
node -e "require('node-pty'); console.log('OK')"

# 5. Levantar PM2
pm2 start ecosystem.config.cjs
sleep 3 && curl http://127.0.0.1:3030/health
```

**Reglas duras para que el rebuild nunca destruya nada:**

1. **`sharp` nunca se compila desde fuente en este VPS** — no está en el runtime (es devDependency de Vite/image-processing), y requiere `libvips-dev` instalado vía apt. El binario precompilado de npm tampoco funciona en este host (arquitectura), así que la política es: **si el `node_modules/sharp` se rompió, simplemente se borra** con `rm -rf node_modules/sharp` y se deja que Vite lo baje cuando lo necesite (es dev-time).
2. **`npm ci --ignore-scripts` antes de cualquier `npm rebuild`** — así no se dispara el ciclo destructivo de sharp.
3. **Si una compilación nativa falla, abortar TODO** — nunca seguir con el siguiente paquete (un rebuild a medias deja el módulo sin `package.json`).
4. **Validar `require()` después de cada rebuild** — si falla, NO seguir.

El script `scripts/fix-server-native-modules.js` está siendo refactorizado para aplicar estas reglas (ver tarea #7 en el changelog).

### Resumen de una línea

> Cualquier cambio que toque código, dependencias o Node → **`./scripts/update.sh`**. Si necesitas `npm` directo, **`PATH=/opt/node22/bin:$PATH npm ...`**. Nunca `npm install` con el `PATH` por defecto del host.

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

## Source control & commit UX

The git panel (`src/components/git-panel/`) is the user-facing surface for staging, committing, and pushing. The backend endpoints live in `server/routes/git.js` (single router, ~1800 lines). The husky hooks at `.husky/commit-msg` (commitlint) and `.husky/pre-commit` (lint-staged) run for **every** `git commit`, including those spawned by the backend — there is no bypass.

### Commit message handling — auto-prefix for free-form text

The project's `commitlint.config.js` extends `@commitlint/config-conventional`, so a commit subject must start with a type (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`) followed by `:` (and optionally `(scope)`). Most users in the UI just type free-form text, so `server/routes/git.js` exposes `ensureConventionalCommitPrefix(rawMessage)`:

- If the message already starts with a recognized type prefix (case-insensitive, optional `(scope)`, with or without `!`), return it unchanged.
- Otherwise prepend `chore: ` so commitlint accepts it.

`POST /api/git/commit` calls this helper before spawning `git commit -m`. `POST /api/git/initial-commit` is unaffected (its subject is the literal `"Initial commit"`, which is already Conventional-Commits-shaped: `chore`-prefixed by the helper on the fly). Keep the regex and the type list in `CONVENTIONAL_COMMIT_TYPES` in sync with `commitlint.config.js`.

### Commit error surfacing (no more silent failures)

`POST /api/git/commit` catches the `git` spawn error and surfaces a translated 400 instead of a generic 500. The handler in `server/routes/git.js` (the `catch` of `/commit`) recognizes these stderr patterns and returns a user-readable `details` field:

- `subject may not be empty [subject-empty]` / `type may not be empty [type-empty]` from commitlint → "Commit message must follow Conventional Commits: `type(scope): subject`" with the valid type list and an example. (Only reachable if `ensureConventionalCommitPrefix` was bypassed.)
- `Please tell me who you are` / `unable to auto-detect email address` from git → "Git identity not configured" with a pointer to Settings → Git Configuration.
- `nothing to commit` → 400 with a clear "All selected files are already committed" message.

The frontend (`useGitPanelController.commitChanges`) reads `data.details` and passes `data.error` into `setOperationError(...)`, which the `GitPanelHeader` renders as a dismissable banner. The previous behavior — `console.error` and silent UI — is gone. **Never** call `console.error` for a `data.success === false` response from a git endpoint; always go through `setOperationError`.

### Git panel — don't refetch on session_upserted

The version-control panel is the only place in the app that visually re-fetched (and re-mounted `ChangesView`) every few seconds while Claude was active. Root cause: `useProjectsState` rebuilds `selectedProject` on every `session_upserted` (per-tool-call, since the provider writes a JSONL entry per tool invocation), and `useGitPanelController`'s main `useEffect` had `selectedProject` in its dep array, so it re-ran and called `fetchGitStatus()` constantly. `key={selectedProject.fullPath}` on `<ChangesView>` also re-mounted the subtree on each new object identity.

The fix lives in `src/components/git-panel/view/GitPanel.tsx`. The component wraps the incoming `selectedProject` in `useMemo` keyed on `[selectedProject?.projectId, selectedProject?.fullPath]`, returning a copy with `sessions: []` (the panel never reads them). The stabilized object is passed into `useGitPanelController`, into `useRevertLocalCommit`, and into `<ChangesView key={stableProject.fullPath} />`. From that point on, the controller's effects (which depend on `projectId`/`fullPath`) fire exactly once per real project change. To verify, add a temporary `console.log('[DEBUG-GIT-PANEL] render', Date.now())` in the component body — without the fix it logs continuously while Claude runs; with the fix it logs twice (mount + first project change) and goes quiet.

### File streaming endpoint — reject directories explicitly

`server/index.js` exposes a binary file streaming endpoint. The old code called `fs.createReadStream(resolved)` without checking whether the path was a directory, producing a mid-stream `EISDIR: illegal operation on a directory, read` and cutting the response. The fix calls `fsPromises.stat(resolved)` first and returns `400 "Path is a directory, not a file"` if `isDirectory()`. If you add new file-serving endpoints, mirror the same `stat().isFile()` guard.

### Provider log noise

Two recurring entries in the error log were noise, not real failures:

- `SDK query error: ede_diagnostic result_type=user last_content_type=n/a stop_reason=tool_use` in `server/claude-sdk.js`. The Anthropic SDK reports sessions that ended on `stop_reason: tool_use` (a normal continuation that resumes on the next user message) as `ede_diagnostic` errors. The catch now detects `/ede_diagnostic/` and demotes it to `console.warn`.
- `[Chat] Provider runtime "opencode" failed: OpenCode CLI process was terminated` in `server/modules/websocket/services/chat-websocket.service.ts`. The OpenCode CLI child gets killed whenever PM2 restarts the Node parent. The catch detects this specific message for the `opencode` provider and demotes it to `console.warn`; all other provider failures stay at `console.error`.

## Environment

- Node 22+ (`.nvmrc`). `postinstall` runs `scripts/fix-node-pty.js` to patch the native `node-pty` for the current Node ABI; if `npm install` fails on `node-pty`, this script is the first place to look.
- Vite dev server proxy assumes the backend on `SERVER_PORT` (default `3001`) and frontend on `VITE_PORT` (default `5173`); change with env vars (see `.env.example`). `HOST=0.0.0.0` exposes on the LAN; use `127.0.0.1` to lock down.
- `CONTEXT_WINDOW` (default `160000`) controls the session token-usage denominator for Claude providers.
- `CLAUDE_CLI_PATH` overrides the Claude binary name (defaults to `claude`).
- `DATABASE_PATH` overrides the SQLite file location (default `~/.cloudcli/auth.db`).
- `FS_CONCURRENCY` (default `64`) bounds parallel filesystem ops in `getFileTree` — important for NFS/SMB workspaces.

## Entry points

- npm binary: `dist-server/server/cli.js` (`cloudcli start | status | sandbox | browser-use-mcp | help | version`).
- HTTP server: `dist-server/server/index.js` (or `server/index.js` via `tsx`).
- Electron shell: `electron/main.js` (build with `npm run desktop:dist:mac` / `:win`).
- Frontend: `src/main.jsx` → `src/App.tsx`.

## Built-in MCP servers ("Managed by CloudCLI")

MCP servers whose name starts with `cloudcli-` are owned by CloudCLI itself — registered/unregistered automatically when the user toggles the corresponding feature, exposed read-only in Settings → MCP Servers with the lock badge. The pattern (codified by `modules/browser-use/`) is:

1. **Module** under `server/modules/<name>/` with `index.ts` barrel, `<name>.service.ts`, `<name>.routes.ts` (REST), `<name>-mcp.routes.ts` (HTTP bridge).
2. **Stdio MCP** at `server/<name>-mcp.ts` (top-level, not in the module folder). JSON-RPC newline-delimited, 1-second sidecar cache, `fetch` to the bridge with bearer token.
3. **Sidecar** at `~/.cloudcli/<name>/current-chat-run.json` written by `chat-run-registry.service.ts` on `startRun`, cleared on `completeRun` (read-before-delete to avoid clobbering newer runs).
4. **REST mount** in `server/index.js` before the protected routes: `app.use('/api/<name>-mcp', <name>McpRoutes)` (token-gated by `<name>Service.getMcpToken()`) and `app.use('/api/<name>', authenticateToken, <name>Routes)`.
5. **CLI subcommand** in `server/cli.js#startMcpFn()` + `case '<name>-mcp':` in the main switch.
6. **MCP registration** via `providerMcpService.addMcpServerToAllProviders({ name: 'cloudcli-<name>', scope: 'user', transport: 'stdio', command, args, env: { CLOUDCLI_<NAME>_MCP_TOKEN, CLOUDCLI_<NAME>_API_URL } })`, triggered from the service's `updateSettings({ enabled: true })`.
7. **Shutdown hook** in `server/index.js#shutdownRuntimeServices()` calls `<name>Service.stopAll()` for in-memory cleanup.
8. **Settings persistence** in `app_config` keys: `<name>_settings` (feature toggle + any extra fields you need), `<name>_mcp_token`. Domain state can live elsewhere — for `cloudcli-browser-use` it lives in SQLite and per-chat-run sidecar files; pick the storage that fits the feature.

To add a new managed MCP: copy a sibling (`browser-use` is the most complete example), pick a `cloudcli-<feature>` name, and follow the eight steps above. i18n strings `settings.mcpServers.managed.{badge,hint}` and the read-only badge UI in `src/components/mcp/view/McpServers.tsx#isManagedServer` are already in place — the prefix check is the only "magic" you need.

## Task queue (external plugin only)

CloudCLI ships **without** a native task queue. The only built-in option is the external `TadMSTR/cloudcli-plugin-task-queue` plugin, installed via Settings → Plugins.

- Separate Node subprocess, reads YAML from `~/.claude/task-queue/*.yml`, requires the `task-queue-mcp` HTTP service in `:8485` for mutations, exposes UI in a tab plugin slot. Use when you need the schema-locked YAML interop with a separate task dispatcher.

**Skill `/task-queue`** (installed at `~/.claude/skills/task-queue/SKILL.md`) teaches Claude (me) how to use the plugin.