# OpenCode provider

This document explains how CloudCLI integrates [OpenCode](https://opencode.ai) as one of its
AI coding agents. OpenCode is the only "terminal agent" CLI in CloudCLI's provider catalog
— it spawns an external `opencode` subprocess and communicates with it over **stdio JSONL**,
unlike Claude (in-process SDK) or the others (HTTP/CLI variants). Combined with a multi-model
catalog and a shared SQLite session store, that makes opencode the most architecturally distinct
provider in the registry, which is why it deserves its own doc.

For the canonical guide on **adding a new provider** (facet contract, registration,
types), see `server/modules/providers/README.md`. This doc assumes you already know the
facet model and zooms in on how opencode implements each one.

## Architecture at a glance

```
                 ┌────────────────────────────┐
                 │  User clicks "Send" in UI  │
                 └──────────────┬─────────────┘
                                │ chat.send (WebSocket)
                                ▼
                 ┌────────────────────────────┐
                 │  Gateway:                  │
                 │  handleChatSend()          │
                 │  → spawnFn['opencode']     │
                 └──────────────┬─────────────┘
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │  spawnOpenCode(...)                 │
              │  server/opencode-cli.js             │
              │                                     │
              │  opencode run --format json \       │
              │    --dir <cwd> [--session <id>] \  │
              │    [--model <model>] <prompt>       │
              └──────────────┬──────────────────────┘
                             │ stdio JSONL
                             ▼
        ┌────────────────────────────────────────────────┐
        │ JSONL parser                                   │
        │ stream_delta / thinking / tool_use /           │
        │ step_finish / assistant / complete             │
        └──────────────┬─────────────────────────────────┘
                       │ normalized messages
                       ▼
        ┌────────────────────────────────────────────────┐
        │ OpenCodeSessionsProvider.normalizeMessage     │
        │ → NormalizedMessage (stream_delta, …)         │
        │ → chat_run_registry.completeRun({exitCode:0}) │
        └──────────────┬─────────────────────────────────┘
                       │ WebSocket frame (kind: …)
                       ▼
                ┌────────────────────────────┐
                │  Frontend (React)          │
                │  renders stream in UI      │
                └────────────────────────────┘
```

## Backend layout

Everything that "is" opencode-from-CloudCLI's-point-of-view lives under
[`server/modules/providers/list/opencode/`][opencode-dir]:

| File | Role |
|---|---|
| `opencode.provider.ts` | Registry entry. Declares the 5 standard facets (`auth`, `models`, `mcp`, `skills`, `sessions`) **plus** an extra `models` facet that is unique to opencode in this repo. The "5 facets + extra" pattern is what makes the provider discoverable by the gateway. |
| `opencode-auth.provider.ts` | Auth facet. Resolves credentials from `process.env` first (looking for `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`), then falls back to `~/.local/share/opencode/auth.json`. No login flow in the UI for opencode — the user is expected to have authenticated the CLI externally. |
| `opencode-models.provider.ts` | Dynamic model catalog. Calls the OpenCode CLI (`opencode models`) to list what the local install supports, so the user's model picker stays in sync with whatever binary version they have. |
| `opencode-mcp.provider.ts` | MCP facet. Writes MCP server config as **JSONC** (JSON with comments). This is intentional — opencode's config files accept `//` comments and trailing commas, matching the rest of the opencode ecosystem. |
| `opencode-skills.provider.ts` | Skills facet. Explicitly re-uses Claude's skill catalog and the `Agents` folder via shared logic, so users who configure skills once get them in both providers. |
| `opencode-sessions.provider.ts` | Session storage facet. Reads from `~/.local/share/opencode/opencode.db` — a **shared SQLite database** that the CLI manages. CloudCLI queries it; it doesn't write to it. |
| `opencode-session-synchronizer.provider.ts` | Chokidar-style watcher on the shared DB so that sessions edited externally (e.g. from another terminal running the same `opencode` CLI) appear in CloudCLI's sidebar in real time. |
| `opencode-cli.ts` | Frontend-runtime helper. Exports the spawn/abort/query functions consumed by `server/opencode-cli.js`. Don't confuse with the next file. |

[opencode-dir]: ../../server/modules/providers/list/opencode/

## Runtime CLI: `server/opencode-cli.js`

This is **not** the `opencode-cli.ts` in the provider folder. `server/opencode-cli.js` is the
subprocess driver the gateway calls. It exposes `spawnOpenCode(...)` and `abortOpenCodeSession(...)`.

### Spawn

```
opencode run --format json --dir <cwd> [--session <sessionId>] [--model <modelId>] <prompt>
```

- `--format json` puts the CLI into JSONL output mode (one JSON object per line, NDJSON).
- `--dir` is the per-chat working directory (the project root).
- `--session <id>` is the **provider-native session id** when resuming a previous session. First runs of a session omit it.
- `--model` overrides the default model chosen at runtime.
- The final positional arg is the user prompt.

Communication is **stdio**, not HTTP. The parent process owns the child's stdin/stdout/stderr
pipes and parses each line as JSON.

### Message shapes

The CLI emits JSONL objects that the JSONL parser routes into `NormalizedMessage` variants:

| CLI event | NormalizedMessage kind |
|---|---|
| `stream_delta` | `stream_delta` (incremental assistant text) |
| `thinking` | `thinking` (extended thinking block) |
| `tool_use` | `tool_use` (function call) |
| `step_finish` | (intermediate, no UI frame) |
| `assistant` | (intermediate) |
| `complete` / end-of-stream | `complete` (terminal) |

The provider always emits exactly **one** terminal `complete` per run, except when the run was
aborted (then the runtime's own `complete` is suppressed and the chat-websocket registry issues
one on its behalf — see `server/modules/websocket/services/chat-websocket.service.ts`).

### Abort

`abortOpenCodeSession(sessionId)` sends `SIGTERM` to the matching subprocess and sets an
internal `process.aborted` flag. The flag's purpose: when the child exits during an abort, its
own `complete` event is suppressed so the registry-emitted `complete` doesn't get duplicated.

### The "OpenCode CLI process was terminated" warning

This message appears in the error log when the subprocess exits with `code === null` — which is
exactly what happens when PM2 restarts the Node parent (the opencode child gets `SIGTERM` as a
side effect). The chat-websocket service's catch block in
`server/modules/websocket/services/chat-websocket.service.ts:174` detects the
`provider === 'opencode' && /process was terminated/i.test(message)` pattern and demotes the
log to `console.warn`. Other provider failures stay at `error` level.

This is **noise, not a real failure** — the websocket session is already gone by then.

## Registry and types

OpenCode is registered alongside the other providers in
[`server/modules/providers/provider.registry.ts`][registry]. Adding/removing it requires
editing that file.

The provider name is a string union member in two places, both must stay in sync:

- [`server/shared/types.ts:68`][shared-types] — `export type LLMProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';`
- [`src/types/app.ts:1`][app-types] — the same union mirrored for the frontend.

[registry]: ../../server/modules/providers/provider.registry.ts
[shared-types]: ../../server/shared/types.ts
[app-types]: ../../src/types/app.ts

## UI integration

> **The UI surface shared by all 5 providers is documented in detail under `claude.md` →
> "UI integration"** (Header tabs / Chat tab / Shell CLI tab / Sidebar / Auth-status /
> Skills panel / MCP panel / Permissions). This section zooms in on the **opencode-specific
> deltas**, not on the parts that are common across providers. If you're debugging why a
> tab won't switch or how `chat.subscribe` works, read the Claude doc first; only drop into
> this one when the opencode branch behaves differently.

### Opencode at a glance

| Aspect | Opencode value | Source |
|---|---|---|
| Icon | `OpenCodeLogo.tsx` — monochrome "X" on a square, `fill="currentColor"`, `bg-zinc-500` accent | `src/components/llm-logo-provider/OpenCodeLogo.tsx`; `AgentSelectorSection.tsx:26-30` |
| Provider list position | 5th in `AGENT_PROVIDERS`, `CLI_PROVIDERS`, `visibleAgents`, `loadProviderModels` | `src/components/settings/constants/constants.ts:42`; `AgentsSettingsTab.tsx:32`; `useChatProviderState.ts:149` |
| Sidebar dot color | `bg-zinc-500` | `AgentSelectorSection.tsx:26-30` |
| AccountContent card | zinc-toned (gray-theme with a neutral feel) | `AccountContent.tsx:57-65` |
| Onboarding card | `bg-zinc-100 dark:bg-zinc-800/50 border-zinc-300 dark:border-zinc-600` | `AgentConnectionsStep.tsx:33-38` |
| `PROVIDER_META` vendor label | `name: 'OpenCode'` (not a vendor — a product) | `ProviderSelectionEmptyState.tsx:26-32` |
| Permission modes (UI) | `['default']` only — single mode | `useChatProviderState.ts:12-18` |
| Default model fallback | `'anthropic/claude-sonnet-4-5'` (4-5, not 4) | `useChatProviderState.ts:17` |
| Login command | `opencode auth login` (no `--device-auth` variant, no SaaS branch) | `ProviderLoginModal.tsx:39-41` |
| Auth endpoint | `/api/providers/opencode/auth/status` | `src/components/provider-auth/types.ts:18` |
| Skill path display | `null` (opencode is excluded from `PROVIDER_SKILL_PATHS`) | `ProviderSkills.tsx:67, 223` |
| MCP scopes | `['user', 'project']` (no `local`) | `src/components/mcp/constants.ts:11-25` |
| MCP transports | `['stdio', 'http']` (no `sse`) | same |
| Code-named UI fields | none — `showCodexOnlyFields` is codex-exclusive | `McpServerFormModal.tsx:121` |
| Locales | `en`, `es`, `fr` (+ base 12-locale set); no missing-key gaps like codex | `chat.json`, `settings.json` |

### Header tabs (opencode perspective)

The header tab switcher (`MainContentTabSwitcher.tsx:34–53`) is **provider-agnostic** — the
same chrome is rendered regardless of which provider is selected. The mapping of
provider→tab never happens; the chat composer owns the provider selection, the tabs own
the layout. Opencode behaves identically to Claude here: clicking the `shell` tab starts
an `xterm.js` session and forwards `provider: 'opencode'` to the buildShellCommand switch
on the server side. See `claude.md` → "Shell / CLI tab" for the full transport
description; the opencode-specific behavior is:

```ts
// server/modules/websocket/services/shell-websocket.service.ts (opencode branch)
if (provider === 'opencode') {
  if (resumeSessionId) return `opencode --session "${resumeSessionId}"`;
  return initialCommand || 'opencode';
}
```

### Chat tab — opencode-specific bits

The chat panel is the same component for all 5 providers (`ChatInterface.tsx`). The
opencode branches are:

- **`useChatProviderState.ts:149`** declares the provider list as `['claude', 'cursor', 'codex', 'gemini', 'opencode']`. The hook fires `Promise.all(providers.map(fetchModels))` for all five on mount; opencode gets a parallel `GET /api/providers/opencode/models` call.
- **`useChatProviderState.ts:93-95`** manages `opencodeModel` / `setOpenCodeModel` separately from the other four slots, persisted under `'opencode-model'`.
- **`useChatProviderState.ts:314-326`** reconciles the model catalog effect for opencode (no special-casing — same logic as every other provider).
- **`ProviderSelectionEmptyState.tsx:164-166`** writes `localStorage['opencode-model']` when the user picks a model in the picker.
- **`useChatComposerState.ts:744`** has **no opencode downgrade** (unlike codex's `plan → default`). Opencode's permission mode is sent through unchanged.

There is **no codex-style plugin skills surface** and **no claude-style permission flow** for
opencode; the chat composer accepts whatever `providerModelCatalog.opencode` returns and
sends `chat.send { options: { model, permissionMode: 'default' } }` to the gateway. The
gateway's `spawnFn['opencode']` then shells out to `opencode run --format json ...` (see
Runtime CLI section below).

### Shell / CLI tab — opencode spawn command

The `/shell` WebSocket transport (`src/components/shell/utils/socket.ts:4–18`) and the
xterm.js host (`Shell.tsx`) are shared across providers. The provider-specific command
construction lives server-side in
`server/modules/websocket/services/shell-websocket.service.ts:115–172`:

```ts
if (provider === 'opencode') {
  if (resumeSessionId) return `opencode --session "${resumeSessionId}"`;
  return initialCommand || 'opencode';
}
```

A first-time opencode shell session runs the bare `opencode` binary; resuming passes
`--session "<id>"`. There is no `|| opencode` fallback (unlike Claude's resume-on-POSIX
pattern at the same site) — opencode itself handles resume failures.

Provider source on the client (`useShellConnection.ts:146`):

```ts
provider: isPlainShellRef.current
  ? 'plain-shell'
  : (selectedSessionRef.current?.__provider
     || localStorage.getItem('selected-provider')
     || 'claude'),
```

If the user has selected an opencode session in the sidebar, `__provider === 'opencode'`
flips the shell to the opencode TUI. Otherwise the chat composer's last-stored provider
wins. The **login embed** (`ProviderLoginModal.tsx:143`) for opencode runs
`opencode auth login` — see Auth-status section below for the full redirect flow.

### Sidebar left sessions list

The sidebar is shared across all providers (see `claude.md` → "Sidebar left sessions list"
for the data-flow, alias-matching, and identity-stabilization details). For opencode the
deltas are:

- **Provider label** — `SidebarSessionItem.tsx` renders `<SessionProviderLogo provider="opencode" />` when the row's `__provider === 'opencode'`. The logo is the "X on a square" SVG (`src/components/llm-logo-provider/OpenCodeLogo.tsx`).
- **No provider filter** — `getAllSessions` (`src/components/sidebar/utils/utils.ts:99–106`) returns every session under the project regardless of provider; opencode sessions appear alongside Claude / Codex / Cursor / Gemini rows sorted by date.
- **`useProjectsState.handleSidebarRefresh` (`:841–887`)** preserves `__provider: 'opencode'` across refreshes — same machinery as every other provider.

The sidebar's session list is also the **source of truth for "current provider"** when
there's a selected session: `useChatProviderState.ts:337–344` copies
`selectedSession.__provider` into `localStorage['selected-provider']`. So clicking an
opencode session in the sidebar switches the chat composer to opencode automatically.

### Auth-status surface

`useProviderAuthStatus` (`src/components/provider-auth/hooks/useProviderAuthStatus.ts`)
fires for opencode during onboarding, settings-open, and post-login. Endpoint:

```ts
// src/components/provider-auth/types.ts:18
opencode: '/api/providers/opencode/auth/status',
```

The opencode status payload follows the standard `{ installed, authenticated, email, method, error }`
shape. The `installed` check is delegated to `providerAuthService.isProviderInstalled('opencode')`
which shells out to the binary; for opencode that means finding an `opencode` executable
on `PATH` (or the path the user has configured). The `authenticated` flag comes from
`opencode-auth.provider.ts#checkCredentials` — env vars first
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `OPENROUTER_API_KEY`), falling back to `~/.local/share/opencode/auth.json`.

