# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

CloudCLI (npm `@cloudcli-ai/cloudcli`, formerly `claudecodeui`) is a web/desktop UI for several AI coding CLIs — Claude Code, Cursor CLI, Codex, Gemini CLI, OpenCode, Qwen Code (and a `minimax` MCP module). It is a Vite + React frontend served by an Express backend, packaged as an Electron desktop app, and shipped as a single npm binary (`cloudcli`). Repo root: `/opt/cloud-cli2026`.

## Common commands

Node.js 22 is pinned (`.nvmrc` → `22`, `.npmrc#engine-strict=true`, `package.json#engines.node = ">=22.0.0 <23.0.0"`). Use npm — `"type": "module"`, lockfile is `package-lock.json`. The host `/usr/bin/node` is Node 24, so `PATH=/opt/node22/bin:$PATH` is required for any manual install.

- `npm run dev` — server (`tsx watch`) + Vite client concurrently (`concurrently --kill-others`).
- `npm run server:dev` / `server:dev-watch` — Express server only (auto-reload on watch).
- `npm run client` — Vite dev server only (port `VITE_PORT`, default 5173).
- `npm run build` — full production build: frontend (`vite build` → `dist/`) + server (`tsc` + `tsc-alias` → `dist-server/`). `build:server` deletes `dist-server` first.
- `npm start` — `build` then run `node dist-server/server/index.js`. The `cloudcli` binary in `package.json#bin` resolves to `dist-server/server/cli.js`.
- `npm run typecheck` — `tsc --noEmit` against both `tsconfig.json` (frontend) and `server/tsconfig.json` (backend). **Run before pushing.**
- `npm run lint` / `lint:fix` — ESLint over `src/` and `server/` (single `eslint.config.js` with two configs).
- `npm run desktop` / `desktop:dev` — Electron shell; `desktop:dev` points at Vite (`ELECTRON_DEV_URL=http://127.0.0.1:5173`).
- `npm run desktop:dist:mac` / `:win` — signed installers via `electron-builder`. `:pack` → dir build only.
- `npm run release` — interactive release via `release-it` (`GITHUB_TOKEN` required).
- `npm run fix:native` → `node scripts/fix-server-native-modules.js` — recompile server natives (`better-sqlite3`, `node-pty`, `bcrypt`, `sharp`) against the ABI of `.env#NODE_BINARY`. Runs automatically via `postinstall`.
- `npm run fix:plugin-native` → `node scripts/fix-plugin-native-modules.js` — same for plugins under `~/.claude-code-ui/plugins/*`.
- `./scripts/update.sh` — single-command deploy on the VPS (see "Build & Deploy" below).

### Single-test loop

There is no `npm test`. Tests live next to the module under test (`*.test.ts`) and are run directly:

```bash
npx tsx server/modules/providers/tests/skill-state.test.ts
npx tsx server/opencode-cli.test.js
```

Use `npx playwright …` for anything under `tests/e2e/` (devDep).

## Architecture

### Frontend — `src/`

React 18 + Vite + Tailwind + CodeMirror 6 (`@uiw/react-codemirror`) + xterm.js for the integrated shell + `@xterm/...-webgl` for terminal rendering. i18n via `i18next` + `react-i18next` (locales under `src/i18n/locales/<lang>/`; default is `es`). Routing via `react-router-dom`. UI state lives in `src/stores/` (Zustand) and per-feature hooks under `src/components/<feature>/hooks/`.

Key feature areas:

- `src/components/chat/` — composer, messages pane, tool rendering. `chat/tools/configs/toolConfigs.ts` is the **single source of truth** for `toolName → React renderer`; `kind: 'tool_use'` events from every provider route through it, so the rendering is provider-agnostic.
- `src/components/settings/` — provider-level and global settings, organised by tab (`settings/view/tabs/<feature>-settings/`).
- `src/components/skills/`, `mcp/`, `git-panel/`, `file-tree/`, `code-editor/`, `prd-editor/`, `task-master/`, `plugins/`, `provider-auth/`, `voice/`, `browser-use/`, `onboarding/`, `quick-settings-panel/`.
- `src/i18n/locales/{de,en,es,fr,it,ja,ko,ru,tr,zh-CN,zh-TW}/` — translation bundles keyed by feature area.

The frontend `@/*` alias points to `src/` (configured in `vite.config.js` and root `tsconfig.json`).

### Backend — `server/`

Express + native WS (`ws`). Two layers:

1. **Top-level shims** in `server/` (`claude-sdk.js`, `openai-codex.js`, `gemini-cli.js`, `opencode-cli.js`, `cursor-cli.js`, `qwen-cli.js`, `browser-use-mcp.ts`, `voice-proxy.js`, `sessionManager.js`, `index.js`). These are the spawn/process-management entry points; `index.js` wires them all into the Express + WebSocket server. The shebang of `index.js` is `#!/usr/bin/env node`, but PM2 does not care — it uses `ecosystem.config.cjs#exec_interpreter`.
2. **Modules** under `server/modules/`:
   - `providers/` — **provider registry** (see below). Each provider lives under `list/<id>/` with five facets.
   - `minimax/` — a vertical MCP module (routes + service + tests) for the `MiniMax-M3` proxy on `https://api.minimax.io/v1`. Docs at `docs/mcp/minimax.md`.
   - `database/`, `sqlite/`, `files/` (incl. `tree-cache.js`), `projects/`, `notifications/`, `websocket/`, `browser-use/`.
3. **`server/shared/`** and top-level **`shared/`** — types and provider interfaces shared with the frontend (`server/shared/interfaces.ts` defines `IProviderAuth`, `IProviderMcp`, `IProviderSkills`, `IProviderSessions`, `IProviderSessionSynchronizer`).
4. **`server/modules/providers/README.md`** is the canonical guide for the provider contract — **read it before adding a new provider**.

### Provider facet model

Every provider is a thin wrapper exposing five readonly facets: `auth`, `mcp`, `skills`, `sessions`, `sessionSynchronizer`. Provider ids currently shipped: `claude`, `codex`, `cursor`, `gemini`, `opencode`, `qwen`. MiniMax is a configuration layer rather than a provider.

Consuming services (`providerAuthService`, `providerMcpService`, `providerSkillsService`, `sessionsService`, `sessionSynchronizerService`) live next to the registry and don't import concrete provider classes. New providers must:

- update the union in `server/shared/types.ts#LLMProvider` and `src/types/app.ts#LLMProvider`,
- appear in `provider.routes.ts` and `provider.registry.ts`,
- be wired in `server/routes/agent.js` if launchable from the chat composer,
- be added to `PROVIDER_ORDER` in `public/api-docs.html` and the UI lists (`useChatProviderState.ts`, `ProviderSelectionEmptyState.tsx`, `ProviderLoginModal.tsx`).

Capabilities & permission modes per provider (UI matrix) live in `docs/providers/agente.md`. Per-provider docs: `claude.md`, `codex.md`, `cursor.md`, `gemini.md`, `opencode.md`, `qwen.md`.

### WebSocket topology

The server mounts several WS endpoints — all proxied by Vite in dev (`/ws`, `/shell`, `/plugin-ws`) and served from the Express port in prod:

- `/ws` — chat streaming (per-session).
- `/shell` — PTY shells (Node `ws` + `node-pty`).
- `/plugin-ws` — internal plugin IPC.

### Voice

Voice (push-to-talk, read-aloud) is a thin HTTP proxy, not a provider. STT/TTS point at any OpenAI-compatible backend (OpenAI, Groq, LocalAI, Speaches, Kokoro-FastAPI, etc.). Architecture and the two modes (direct vs. `/api/voice/*` proxy) are documented in `docs/voice.md`.

### Desktop & binary

Electron shell at `electron/`. Packaging via `electron-builder` (config inline in `package.json#build`). The release tarball contains `electron/`, `server/`, `shared/`, `dist/`, `dist-server/`, `scripts/`. The CLI entrypoint is `server/cli.js`.

## Configuration & data locations

The single source of truth for env vars is `.env.example` (copy → `.env`). Important knobs:

- `NODE_BINARY=/opt/node22/bin/node` — pinned Node interpreter; **must stay in sync** with `ecosystem.config.cjs#exec_interpreter`, `package.json#engines.node`, `.nvmrc`, and the shebang of `scripts/fix-*.js` (`#!/opt/node22/bin/node`).
- `WORKSPACES_ROOT=/` — root used by `/api/browse-filesystem`. Defaults to `os.homedir()` (which collides with `FORBIDDEN_WORKSPACE_PATHS` when running as root); pin this to a non-system path.
- `SERVER_PORT`, `VITE_PORT`, `HOST` — server / Vite ports and bind address.
- `CONTEXT_WINDOW=1000000` / `VITE_CONTEXT_WINDOW=1000000` — Claude Code context window cap.
- `DATABASE_PATH` — auth SQLite (`better-sqlite3`).
- `FORBIDDEN_WORKSPACE_PATHS`, `PROVIDER_ORDER` are wired in `server/constants/`.

CLI introspection: `cloudcli status` shows where `.env` should live and the active data locations.

## Build & Deploy en el VPS — cómo compilar y actualizar (NUNCA rompas esto)