**Login redirect.** `AgentsSettingsTab.tsx:52-54` renders an opencode row with
`authStatus: providerAuthStatus.opencode` and `onLogin: () => onProviderLogin('opencode')`.
The controller in `useSettingsController.ts:164-165, 233-235` flips `loginProvider` to `'opencode'`
and renders `ProviderLoginModal` keyed by it. The modal (`ProviderLoginModal.tsx:39-41`)
runs:

```ts
if (provider === 'opencode') {
  return 'opencode auth login';
}
```

— embedding a `StandaloneShell` (terminal) that runs the command interactively. After
the CLI exits, `Settings.tsx:228-235` keeps the modal open so users can read the output,
and the Agents tab calls `refreshProviderAuthStatuses()` to flip the dot from gray to
zinc-500.

### Skills panel — the opencode exclusion

`ProviderSkills.tsx` is shared across all 5 providers, but **opencode is the only provider
in the skills view that hides its own skills path**:

```ts
// ProviderSkills.tsx:67
const PROVIDER_SKILL_PATHS: Record<Exclude<SkillsProvider, 'opencode'>, string> = {
  claude: '~/.claude/skills/<skill-name>/SKILL.md',
  codex: '~/.agents/skills/<skill-name>/SKILL.md',
  cursor: '~/.cursor/skills/<skill-name>/SKILL.md',
  gemini: '~/.gemini/skills/<skill-name>/SKILL.md',
};
```

```ts
// ProviderSkills.tsx:223
const providerPath = selectedProvider === 'opencode' ? null : PROVIDER_SKILL_PATHS[selectedProvider];
```

Why? Because the **backend** (`opencode-skills.provider.ts`) is explicit about it:
"OpenCode reuses Claude's skill catalog and the Agents folder via shared logic, so users
who configure skills once get them in both providers." When the UI is on the opencode
slot, the displayed path is suppressed and the data fetch + cache key remain in flux
because:

- `useProviderSkills.ts:164–182` hits `/api/providers/opencode/skills` (the opencode facet endpoint) which **does** return skills — they are the same skills Claude sees because the backend shares storage.
- The UI just doesn't render the `~/.claude/skills/...` path label so users don't get confused about "why is opencode showing me Claude paths".

REST contract, cache, refresh triggers, plugin-badge logic are all identical to Claude
(see `claude.md` → "Skills panel" for the full table). The only delta is the
`providerPath = null` rendering decision above.

### MCP panel

Opencode's MCP row in `McpServers.tsx` is unremarkable compared to the other 4 non-Claude
providers. The matrix (`src/components/mcp/constants.ts:11–25`):

```ts
opencode: { scope: ['user', 'project'], transport: ['stdio', 'http'] }
```

Constraints that fall out:

- **No `local` scope** — the user-scope falls back to Claude's `~/.claude.json` semantics only for Claude; for opencode, "user" maps to whatever `~/.config/opencode/config.json` (or wherever opencode stores MCP for the active user) the CLI exposes.
- **No `sse` transport** — same reason as codex/gemini.
- **JSONC config** — the opencode backend writes JSONC (JSON with comments) on disk, matching opencode's own config format. The UI doesn't see this difference; the round-trip through the opencode facet is transparent. This is the **only** provider in the catalog whose MCP UI label rounds-trips through JSONC instead of JSON.

The `McpServerFormModal` has **no opencode-specific fields** — `showCodexOnlyFields` at
`McpServerFormModal.tsx:121` is codex-exclusive. Opencode's form just exposes the two
scopes + two transports from the matrix above. The "Add Global MCP Server" path (POST
`/api/providers/mcp/servers/global`) blocks `local` and `sse` because opencode can't
consume them.

Refresh + cache behavior is the standard 30-second TTL with per-cache-key invalidation
on save/delete (`useMcpServers.ts:52-53`).

### Permissions

Opencode has the **narrowest permission mode set** in the catalog
(`server/modules/providers/services/provider-capabilities.service.ts:69–77`):

```ts
opencode: {
  provider: 'opencode',
  permissionModes: ['default'],     // only 'default' — no acceptEdits, no bypassPermissions, no plan
  defaultPermissionMode: 'default',
  supportsImages: false,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: true,
},
```