> **Regla de oro:** este proyecto SIEMPRE corre en **Node 22**, sin importar qué versión de Node tenga el host. PM2, los binarios nativos (`better-sqlite3`, `node-pty`, `bcrypt`, `sharp`) y los scripts de fix deben estar alineados a Node 22. Si se desalinean, el servidor crashea con `ERR_DLOPEN_FAILED: Module did not self-register: '.../better_sqlite3.node'` y entra en bucle de reinicios.

**El camino correcto — un solo comando:**

```bash
cd /opt/cloud-cli2026
./scripts/update.sh
```

`scripts/update.sh` resuelve `NODE_BINARY` (env var, luego `.env`, luego `/opt/node22/bin/node`), antepone `/opt/node22/bin` al `PATH`, ejecuta `git pull --rebase --autostash`, `npm ci` (`engine-strict=true` aborta si Node no es 22), `npm run fix:native` (belt-and-suspenders), `npm run build`, `pm2 restart cloud-cli2026`, y hace health-check en `http://127.0.0.1:${SERVER_PORT}/health`. Sale con código 1 si el HTTP no es 200, imprimiendo los últimos logs de error de PM2.

Flags:

- `--no-pull` — ya hiciste `git pull` a mano.
- `--no-build` — solo cambiaste deps / JS sin tocar nada que requiera `dist-server/`.
- `--no-restart` — valida la build sin tocar PM2.
- `--hard` — borra `node_modules/` antes de `npm ci` (resuelve dependencias zombi o ABI corrupto persistente).

**El camino manual** (qué hace el script por dentro) **debe** ejecutarse con Node 22 en `PATH` y en este orden:

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
sleep 2 && curl http://127.0.0.1:${SERVER_PORT}/health   # 7. verificar
```

**Anti-patrones que rompen el deploy:**

| ❌ Anti-patrón | Por qué rompe | ✅ Correcto |
|---|---|---|
| `npm install` con `PATH` por defecto | `npm` será Node 24 → nativos contra ABI 137 | `PATH=/opt/node22/bin:$PATH npm ci` o `./scripts/update.sh` |
| `pm2 restart` sin `npm ci` previo | Si los nativos están desalineados, PM2 no los puede cargar | Siempre `npm ci` antes de reiniciar si cambió `package.json` o `package-lock.json` |
| Cambiar `.env#NODE_BINARY` sin recompilar nativos | Los `.node` quedan compilados para el Node anterior | Tras tocar `NODE_BINARY`: `npm run fix:native` + `pm2 restart` |
| Cambiar el shebang de los scripts a `#!/usr/bin/env node` | Coge el `node` de PATH (Node 24) | Mantener `#!/opt/node22/bin/node` en `scripts/fix-*.js` |
| Borrar `.npmrc` o setear `engine-strict=false` | `npm install` con Node 24 ya no aborta, compila en silencio | `.npmrc` debe tener `engine-strict=true` |

**Diagnóstico rápido:**

```bash
/opt/node22/bin/node -e "require('better-sqlite3')(':memory:')" && echo OK
which node && node -v                           # si dice v24 → shell equivocado, usa ./scripts/update.sh
pm2 jlist | grep -oE '"exec_interpreter":"[^"]+"' | head -1   # debe ser /opt/node22/bin/node
pm2 logs cloud-cli2026 --lines 50 --nostream --err
```

## Project notes / pinned feedback (from memory)

These are confirmed user/project rules that previously recurred; honour them whenever they apply:

- **Node 22 ABI alignment.** `.env#NODE_BINARY`, `ecosystem.config.cjs#exec_interpreter`, the shebang of `scripts/fix-*.js`, and `.nvmrc`/`package.json#engines.node` must all stay in sync. The `postinstall` (`scripts/fix-server-native-modules.js`) rebuilds natives against `.env#NODE_BINARY` regardless of which Node invoked npm, but the shebang pin prevents direct-script invocations from picking up Node 24.
- **Native-module fix script.** `node scripts/fix-server-native-modules.js` is idempotent: when the binding already matches the target ABI it exits quickly. Use `--dry-run` to preview, `--target /path/to/node` to override auto-detection.
- **Git panel UX** (`src/components/git-panel/`). Stabilise the panel with `useMemo` so it does not refetch on every `session_upserted`. Auto-prefix commit messages (don't make the user type a Conventional Commits scope). **Never silent-fail on commit error** — surface the failure (toast / inline error) and keep the editor's text intact so the user can retry.

## Where to read more

- `server/modules/providers/README.md` — provider contract & checklist for adding one.
- `docs/providers/agente.md` — capability/UI matrix per provider.
- `docs/voice.md` — voice module architecture (orthogonal to providers).
- `docs/mcp/minimax.md` — MiniMax MCP module reference.
- `CHANGELOG.md` — release history (release-it keeps this updated).
- `CONTRIBUTING.md` — commit conventions (`commitlint.config.js` enforces Conventional Commits via Husky).