UI mirrors this in `useChatProviderState.ts:26-32` (the `FALLBACK_PERMISSION_MODES` record):

```ts
const FALLBACK_PERMISSION_MODES: Record<LLMProvider, PermissionMode[]> = {
  // ...
  opencode: ['default'],
};
```

**Consequences:**

- The chat composer's permission-mode badge (`useChatComposerState.ts:370–374`) only ever renders `default` for opencode. There's no mode-cycle shortcut (the cycling logic at `useChatProviderState.ts:284-298` skips non-existent modes).
- **`useChatComposerState.ts:744`** has **no** opencode downgrade clause. The only provider-specific downgrade is `provider === 'codex' && permissionMode === 'plan' ? 'default' : permissionMode`. Opencode sends `default` unchanged.
- There's no `OpencodePermissions` component. The Settings → Agents → Permissions tab uses the generic `PermissionsContent` dispatcher (`PermissionsContent.tsx`) which routes by `agent` to a dedicated component per provider — opencode currently has no dedicated branch, so it falls through to a no-op or renders the default radio placeholder. This is asymmetric with `CodexPermissions` (`PermissionsContent.tsx:479–580`) which is dedicated. If you're adding a dedicated opencode permissions UI in the future, look at the CodexPermissions pattern; the `permissionModes: ['default']` constraint is the only reason it hasn't been needed yet.
- **No `canUseTool` flow.** Opencode has `supportsPermissionRequests: false`, so its subprocess never sends a `permission_request` frame — chat-websocket doesn't intercept anything mid-stream. The chat composer just sends the message and the gateway shells out to `opencode run`. (Contrast Claude, which has the full `canUseTool` / `permission_request` / `permission_cancelled` flow described in `claude.md` → "Permissions and tools".)

### Icon + provider identity (legacy note)

The legacy "4 bullets" UI summary, now superseded by the structured sections above:

- **Icon** — `src/components/llm-logo-provider/OpenCodeLogo.tsx`. A glyph that draws an "X"
  on top of a square with `fill="currentColor"`. Color accent `bg-zinc-500` (one of four
  providers with a brand color; codex has none, defaults to `bg-foreground/60`).
- **Provider list** — opencode appears in `AGENT_PROVIDERS`, `CLI_PROVIDERS`, the sidebar
  agent pills, `useChatProviderState`, and `ProviderSelectionEmptyState`. New provider
  additions only need to update these lists (and one new `if (provider === 'X')` branch
  in `SessionProviderLogo.tsx`).
- **i18n** — strings live alongside the other providers:
  - `providerSelection.readyPrompt.opencode`
  - `agents.providers.opencode.description`
  - All three locales (`en`, `es`, `fr`) must be updated; a missing translation falls back to
    `en` but breaks Spanish-first UX (which is the project's default).

There is no dedicated `cloudcli opencode ...` sub-command — opencode is provider-shaped only,
spawned by the chat gateway. The user enables it via Settings → Agents in the web UI.

## End-to-end message flow

1. User types a message in the chat input, selects opencode (or it's the project default).
2. Frontend sends a WebSocket frame `chat.send { content, options: { cwd, model } }` to `/ws`.
3. `handleChatSend` in the gateway resolves the project, picks the right `spawnFn` from the
   registry (`spawnFn['opencode']` → `spawnOpenCode`), and invokes it.
4. `spawnOpenCode` writes an entry to `chat_run_registry.startRun(...)`, which a sidecar file
   like `~/.cloudcli/browser-use/current-chat-run.json` may consume for cross-feature
   correlation (see `docs/providers/...` for any sibling feature that uses the same pattern).
5. The opencode subprocess starts, JSONL streaming begins. Each parsed line is fed through
   `OpenCodeSessionsProvider.normalizeMessage(...)` to map into the
   `NormalizedMessage` envelope (the unified server→client message shape, see
   `server/modules/websocket/README.md`).
6. Each normalized frame is sent to the client over the per-connection WebSocket.
7. On terminal frame (`complete`) or subprocess exit, `chat_run_registry.completeRun({exitCode})`
   is called and the `complete` frame is forwarded.
8. The frontend sees the terminal frame, clears its streaming state, and renders the final answer.

## Auth & environment

- **Env vars (highest precedence):** the opencode CLI itself reads
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`,
  `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`. CloudCLI propagates
  `process.env` to the child verbatim (no filtering).
- **Auth file (fallback):** `~/.local/share/opencode/auth.json` — the same file the
  standalone opencode CLI uses after `opencode auth login`. CloudCLI's `opencode-auth.provider.ts`
  defers to it when no env var matches.
- **No interactive login flow in CloudCLI** — the user is expected to have authenticated
  the opencode CLI separately.

There is **no `cloudcli opencode ...` CLI sub-command** — search `server/cli.js` to confirm.

## Unique behaviors (vs other providers)

A few things opencode does that the other four providers don't, in order of impact:

1. **Multi-model catalog via the CLI.** `opencode-models.provider.ts` shells out to
   `opencode models` to enumerate what the local binary supports, instead of hardcoding a
   list. So the model picker stays current with whatever opencode version the user installed.
2. **Shared SQLite session store.** All opencode sessions live in
   `~/.local/share/opencode/opencode.db`, regardless of which client created them. CloudCLI
   reads from it; it doesn't write to it. That's why `opencode-session-synchronizer.provider.ts`
   exists — to mirror external changes into the CloudCLI sidebar.
3. **JSONC MCP config.** The MCP server list written by `opencode-mcp.provider.ts` is JSONC
   (JSON with comments), matching opencode's own config format elsewhere.
4. **Re-uses Claude's skills.** `opencode-skills.provider.ts` shares skill storage with the
   Claude provider, so a user only configures skills once.
5. **`SIGTERM`-aware abort.** Aborts go through a `process.aborted` flag that suppresses the
   CLI's own `complete` event to prevent duplicates in the registry.

## Debugging & verification

The provider ships with focused tests you can lean on while changing anything in this doc:

- `server/opencode-cli.test.js` — subprocess spawn, JSONL parsing, abort flow.
- `server/modules/providers/tests/opencode-models.test.ts` — model catalog shape.
- `server/modules/providers/tests/opencode-sessions.test.ts` — shared DB read path.
- A section in `server/modules/providers/tests/mcp.test.ts` — JSONC config write/read.

Run them with:

```
PATH=/opt/node22/bin:$PATH npx tsx --test server/opencode-cli.test.js
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/opencode-models.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/opencode-sessions.test.ts
```

Logs worth grepping:

- `[DEBUG-GIT-PANEL] render …` — unrelated to opencode, ignore.
- `OpenCode CLI process was terminated` — expected on PM2 restart; warn-level.
- `[Chat] Provider runtime "opencode" failed` — actual errors (not the SIGTERM case).

## Known quirks

- **"OpenCode CLI process was terminated" log noise** is suppressed to warn when the underlying
  cause is a PM2 restart; only that specific text triggers the demotion. Any other opencode
  error stays at error level.
- **No `cloudcli opencode …` CLI sub-command.** Opencode is only accessible as a provider
  selection inside the web UI's chat panel. Don't add such a sub-command without a feature
  request justifying it.
- **The provider name `opencode` is a string literal** that appears in a few `.match()`
  and `.startsWith()` checks (`chat-websocket.service.ts`, `opencode-*` files). Renaming
  the provider (e.g. to `opencode-cli` to disambiguate from the CLI tool name) is a
  multi-file find-and-replace — coordinate with the registry change.
- **Shared SQLite means external edits surface in CloudCLI**, which is usually what users
  want, but it also means a stale session list in the sidebar can come from a `opencode`
  run started in someone else's terminal. The session synchronizer exists exactly to handle
  this case.

## Interactive prompts UI — the `question` tool gap

OpenCode has **`supportsPermissionRequests: false`** in
`server/modules/providers/services/provider-capabilities.service.ts:75`. This means:

1. The CLI never emits a `permission_request` frame over WebSocket. All
   permission decisions go through OpenCode's own permission UI (outside CloudCLI).
2. `<PermissionRequestsBanner />` never appears in the chat composer for opencode
   sessions.
3. `AskUserQuestionPanel` is **never** rendered.

### The native `question` tool

OpenCode's CLI ships a native tool called `question` (documented at
`https://opencode.ai/docs/tools`) that lets the LLM ask the user a structured
question mid-stream. Parameters: `header`, `question` (text), list of `options`.

When the LLM uses this tool, the CLI emits a JSONL event identical in shape to
any other tool:

```jsonl
{ "type": "tool_use", "tool": "question", "input": { "questions": [...] }, "callID": "..." }
```

The OpenCode normalizer at
`server/modules/providers/list/opencode/opencode-sessions.provider.ts:273-295`
does not inspect the tool name — it just propagates `toolName = raw.tool`. So
the WebSocket frame arrives at the frontend with `kind: 'tool_use', toolName: 'question'`.

### Why the UI card looks different from Claude's

Two mismatches between OpenCode's tool name and the frontend's renderer registry:

1. **`getToolCategory('question')` returns `'default'`** —
   `src/components/chat/tools/ToolRenderer.tsx:45` only recognises
   `AskUserQuestion` (Claude's name) as the `question` category. The bare
   `question` name (OpenCode's) falls through to `'default'`, so the card
   border is **gris** (`border-l-border`) instead of **azul**.

2. **`TOOL_CONFIGS` has no entry for `'question'`** —
   `src/components/chat/tools/configs/toolConfigs.ts` registers the rich
   `AskUserQuestion` config (with `contentType: 'question-answer'`) but not
   `question`. The OpenCode tool falls through to `TOOL_CONFIGS.Default` (lines
   530-549), which renders a generic `<CollapsibleDisplay title="Parameters">`
   with `<TextContent content={JSON.stringify(input)} format="code" />`.

**Net effect**: the user sees a **gray collapsible card** with the **raw JSON**
of the question (the `questions` array with options), expandable but **not
interactive**. There are no clickable options, no "Submit" / "Skip" buttons.
The LLM gets no answer back because the driver cannot inject one (the
subprocess's stdin is closed in `server/opencode-cli.js:219` before the run
starts).

### Comparison with Claude's `AskUserQuestion`

| Aspect | Claude (`AskUserQuestion`) | OpenCode (`question`) |
|---|---|---|
| Frontend recognises the tool | Yes (`TOOL_CONFIGS['AskUserQuestion']`) | No → fallback `Default` |
| Renderer used | `QuestionAnswerContent` (rich, with headers, badges, expand/collapse per question) | `TextContent` with raw JSON |
| Border color | Blue (`border-l-blue-500/60` — `question` category) | Gris (`border-l-border` — `default` category) |
| Interaction | **Interactive** — kbd 1-9, Other (kbd 0), Submit/Enter, Skip/Esc | **Read-only** — expand/collapse |
| Round-trip answer to model | Yes, via `permission_request` + `permission_response` over WebSocket | No (stdin closed before run) |
| `supportsPermissionRequests` | `true` | `false` |

### How to close the gap (not done)

To make OpenCode's `question` tool render the rich `QuestionAnswerContent`
card, three changes are needed:

1. Add `'question'` to `getToolCategory` in `ToolRenderer.tsx:45`.
2. Add `TOOL_CONFIGS.question` mirroring the `AskUserQuestion` config but
   keyed on `'question'`.
3. To make it actually interactive: implement a `permission_request` /
   `permission_response` round-trip on the opencode-cli.js side. The current
   driver closes `opencodeProcess.stdin.end()` at line 219 before the run
   starts; a real interactive flow would need to keep stdin open and write
   the user's answers back into the subprocess (likely via an IPC channel
   that OpenCode CLI does not currently expose).

See [`docs/providers/claude.md#interactive-prompts-ui`](./claude.md#interactive-prompts-ui)
for the full Claude interactive flow, and [`docs/providers/agente.md`](./agente.md)
for the cross-provider comparison matrix.

## Capabilities & UI support (OpenCode row)

| Property | OpenCode value | Source |
|---|---|---|
| Login command | `opencode auth login` | `ProviderLoginModal.tsx:39-41` |
| Permission modes | `['default']` only | `useChatProviderState.ts:12-18` |
| `supportsPermissionRequests` | `false` | `provider-capabilities.service.ts:75` |
| Interactive UI | **No** — passive card for the `question` tool (no round-trip) | `opencode-sessions.provider.ts:273-295` |
| `tool_use` renderer | **Partial** — `question` tool falls back to `Default` collapsible (raw JSON) | `ToolRenderer.tsx:45`, `toolConfigs.ts:530-549` |
| Custom providers | **Yes** — multi-model catalog via `opencode models`; shared SQLite | `opencode-models.provider.ts` |
| Status | Production | — |

See [`docs/providers/agente.md`](./agente.md) for the full cross-provider comparison
table and the auth resolution matrix.

## See also

- `server/modules/providers/README.md` — canonical provider-facet guide.
- `server/modules/websocket/README.md` — message envelope and per-run event log.
- `CLAUDE.md` — top-level project conventions and the CloudCLI runtime model.
- `docs/providers/README.md` — index of provider documentation (renamed to `agente.md`; this link may break — see `docs/providers/agente.md`).
