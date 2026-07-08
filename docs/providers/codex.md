# Codex provider

This document explains how CloudCLI integrates [OpenAI Codex](https://github.com/openai/codex) as one of its
AI coding agents. Codex is the architecturally unusual member of the catalog: **on the chat path it
talks to the official `@openai/codex-sdk` in-process**, not to a CLI subprocess — so unlike Claude (in-process
SDK but a different one) and unlike opencode/gemini (JSONL stdio), Codex SDK events arrive over an
**async iterator** that we reshape into `NormalizedMessage` frames. The shell path is the only place
where the bare `codex` binary is spawned. Combined with a TOML-based MCP store, six skill roots (only
two of which the user can write to), and a Codex-maintained `~/.codex/models_cache.json` that the server
just *reads* (never writes), Codex earns its own doc.

For the canonical guide on **adding a new provider** (facet contract, registration, types), see
`server/modules/providers/README.md`. This doc assumes you already know the facet model and zooms
in on how Codex implements each one.

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
                 │  → spawnFn['codex']        │
                 │  → queryCodex()            │
                 └──────────────┬─────────────┘
                                │
                                ▼
        ┌──────────────────────────────────────────────┐
        │ queryCodex()                                 │
        │ server/openai-codex.js                       │
        │                                              │
        │  new Codex()                                 │
        │    .startThread({ workingDirectory,          │
        │                  skipGitRepoCheck,           │
        │                  sandboxMode,                │
        │                  approvalPolicy,             │
        │                  model })                    │
        │    .runStreamed(command, { signal })         │
        └──────────────┬───────────────────────────────┘
                       │ async iterator of SDK events
                       ▼
        ┌────────────────────────────────────────────────┐
        │ transformCodexEvent()                          │
        │  - item.{started,updated,completed}            │
        │    → { type: 'item', itemType, ... }           │
        │      (agent_message, reasoning,                │
        │       command_execution, file_change,          │
        │       mcp_tool_call, web_search, todo_list)    │
        │  - turn.{started,completed,failed}             │
        │  - thread.started, error                       │
        └──────────────┬─────────────────────────────────┘
                       │ transformed events
                       ▼
        ┌────────────────────────────────────────────────┐
        │ CodexSessionsProvider.normalizeMessage        │
        │   (live → NormalizedMessage)                  │
        │ or getCodexSessionMessages                     │
        │   (historical JSONL → NormalizedMessage)       │
        └──────────────┬─────────────────────────────────┘
                       │ NormalizedMessage
                       ▼
                ┌────────────────────────────┐
                │  Frontend (React)          │
                │  renders stream in UI      │
                └────────────────────────────┘
```

The shell path (`server/modules/websocket/services/shell-websocket.service.ts`) is a separate code path
that **does** spawn the bare `codex` binary directly (or `codex resume "<id>"` on POSIX, with a PowerShell
fallback at lines 139–147) for interactive shells. See [Runtime CLI](#runtime-cli-serveropenai-codexjs)
below for the full split.

## Backend layout

Everything that "is" Codex-from-CloudCLI's-point-of-view lives under
[`server/modules/providers/list/codex/`][codex-dir]:

| File | Role |
|---|---|
| `codex.provider.ts` | Registry entry. Wires the six standard facets (`auth`, `models`, `mcp`, `skills`, `sessions`, `sessionSynchronizer`) — no extras. |
| `codex-auth.provider.ts` | Auth facet. Probes `codex --version`, reads `~/.codex/auth.json`. Accepts OAuth `tokens.id_token` / `tokens.access_token` (method `credentials_file`) **or** `auth.OPENAI_API_KEY` (method `api_key`). Email extracted from the JWT payload when available. |
| `codex-models.provider.ts` | Models facet. Reads `~/.codex/models_cache.json` (a file the Codex CLI maintains itself) and falls back to a hardcoded `CODEX_FALLBACK_MODELS` list (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`) when the cache is missing. Default = `gpt-5.4`. |
| `codex-mcp.provider.ts` | MCP facet. Reads/writes **TOML** at `~/.codex/config.toml` (user) or `<workspace>/.codex/config.toml` (project). Restricted scopes (`['user', 'project']`) and transports (`['stdio', 'http']`). |
| `codex-skills.provider.ts` | Skills facet. Six roots: workspace `.agents/skills`, parent `.agents/skills`, topmost git-root `.agents/skills`, `~/.agents/skills`, `/etc/codex/skills`, `~/.codex/skills/.system`. All prefixed `$`. |
| `codex-sessions.provider.ts` | Sessions facet. Streams per-session JSONL files via `node:readline`. Three responsibilities: (1) live SDK event normalization via `normalizeMessage` for the chat path, (2) historical JSONL → `NormalizedMessage` via `getCodexSessionMessages` + `normalizeHistoryEntry`, (3) backlink pass that pairs `tool_use` with its `tool_result`. |
| `codex-session-synchronizer.provider.ts` | Synchronizer. Recursively scans `~/.codex/sessions` for newer JSONL files and upserts them into `sessionsDb`, resolving names from `~/.codex/session_index.jsonl` (and falling back to `extractLastAgentMessageFromEnd` for an unnamed session). |

[codex-dir]: ../../server/modules/providers/list/codex/

## Runtime CLI: `server/openai-codex.js`

> **Important**: there is **no** `server/codex-cli.js`. The runtime driver for Codex is
> `server/openai-codex.js` (506 lines). Despite the name, it is **not** a CLI spawner — it is a
> thin wrapper around the official `@openai/codex-sdk`. The bare CLI **is** used on the shell
> path (see [`shell-websocket.service.ts:139–147`](../../server/modules/websocket/services/shell-websocket.service.ts#L139)),
> but for chat runs, the SDK handles I/O in-process.

### Export surface

```js
// server/openai-codex.js
queryCodex(command, options, ws)        // line 224 — run a streaming prompt
abortCodexSession(sessionId)            // line 426 — cancel a session
isCodexSessionActive(sessionId)         // line 448 — is a session running?
getActiveCodexSessions()                // line 457 — list running sessions
```

`server/index.js:34–35` registers these into the gateway:

```
import { queryCodex, abortCodexSession } from './openai-codex.js';
// ...
spawnFns.codex = queryCodex;
abortFns.codex = abortCodexSession;
```

`queryCodex` is also called from the API-driven path in `server/routes/agent.js:973`.

### Spawn equivalent

There is no shell command — equivalent is the SDK call:

```js
const codex = new Codex();               // line 252
const thread = sessionId
  ? codex.resumeThread(sessionId, threadOptions)   // line 265
  : codex.startThread(threadOptions);              // line 267
const streamedTurn = await thread.runStreamed(command, { signal: abortController.signal }); // line 289
```

`threadOptions` (lines 255–261):

```js
{
  workingDirectory,        // cwd || projectPath || process.cwd()
  skipGitRepoCheck: true,  // never fail on missing .git
  sandboxMode,             // from mapPermissionModeToCodexOptions
  approvalPolicy,          // from mapPermissionModeToCodexOptions
  model: resolvedModel,    // from providerModelsService.resolveResumeModel('codex', sessionId, model)
}
```

`mapPermissionModeToCodexOptions` (lines 197–216) maps the UI's three modes to Codex SDK fields:

| UI `permissionMode` | `sandboxMode` | `approvalPolicy` |
|---|---|---|
| `'default'` | `'workspace-write'` | `'untrusted'` |
| `'acceptEdits'` | `'workspace-write'` | `'never'` |
| `'bypassPermissions'` | `'danger-full-access'` | `'never'` |

### Communication protocol

**Async iterator over SDK events.** No JSONL. No stdout streaming. No HTTP. The SDK itself owns the I/O.

```
for await (const event of streamedTurn.events) { ... }
```

Each event's `.type` is one of:

| SDK event | What `transformCodexEvent` returns |
|---|---|
| `item.started`, `item.updated` | **Dropped** (line 323: only `item.completed` emits) |
| `item.completed` | `{ type: 'item', itemType, ... }` — `itemType` is one of `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `error`, or the raw `item.type` (default branch line 147). |
| `turn.started` | `{ type: 'turn_started' }` (also dropped downstream) |
| `turn.completed` | `{ type: 'turn_complete', usage: event.usage }` — `queryCodex` extracts a token budget from `usage.total_token_usage` (lines 31–52) and emits `kind: 'status', text: 'token_budget'` over the websocket (lines 347–352). |
| `turn.failed` | `{ type: 'turn_failed', error: event.error }` — `queryCodex` fires `notifyRunFailed(...)` (lines 335–344). |
| `thread.started` | `{ type: 'thread_started', threadId }` — `queryCodex` lazily captures the session id, registers the session in `activeCodexSessions`, calls `ws.setSessionId(...)`, and emits `kind: 'session_created'` over the WS (lines 295–309). |
| `error` | `{ type: 'error', message: event.message }` |

The transformed event is then pushed through `sessionsService.normalizeMessage('codex', transformed, sessionId)`
on line 330 to produce `NormalizedMessage[]` frames that the websocket writer ships to the UI.

### Permission-mode downgrade

Codex has **no plan mode**. The chat composer downgrades `permissionMode: 'plan'` to `'default'`
client-side before sending (`useChatComposerState.ts:744`, comment starts at 743):

```ts
permissionMode: provider === 'codex' && permissionMode === 'plan' ? 'default' : permissionMode,
```

UI users never see the `plan` option in Codex's `CodexPermissions` component
(`PermissionsContent.tsx:473–580`); only `default / acceptEdits / bypassPermissions` are
exposed there.

### Abort

`queryCodex` creates `new AbortController()` (line 248) and passes `abortController.signal` to
`thread.runStreamed` (line 290). On the abort path:

1. `abortCodexSession(sessionId)` (lines 426–441) flips
   `session.status = 'aborted'` then calls `session.abortController?.abort()` (line 435).
2. The main event loop checks `abortController.signal.aborted` (line 313) **and** the
   `activeCodexSessions` map for `status === 'aborted'` (lines 316–320) to break out cleanly.
3. The terminal `complete` frame is suppressed (lines 357–375) when `runAborted` is true — the
   chat-run registry has already issued one with `aborted: true`.
4. In the catch block (lines 379–382), `wasAborted` is also detected via
   `error.name === 'AbortError'` or `error.message.toLowerCase().includes('aborted')`.

No `SIGTERM`. No subprocess. Just an in-process AbortController.

### Timeout & GC

No explicit per-run timeout. The only `5000 ms` timeout in codex-land is the auth probe in
`codex-auth.provider.ts:24`. Completed sessions are GC'd from the in-memory `activeCodexSessions`
map after **30 minutes** by a `setInterval` that sweeps every 5 minutes (lines 493–505).

### Error handling

When the loop throws a non-abort error (lines 384–408), the catch block:

1. Logs `[Codex] Error: …` to `console.error`.
2. Calls `providerAuthService.isProviderInstalled('codex')` to disambiguate "CLI not configured"
   from "CLI failed".
3. Sends `kind: 'error'` over the WS with that disambiguated text.
4. Sends the terminal `complete` frame with `exitCode: 1`.
5. Fires `notifyRunFailed(...)` if no prior `turn.failed` already did.

## Auth & environment

### Credential resolution order

`codex-auth.provider.ts#checkCredentials` (lines 51–82):

1. Read `~/.codex/auth.json` (`path.join(os.homedir(), '.codex', 'auth.json')`).
2. If `auth.tokens.id_token` or `auth.tokens.access_token` is present →
   `authenticated: true`, `method: 'credentials_file'`. Email is extracted from the JWT
   payload (`readEmailFromIdToken`, lines 87–99) by base64url-decoding the second segment.
3. Else if `auth.OPENAI_API_KEY` is present → `method: 'api_key'`, email = `'API Key Auth'`.
4. ENOENT → `'Codex not configured'`.
5. Anything else → `'Failed to read Codex auth'` with the `Error.message`.

### Files & env vars read

- **`~/.codex/auth.json`** — Codex-managed credential store. CloudCLI reads it; it does not write to it.
- **`~/.codex/models_cache.json`** — Codex-managed catalog cache (see [Models](#models)).
- **`~/.codex/config.toml`** — Codex-managed TOML config; read for the active model key
  and for `mcp_servers` writes.
- **`~/.codex/sessions/`** — per-session JSONL transcripts. CloudCLI reads these; the CLI writes them.
- **`~/.codex/session_index.jsonl`** — Codex-managed `id → thread_name` index. CloudCLI reads it to
  label disk-discovered sessions.

No CloudCLI-side env vars are read for Codex auth. The Codex SDK reads `OPENAI_API_KEY` itself when
the auth file is missing it (per the CLI's own conventions).

### Login flow in the UI

Unlike Gemini (which has a dedicated API-key instructions panel), Codex uses the **default
embedded-terminal branch** in `ProviderLoginModal`. Two codex-specific lines:

```ts
// src/components/provider-auth/view/ProviderLoginModal.tsx:36–38
if (provider === 'codex') {
  return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
}
```

```ts
// src/components/provider-auth/view/ProviderLoginModal.tsx:50
if (provider === 'codex') return 'Codex CLI Login';
```

The modal embeds a terminal that runs `codex login` (or `codex login --device-auth` on the SaaS
deployment) and the user authenticates through the CLI's own flow. CloudCLI never handles a Codex
password or OAuth dance directly — there is no `cloudcli codex login` sub-command (`server/cli.js`
only references codex in the sandbox templates).

### No `cloudcli codex login` sub-command

`server/cli.js` does **not** define a login sub-command for codex — its only references are
sandbox-related (`SANDBOX_TEMPLATES.codex = 'docker.io/cloudcliai/sandbox:codex'` at line 258,
`SANDBOX_SECRETS.codex = 'openai'` at line 264). Authentication is delegated entirely to the
Codex CLI's own login flow (or to placing an `auth.json` file).

## Models

### Catalog strategy: not dynamic, not from API

`codex-models.provider.ts` does **not** shell out (`codex models`) and does **not** fetch from an
API. It reads `~/.codex/models_cache.json`, a **Codex-managed** cache file. Two outcomes:

| File state | What the facet returns |
|---|---|
| File exists, parses, has ≥ 1 visible model | The mapped list (`mapCodexModel`, lines 54–58), sorted by `priority`, with duplicates removed (lines 60–86). `DEFAULT` is `options[0].value`. |
| File missing, unreadable, or empty | Hardcoded `CODEX_FALLBACK_MODELS` (lines 22–31): `[gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex, gpt-5.2]`, `DEFAULT: 'gpt-5.4'`. |

The active model comes from `~/.codex/config.toml`'s `model` key (lines 105–117); if absent or
unreadable, it falls back to the catalog default.

`changeActiveModel(input)` (lines 120–124) delegates to
`writeProviderSessionActiveModelChange('codex', input)` — the standard shared writer.

### Caching

Codex is **not** in `UNCACHED_PROVIDERS` (`provider-models.service.ts:20`, which currently lists
`['claude', 'gemini']`). That means the higher-level `providerModelsService` may apply its
own caching behavior on top of this facet. The facet itself, however, has no internal cache —
every call to `getSupportedModels()` re-reads `models_cache.json` (or returns the fallback if
ENOENT). Refresh the cache by running `codex models` in the shell.

### Frontend fallback

`useChatProviderState.ts:12–18` defines:

```ts
const FALLBACK_DEFAULT_MODEL: Record<LLMProvider, string> = {
  ...
  codex: 'gpt-5.4',                  // ← matches backend DEFAULT ✓
  ...
};
```

Unlike Gemini (where the frontend fallback `'gemini-3.1-pro-preview'` is **not** in the backend
catalog), Codex's frontend fallback matches the backend catalog's `DEFAULT`. No known divergence.

## MCP

### Scopes & transports (TOML)

`CodexMcpProvider extends McpProvider` (line 37) with constructor:

```ts
super('codex', ['user', 'project'], ['stdio', 'http']);
```

So **no `local` scope** (matches Claude/cursor restrictions) and **no `sse` transport** (unlike
Gemini/opencode).

### Storage

MCP config is **TOML** keyed on `mcp_servers`:

- User scope: `~/.codex/config.toml`
- Project scope: `<workspace>/.codex/config.toml`

`readTomlConfig` / `writeTomlConfig` (lines 17–35) use `@iarna/toml`. They create the directory
on write and tolerate `ENOENT` on read by returning `{}`.

### Field mapping

`buildServerConfig` (lines 63–94) and `normalizeServerConfig` (lines 96–134):

| UI field | stdio TOML | http TOML |
|---|---|---|
| `command` | `command` | — |
| `args` | `args` | — |
| `env` | `env` | — |
| `envVars` | `env_vars` | — |
| `cwd` | `cwd` | — |
| `url` | — | `url` |
| `headers` | — | `http_headers` |
| `bearerTokenEnvVar` | — | `bearer_token_env_var` |
| `envHttpHeaders` | — | `env_http_headers` |

### Frontend constants

`src/components/mcp/constants.ts:6,14,22,34,42`:

```ts
MCP_PROVIDER_NAME_LABELS.codex       = 'Codex'
MCP_SUPPORTED_SCOPES.codex           = ['user', 'project']
MCP_SUPPORTED_TRANSPORTS.codex       = ['stdio', 'http']
MCP_PROVIDER_BUTTON_CLASSES.codex    = 'bg-gray-800 hover:bg-gray-900 ...'
MCP_SUPPORTS_WORKING_DIRECTORY.codex = true   // shares with Gemini
```

`McpServerFormModal.tsx:121,387,402` gates **codex-only UI fields** on
`showCodexOnlyFields = provider === 'codex' && !isGlobalMode` (env vars, bearer env var,
env HTTP headers). The `McpServers.tsx:277–282` banner also has a codex-specific help block that
omits the team feature card.

## Skills

`CodexSkillsProvider extends SkillsProvider`. **Six roots**, all with `commandPrefix: '$'`:

| Scope | `rootDir` | Source line |
|---|---|---|
| `repo` | `<workspace>/.agents/skills` | 23 |
| `repo` | `<parent-of-workspace>/.agents/skills` | 32 |
| `repo` | `<topmost-git-root>/.agents/skills` (gated on `findTopmostGitRoot`) | 37 |
| `user` | `~/.agents/skills` | 44 |
| `admin` | `/etc/codex/skills` | 49 |
| `system` | `~/.codex/skills/.system` | 54 |

`getGlobalSkillSource()` (lines 61–67) returns `~/.agents/skills` as user-scoped — i.e. the same
user-scoped root Gemini uses for its `.agents/skills/` legacy root. Both providers share this
folder for backwards compatibility, but the providers track it independently in their own
`getSkillSources` implementation.

### Frontend (`src/components/skills/view/ProviderSkills.tsx:23,61,69`)

```ts
codex: 'codex'                              // card style
codex: 'Codex'
codex: '~/.agents/skills/<skill>/SKILL.md'  // display path
```

## Sessions and sessionSynchronizer

### Storage

`codex-sessions.provider.ts` reads per-session JSONL files via `node:readline`. The session's path
comes from `sessionsDb.getSessionById(sessionId).jsonl_path` (line 65) — the synchronizer writes
that column.

### Two parallel normalization paths

The file explicitly documents this duality in its doc-comment (lines 263–268):

1. **Live path** — Codex SDK events are reshaped by `transformCodexEvent` (`openai-codex.js:59–190`)
   into `{ type: 'item', itemType, ... }` envelopes, then handed to
   `CodexSessionsProvider.normalizeMessage` (lines 368–509). The `itemType` switch handles:
   `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`,
   `web_search`, `todo_list`, `error`, plus a default branch. Top-level lifecycle events are
   handled at lines 488–506 (`turn_complete → kind: 'complete'`, `turn_failed → kind: 'error'`).
2. **Historical path** — the JSONL file (path = `sessionsDb.jsonl_path`) is parsed by
   `getCodexSessionMessages(sessionId, limit?, offset?)` (lines 59–260). It produces a compact
   intermediate `{type, timestamp, message, toolName, toolInput, toolCallId, output}` shape,
   then `normalizeHistoryEntry` (lines 269–363) lifts each intermediate into a `NormalizedMessage`.

This duality is necessary because the SDK events use `agent_message` / `reasoning` while the
on-disk JSONL uses `event_msg.payload.{user_message, token_count}` /
`response_item.payload.{message, reasoning, function_call, function_call_output,
custom_tool_call, custom_tool_call_output}` — two different shapes for the same conversation.

### Codex-specific quirks in the JSONL parser

- **`shell_command` is renamed to `'Bash'`** (lines 148–169) and the args are re-stringified to
  `{ command }` shape — so the UI displays Codex shell invocations as Bash tool calls.
- **`apply_patch`** (lines 180–219) gets special handling: when a `custom_tool_call` arrives
  for `apply_patch`, the patch lines are split into `Old_String` / `New_String` and
  synthesized into an `Edit`-shaped payload. Without this, apply_patch shows up as opaque text.
- **`token_count`** (lines 88–97) populates a `tokenUsage` from the last `event_msg` that
  carries `payload.info.total_token_usage`. `fetchHistory` (lines 515–573) surfaces this as
  the session-level `tokenUsage` field.

### Synchronizer (`codex-session-synchronizer.provider.ts`)

`synchronize(since?)` (lines 31–69):

1. Build a `nameMap` from `~/.codex/session_index.jsonl` using `buildLookupMap(..., 'id', 'thread_name')`.
2. Recursively scan `~/.codex/sessions` with `findFilesRecursivelyCreatedAfter(...)` for files newer
   than `since` (default: all).
3. For each file, `processSessionFile` extracts `payload.id` and `payload.cwd` (lines 104–117).
   If those aren't present, `processSessionFile` falls back to:
   - `nameMap.get(sessionId)`.
   - `extractLastAgentMessageFromEnd` (lines 147–182), which **reads the file backwards** to find
     the first `event_msg` with `payload.type === 'task_complete'` carrying a non-empty
     `last_agent_message`. (Backward scan avoids parsing the whole file just to label it.)
4. Upsert into `sessionsDb`. If a session already has `custom_name: 'Untitled Codex Session'` and
   we now have a real name, patch it (`updateSessionCustomName`, lines 49–52).
5. `synchronizeFile(filePath)` (lines 74–95) is the per-file entry the watcher calls.

### Watcher

The watcher itself lives in
[`server/modules/providers/services/sessions-watcher.service.ts`](../../server/modules/providers/services/sessions-watcher.service.ts).
For Codex:

- `PROVIDER_WATCH_PATHS.codex = path.join(os.homedir(), '.codex', 'sessions')` (line 25).
- Chokidar config (lines 284–293 of that service): `{ interval: 6000, usePolling: true,
  depth: 6, ignoreInitial: true, persistent: true, followSymlinks: false }`.
- Debounced by `PROJECTS_UPDATE_DEBOUNCE_MS = 500` and `PROJECTS_UPDATE_MAX_WAIT_MS = 2000`
  (lines 54–55).
- On each event, calls `sessionSynchronizerService.synchronizeProviderFile(provider, filePath)`
  (line 248), which delegates to `CodexSessionSynchronizer.synchronizeFile`.
- Targets filtered by `isWatcherTargetFile(provider, filePath)` — for codex this is any
  `.jsonl` extension (lines 79–89 of that service).

## Registry and types

Codex is in the `LLMProvider` union in both:

- [`server/shared/types.ts:68`](../../server/shared/types.ts) — `export type LLMProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';` (second member)
- [`src/types/app.ts:1`](../../src/types/app.ts) — `export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode';` (third member; note the order differs from server).

Registry entry in [`server/modules/providers/provider.registry.ts:10–16`](../../server/modules/providers/provider.registry.ts):

```ts
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  gemini: new GeminiProvider(),
  opencode: new OpenCodeProvider(),
};
```

### Capabilities

`server/modules/providers/services/provider-capabilities.service.ts:51–59`:

```ts
codex: {
  provider: 'codex',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],   // no 'plan'
  defaultPermissionMode: 'default',
  supportsImages: false,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: true,
},
```

No provider-specific fields exist on `NormalizedMessage` for Codex.

[registry]: ../../server/modules/providers/provider.registry.ts
[shared-types]: ../../server/shared/types.ts
[app-types]: ../../src/types/app.ts

## UI integration

> **The UI surface shared by all 5 providers is documented in detail under
> `docs/providers/claude.md` → "UI integration"** (Header tabs / Chat tab / Shell CLI tab
> / Sidebar / Auth-status / Skills panel / MCP panel / Permissions). This section zooms
> in on the **codex-specific deltas**, not on the parts that are common across providers.
> Read the Claude doc first for the shared mechanics; drop into this one when codex
> behaves differently.

### Codex at a glance

| Aspect | Codex value | Source |
|---|---|---|
| Icon | `CodexLogo.tsx` — single-path OpenAI Codex six-petal crystal SVG at `viewBox="100 100 520 520"`, `fill="currentColor"` (monochrome) | `src/components/llm-logo-provider/CodexLogo.tsx`; `SessionProviderLogo.tsx:21-23` |
| Provider list position | 3rd in `AGENT_PROVIDERS` / `CLI_PROVIDERS`; 3rd in `provider.registry.ts`; 3rd in `src/types/app.ts`; **2nd** in `server/shared/types.ts` | `constants.ts:42`; `provider-auth/types.ts:13`; `provider.registry.ts:14`; `app.ts:1`; `shared/types.ts:68` |
| Sidebar dot color | `bg-foreground/60` (no brand color — the **only** provider that falls through to the neutral default) | `AgentSelectorSection.tsx:6-12, 26-28` |
| `PROVIDER_META` vendor label | `name: 'OpenAI'` — the only provider whose picker label is the vendor name rather than the product | `ProviderSelectionEmptyState.tsx:26-32` |
| Permission modes (UI) | `['default', 'acceptEdits', 'bypassPermissions']` (only 3 — `plan` is downgraded by the composer) | `useChatProviderState.ts:26-32` |
| Default model fallback (frontend) | `'gpt-5.4'` (matches backend `CODEX_FALLBACK_MODELS.DEFAULT`) | `useChatProviderState.ts:12-18` |
| Login command | `codex login --device-auth` (SaaS) or `codex login` (self-hosted) | `ProviderLoginModal.tsx:36-38` |
| Modal title | `'Codex CLI Login'` | `ProviderLoginModal.tsx:49` |
| Auth endpoint | `/api/providers/codex/auth/status` | `src/components/provider-auth/types.ts:14` |
| Skill path display | `~/.agents/skills/<skill-name>/SKILL.md` (shared `.agents/` root with Gemini) | `ProviderSkills.tsx:69` |
| MCP scopes | `['user', 'project']` (no `local`) | `src/components/mcp/constants.ts:11-25` |
| MCP transports | `['stdio', 'http']` (no `sse`) | same |
| MCP storage format | **TOML** via `@iarna/toml` (the only TOML-using provider) | `cursor-mcp.provider.ts:5`; `codex-mcp.provider.ts` |
| Codex-only UI fields | `showCodexOnlyFields = provider === 'codex' && !isGlobalMode` — env vars, bearer env var, env HTTP headers | `McpServerFormModal.tsx:121` |
| Capabilities | `permissionModes: ['default', 'acceptEdits', 'bypassPermissions']`, `supportsImages: false`, `supportsAbort: true`, `supportsPermissionRequests: false`, `supportsTokenUsage: true` | `provider-capabilities.service.ts:51-59` |
| Locales | `en`, `es`, `fr` + all 12 base locales (`de`, `it`, `ja`, `ko`, `ru`, `tr`, `zh-CN`, `zh-TW`); `onboarding.agents.providerTitles.codex` missing in 8 of those 12 | `chat.json`, `settings.json`, `sidebar.json` |

### Header tabs (codex perspective)

The header tab switcher (`MainContentTabSwitcher.tsx:34-53`) is **provider-agnostic** —
no codex-specific tab exists. The shell tab starts an `xterm.js` session and forwards
`provider: 'codex'` to `buildShellCommand` on the server:

```ts
// server/modules/websocket/services/shell-websocket.service.ts:139-147
if (provider === 'codex') {
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
    }
    return `codex resume "${resumeSessionId}" || codex`;
  }
  return 'codex';
}
```

Note the `|| codex` POSIX fallback: a successful resume falls through, but a failed
resume (no session found) drops the user into a fresh `codex` session. The Windows
branch uses PowerShell syntax instead.

### Chat tab — codex-specific bits

The chat panel is shared across all 5 providers (`ChatInterface.tsx`). Codex branches:

- **`useChatProviderState.ts:81-83`** manages `codexModel` / `setCodexModel` separately, persisted under `localStorage['codex-model']`.
- **`useChatProviderState.ts:286-298`** reconciles the model catalog effect for codex (no special-casing).
- **`ProviderSelectionEmptyState.tsx:154-156`** writes `localStorage['codex-model']` when the user picks a model in the picker.
- **`useChatComposerState.ts:744`** is the **codex-only** permission-mode downgrade clause:

  ```ts
  // Codex has no plan mode; downgrade rather than sending an
  // unsupported value to its runtime.
  permissionMode: provider === 'codex' && permissionMode === 'plan' ? 'default' : permissionMode,
  ```

  This is **unique** to codex — every other provider either accepts `plan` (Claude, Cursor, Gemini) or has only `'default'` (OpenCode). If `plan` slips through, codex's runtime would fail; the composer catches it.

- The composer uses `'codex-tools-settings'` as its dedicated tools-settings localStorage key (`useChatComposerState.ts:700-701`).

Codex has **no** dedicated chat-level UI block in the composer (no `showCodexOnlyFields`-style flag, no provider-specific composer panel). The chat composer treats codex like every other provider except for the `plan → default` downgrade.

### Shell / CLI tab — codex spawn command

Codex is unique on the shell path because **the chat path uses the SDK** (see
[Runtime CLI](#runtime-cli-serveropenai-codexjs) above), not a CLI spawn. The shell
path **does** spawn the bare `codex` CLI when the user picks the Shell tab.
`buildShellCommand` (`shell-websocket.service.ts:139-147`) is the bridge.

Two implications worth flagging:

1. **There's no chat-style streaming on the shell path.** Pressing keys in the shell sends raw input bytes to `cursor-agent`-style PTY (here `codex`); the user is interacting with codex's native TUI, not with a chat stream.
2. **The login modal runs `codex login` in this shell path** with `isPlainShell=true`. See the Auth-status section for the full redirect.

### Sidebar left sessions list

Standard provider-agnostic sidebar (see `claude.md → Sidebar left sessions list` for the
data flow). Codex deltas:

- **Provider label** — `SidebarSessionItem.tsx` renders `<SessionProviderLogo provider="codex" />`. The logo is the OpenAI crystal mark.
- **No provider filter** — `getAllSessions` returns every session under the project.
- **`useProjectsState.handleSidebarRefresh` (`:841-887`)** preserves `__provider: 'codex'` across refreshes.
- **`__provider === 'codex'` propagates** — selecting a codex session in the sidebar sets `selected-provider = 'codex'` in `localStorage`, which `useChatComposerState` reads and copies into the chat composer.

The sidebar's session list is **also the source-of-truth** for the active provider —
through the `useChatProviderState.ts:337-344` effect that mirrors
`selectedSession.__provider` into `localStorage['selected-provider']`.

### Auth-status surface

`useProviderAuthStatus` (`src/components/provider-auth/hooks/useProviderAuthStatus.ts`).
For codex the endpoint is `/api/providers/codex/auth/status`
(`provider-auth/types.ts:14`).

Server-side `codex-auth.provider.ts#checkCredentials` accepts:

1. `~/.codex/auth.json` with `auth.tokens.id_token` or `auth.tokens.access_token` → `method: 'credentials_file'`, email from JWT.
2. `auth.OPENAI_API_KEY` → `method: 'api_key'`, email = `'API Key Auth'`.
3. ENOENT → `'Codex not configured'`.
4. Other read errors → `'Failed to read Codex auth'`.

**Login redirect.** `AgentsSettingsTab.tsx:46-48` renders the codex row:

```ts
codex: {
  authStatus: providerAuthStatus.codex,
  onLogin: () => onProviderLogin('codex'),
},
```

`Settings.tsx:228-235` renders `ProviderLoginModal` with `provider="codex"`, which
runs:

```ts
// ProviderLoginModal.tsx:36-38
if (provider === 'codex') {
  return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
}
```

The title is `'Codex CLI Login'` (line 49). The embedded `StandaloneShell` runs the
command with `isPlainShell=true`. After exit,
`refreshProviderAuthStatuses()` is called from the Agents tab to flip the dot.

Codex has **no** dedicated API-key instructions panel (unlike Gemini) — auth always
goes through the embedded terminal.

### Skills panel

`ProviderSkills.tsx` for codex:

```ts
codex: '~/.agents/skills/<skill-name>/SKILL.md'    // line 69, PROVIDER_SKILL_PATHS
```

Codex is **included** in `PROVIDER_SKILL_PATHS` (only opencode is excluded per
`Record<Exclude<SkillsProvider, 'opencode'>, string>` on line 67). The `~/.agents/skills/`
root is **shared with Gemini** — both providers track it independently in their
`getSkillSources` implementations.

Standard 5-minute TTL cache applies (`useProviderSkills.ts:25`). Codex has **no**
plugin skills (unlike Claude).

### MCP panel

Codex is the **only provider in the catalog whose MCP config is TOML**, not JSON or
JSONC. Storage:

- User scope: `~/.codex/config.toml`
- Project scope: `<workspace>/.codex/config.toml`

`@iarna/toml` for read/write. The matrix in `src/components/mcp/constants.ts:11-25`:

```ts
MCP_SUPPORTED_SCOPES.codex     = ['user', 'project']
MCP_SUPPORTED_TRANSPORTS.codex = ['stdio', 'http']
MCP_PROVIDER_BUTTON_CLASSES.codex = 'bg-gray-800 hover:bg-gray-900 ...'
MCP_SUPPORTS_WORKING_DIRECTORY.codex = true   // shares with gemini
```

TOML field mapping (`codex-mcp.provider.ts:63-94` and `:96-134`):

| UI field | stdio TOML | http TOML |
|---|---|---|
| `command` | `command` | — |
| `args` | `args` | — |
| `env` | `env` | — |
| `envVars` | `env_vars` | — |
| `cwd` | `cwd` | — |
| `url` | — | `url` |
| `headers` | — | `http_headers` |
| `bearerTokenEnvVar` | — | `bearer_token_env_var` |
| `envHttpHeaders` | — | `env_http_headers` |

**Codex-only UI fields** are gated by `showCodexOnlyFields = provider === 'codex' && !isGlobalMode`
(`McpServerFormModal.tsx:121`). When true, the modal exposes the three TOML-specific
fields above (`envVars`, `bearerTokenEnvVar`, `envHttpHeaders`) which Claude/Gemini
hide but codex's wire format requires.

`McpServers.tsx:277-282` has a codex-specific help banner that omits the team feature
card (the team feature isn't available for codex). `mcpFormatting.ts:143, 146, 149, 167`
formats the TOML-specific field labels.

Standard 30-second TTL cache (`useMcpServers.ts:52-53`).

### Permissions

`CodexPermissions` (`PermissionsContent.tsx:479-580`, type at `:473-477`) is the
**only dedicated codex React component**. The function renders three radio cards
(`default`, `acceptEdits`, `bypassPermissions`) with a `<details>` technical-info
panel that documents the Codex SDK's `sandboxMode` / `approvalPolicy` mapping:

```ts
// PermissionsContent.tsx:701 (dispatcher)
if (props.agent === 'codex') {
  return <CodexPermissions {...props} />;
}
```

The capability row (`provider-capabilities.service.ts:51-59`):

```ts
codex: {
  provider: 'codex',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions'],   // 3 modes, no 'plan'
  defaultPermissionMode: 'default',
  supportsImages: false,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: true,
},
```

Consequences:

- The chat composer only ever renders 3 radio buttons for codex (no `plan`).
- **`useChatComposerState.ts:744`** downgrades `permissionMode === 'plan'` → `'default'` client-side before sending (the only provider-specific downgrade in the codebase).
- Codex has no `canUseTool` flow. Chat-websocket doesn't intercept anything mid-stream — the composer sends `permissionMode` and the gateway's chat path shells out to the SDK (see [Runtime CLI](#runtime-cli-serveropenai-codexjs)).

The codex strings document the SDK's `sandboxMode` / `approvalPolicy` mapping (in
`settings.permissions.codex.modes.{default,acceptEdits,bypassPermissions}`), which
follows Claude's permission-mode shape, **not** Gemini's (`default / autoEdit / yolo`).

### Icon + provider identity

- **Icon** — `src/components/llm-logo-provider/CodexLogo.tsx` (22 lines). A single-path
  OpenAI Codex six-petal crystal mark at `viewBox="100 100 520 520"`, `fill="currentColor"`.
  Monochrome — inherits text color rather than baking in a brand hue. Wired at
  `SessionProviderLogo.tsx:21-23`.
- **Color** — codex has **no brand `bg-*` accent** in the sidebar (`AgentSelectorSection.tsx:6-12, 26-28`).
  Falls through to the default neutral `bg-foreground/60`. The other four providers
  get brand colors (`claude→bg-blue-500`, `cursor→bg-purple-500`, `gemini→bg-indigo-500`,
  `opencode→bg-zinc-500`); codex is the only exception.
- **Provider lists** — `AGENT_PROVIDERS` (`constants.ts:42`), `CLI_PROVIDERS` (`provider-auth/types.ts:13`), `visibleAgents` in `AgentsSettingsTab.tsx:32`, and `loadProviderModels` enumeration in `useChatProviderState.ts:149` all include `'codex'`.
- **`PROVIDER_META`** in `ProviderSelectionEmptyState.tsx:26-32` —
  `{ id: 'codex', name: 'OpenAI' }`. The only provider whose picker label is the
  vendor name "OpenAI" rather than the product name "Codex".
- **Localstorage keys** — `'codex-model'`, `'codex-settings'`.
- **AccountContent** — gray-themed card (`AccountContent.tsx:40-47`):

  ```ts
  codex: {
    name: 'Codex',
    bgClass: 'bg-muted/50',
    borderClass: 'border-gray-300 dark:border-gray-600',
    textClass: 'text-gray-900 dark:text-gray-100',
    subtextClass: 'text-gray-700 dark:text-gray-700',
    buttonClass: 'bg-gray-800 hover:bg-gray-900 active:bg-gray-950 ...',
  }
  ```

### Login flow

Unlike Gemini (which has its own dedicated API-key instructions panel), Codex uses
the **default embedded-terminal branch** in `ProviderLoginModal`. The two-step flow:

1. The modal embeds a `StandaloneShell` running `codex login --device-auth` (on
   `IS_PLATFORM`/SaaS) or `codex login` (self-hosted) — see
   `ProviderLoginModal.tsx:36-38`.
2. After `onProcessComplete(exitCode)` fires (login successful), the modal stays
   open so the user can read the terminal output before manually closing it.
   `refreshProviderAuthStatuses()` is called after close.

The full URL/CRM flow for `codex login --device-auth` lives in the codex CLI itself;
CloudCLI only embeds the terminal that runs it.

### i18n

Locales covered: `en`, `es`, `fr`, plus all 12 base locales (`de`, `en`, `es`, `fr`, `it`,
`ja`, `ko`, `ru`, `tr`, `zh-CN`, `zh-TW`). Keys:

- `chat.messageTypes.codex: "Codex"`
- `chat.codex.{permissionMode, modes.*, descriptions.*, technicalDetails}`
- `chat.providerSelection.readyPrompt.codex: "Listo para usar Codex con {{model}}…"`
- `sidebar.codexSession: "Sesión de Codex"`
- `settings.agents.account.codex.description: "Asistente de IA OpenAI Codex"`
- `settings.permissions.codex.*` — note these take Claude's permission-mode shape
  (`default / acceptEdits / bypassPermissions`), **not** Gemini's (`default / autoEdit / yolo`).
  The Codex strings document the Codex SDK's `sandboxMode` / `approvalPolicy` mapping.
- `settings.mcpServers.description.codex: "Model Context Protocol servers provide additional
  tools and data sources to Codex"`

**Gap:** `settings.onboarding.agents.providerTitles.codex` exists **only** in `en`
and `es` ("OpenAI Codex") — missing in the other 10 locales. Since Spanish is the
project default and `es` is present, Spanish-first UX is not broken. i18next falls
back to English for users with non-`en`/`es` locales until those locales are filled in.

## End-to-end message flow

1. User types a message in the chat panel; provider = `codex`; model picked from
   `providerModelCatalog.codex` (or fallback `gpt-5.4`).
2. Frontend sends `chat.send { sessionId, content, options: { cwd, model, permissionMode } }`
   over WebSocket.
3. `handleChatSend` resolves the session via `sessionsDb.getSessionById` and builds
   `runtimeOptions` with `sessionId: session.provider_session_id ?? undefined`, `cwd`, and a
   permission mode that's been downgraded from `'plan'` to `'default'` if needed.
4. `spawnFns.codex = queryCodex` invokes
   `providerModelsService.resolveResumeModel('codex', sessionId, options.model)` to pick the model.
5. `queryCodex` instantiates `new Codex()`, calls `codex.startThread(threadOptions)` (or
   `codex.resumeThread(sessionId, threadOptions)` if `sessionId` is set), and awaits
   `thread.runStreamed(command, { signal })`.
6. The Codex SDK streams events. `queryCodex` consumes them with `for await (const event of streamedTurn.events)`:
   - On `thread.started`, captures the lazily-discovered session id, registers it in
     `activeCodexSessions`, calls `ws.setSessionId(...)`, and emits `kind: 'session_created'`.
   - On `item.completed`, runs `transformCodexEvent` → `sessionsService.normalizeMessage('codex', ...)`
     → `sendMessage(ws, normalized)` for each `NormalizedMessage` frame.
   - On `turn.completed`, extracts a token budget from `event.usage` and emits
     `kind: 'status', text: 'token_budget'`.
   - On `turn.failed`, sets `terminalFailure` and fires `notifyRunFailed(...)` (the actual
     `error` and `complete` frames come from the terminal `complete` emit below).
7. After the loop:
   - If the run was **not** aborted, `createCompleteMessage({ provider: 'codex', sessionId, exitCode: terminalFailure ? 1 : 0 })` is emitted. On success, `notifyRunStopped(...)` is fired.
   - If the run was aborted, the terminal `complete` is suppressed — the chat-run registry
     has already issued one with `aborted: true`.
   - In the catch block (non-abort errors), `error` and `complete` frames are emitted, then
     `notifyRunFailed(...)` (lines 384–408).
   - The `finally` block flips `session.status` to `'aborted'` if it was aborted, else
     `'completed'` (lines 410–418).
8. The frontend sees the terminal frame, clears its streaming state, and renders the final answer.

### Abort sub-flow

Frontend sends `chat.abort` → `abortFns.codex = abortCodexSession` (lines 426–441). Marks
`session.status = 'aborted'`, calls `session.abortController.abort()`. The main loop notices
on the next iteration via `abortController.signal.aborted` or `session.status === 'aborted'`,
exits cleanly, and skips the terminal `complete`.

## Debugging & verification

**Code-named coverage lives in shared tests — there is no `codex-cli.test.js` / `codex-*.test.ts`**.
Run:

```
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/mcp.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/skills.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/provider-models.service.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/database/tests/sessions-provider-mapping.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/websocket/tests/chat-run-registry.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/routes/tests/commands.test.js
```

| Test | What it covers for codex |
|---|---|
| `server/modules/providers/tests/mcp.test.ts:99–169` | `providerMcpService.upsertProviderMcpServer('codex', ...)` for user/project scopes, stdio/http, and rejection of unsupported `local` / `sse`. |
| `server/modules/providers/tests/skills.test.ts:355–373` | Writes fixtures under `~/.codex/skills/.system` and verifies `providerSkillsService.listProviderSkills('codex', ...)` discovers cwd/parent/root/user/system skills. Also tests `addProviderSkills` / `removeProviderSkill` at lines 543–679. |
| `server/modules/providers/tests/provider-models.service.test.ts:61–65, 114–125` | Verifies the service invokes the codex adapter. |
| `server/modules/database/tests/sessions-provider-mapping.test.ts:74–80` | Registers a codex app session. |
| `server/modules/websocket/tests/chat-run-registry.test.ts:106–160` | Covers codex run registry entries. |
| `server/routes/tests/commands.test.js:32–44` | Exercises `executeModelsCommand` with `provider: 'codex'`. |

Logs worth grepping:

- `[Codex] Error: …` — error log (line 385) for non-abort failures.
- `Codex session file not found for session <id>` — `console.warn` (line 68) when
  `sessionsDb.jsonl_path` doesn't resolve.
- `[Codex] Failed to abort session <id>` — `console.warn` when `abortController.abort()` throws.
- `Codex not configured` — auth probe (`codex-auth.provider.ts:79`).
- `Codex CLI is not configured. Please set up authentication first.` — runtime disambiguation
  when `providerAuthService.isProviderInstalled('codex')` returns false (`openai-codex.js:391`).

## Known quirks

- **No plan mode.** Codex's `permissionModes` array is `['default', 'acceptEdits', 'bypassPermissions']` —
  no `'plan'`. The chat composer (`useChatComposerState.ts:744`) downgrades `'plan'` to
  `'default'` client-side. UI users never see the option in `CodexPermissions`.
- **No `cloudcli codex login` sub-command.** Authentication is delegated to the Codex CLI's
  own login flow, run from the embedded terminal in `ProviderLoginModal`. Do not add a CloudCLI
  login sub-command without first checking with the Codex CLI team.
- **Models cache is file-based, not API-based.** If `~/.codex/models_cache.json` is missing,
  `getSupportedModels()` returns the static `CODEX_FALLBACK_MODELS`. There is **no fallback
  call to the OpenAI API** in this file — CloudCLI deliberately doesn't issue live model
  enumeration requests. If you want the cache refreshed, run `codex models` in the shell.
- **Two parallel message-normalization paths** exist (`transformCodexEvent` →
  `normalizeMessage` for SDK events vs `getCodexSessionMessages` → `normalizeHistoryEntry`
  for historical JSONL). They're conceptually similar but operate on different input shapes.
  Don't refactor them to share code without first understanding that distinction.
- **`shell_command` is renamed to `'Bash'`** in the JSONL parser (lines 148–169) — useful for
  UI display, but means a tool-use named `shell_command` in the raw JSONL becomes a `Bash` tool
  call in the chat UI. Same trick applies to `apply_patch` → `Edit` (lines 180–219).
- **No log-noise demotion** for codex. Unlike opencode (which has a specific
  `process was terminated` demotion in `chat-websocket.service.ts:174`), codex errors always
  log at `console.error`. PM2 restarts will surface codex failures at error level — that's
  probably correct for codex because the SDK doesn't have an equivalent "child got killed by
  SIGTERM" semantic.
- **TOML not JSON.** MCP config (and the active model key) lives in TOML, so the Codex MCP
  facet is the only one in the catalog that uses `@iarna/toml` rather than JSON or JSONC.
  Be careful when reading `~/.codex/config.toml` — other Codex keys outside our schema are
  preserved on write (we read the file, add `mcp_servers`, and write the whole object back).
- **Six skill roots, only two writable by the user.** `~/.agents/skills` (user) and the
  three `.agents/skills` repo paths can be modified by the user; `/etc/codex/skills` (admin)
  and `~/.codex/skills/.system` (system) are read-only. Most users will only ever touch
  `~/.agents/skills` (Gemini and Codex share this root).
- **`onboarding.agents.providerTitles.codex` is missing in 10 of 12 locales.** Only `en` and
  `es` define it. Spanish-first UX is unaffected, but i18next falls back to English for users
  whose preferred locale is one of the missing 10. Fix when convenient; not blocking.
- **Stringly-typed `provider === 'codex'` checks** scattered across `server/index.js:34–36,
  120, 127, 1431–1456`, `server/routes/agent.js:10, 757, 865–866, 944, 970–979`,
  `server/modules/providers/services/sessions-watcher.service.ts:25`,
  `server/modules/providers/services/provider-capabilities.service.ts:51–59`,
  `server/modules/websocket/services/shell-websocket.service.ts:139–147, 478`. Renaming the
  provider is a multi-file find-and-replace.
- **`CODEX_FALLBACK_MODELS` is hardcoded with non-open-source model names** (`gpt-5.5`,
  `gpt-5.4`, etc.). These mirror the catalog snapshot CloudCLI was built against, not a live
  enumeration. If your Codex CLI exposes newer models, refresh the cache by running
  `codex models` so `models_cache.json` is regenerated.

## Auth resolution — 3-source cascade

`server/modules/providers/list/codex/codex-auth.provider.ts#checkCredentials` resolves
Codex credentials in strict priority order. The check only emits the literal
`'Codex not configured'` when **all three sources are empty or missing**.

### Priority order

| # | Source | `method` returned | When recognized |
|---|---|---|---|
| 1 | `~/.codex/auth.json` | `'credentials_file'` (OAuth) or `'api_key'` (top-level `OPENAI_API_KEY`) | `tokens.id_token` *or* `tokens.access_token` *or* top-level `OPENAI_API_KEY` |
| 2 | `~/.codex/config.toml` | `'config_toml'` | top-level `OPENAI_API_KEY`, OR top-level `experimental_bearer_token`, OR `[providers.*].apiKey`/`OPENAI_API_KEY`, OR **`[model_providers.*].experimental_bearer_token`**, OR `[model_providers.*].api_key`/`OPENAI_API_KEY` |
| 3 | `process.env.OPENAI_API_KEY` (or `OPENAI_KEY` / `CODEX_API_KEY`) | `'env_var'` | any of the three env vars is non-empty |

If none of the above resolve, the helper returns `{ authenticated: false, email: null, method: null, error: 'Codex not configured' }` and the UI shows the
red banner `Error: Codex not configured`.

### Why this matters — the `[model_providers.*]` block

Codex CLI does **not** use the schema `[providers.*]` for the user-facing endpoint
configuration. The actual schema for a custom model provider is `[model_providers.<name>]`
with an `experimental_bearer_token` field. A user that has only:

```toml
model_provider = "minimax"

[model_providers.minimax]
name = "MiniMax"
base_url = "https://api.minimax.io/v1"
experimental_bearer_token = "sk-cp-…"
wire_api = "responses"
```

…in their `~/.codex/config.toml` and **no `auth.json`** is fully authenticated from the
Codex CLI's perspective — but the old CloudCLI auth probe emitted `'Codex not configured'`
because it only checked `auth.json`. The fix in
`codex-auth.provider.ts:123-152` parses the TOML with `@iarna/toml` (already a
dependency for the codex MCP facet) and walks both `[providers.*]` and
`[model_providers.*]` blocks for any credential-shaped key. A helper
`hasCredentialKey()` at module bottom centralises the list of recognised field
names: `OPENAI_API_KEY`, `openai_api_key`, `apiKey`, `api_key`,
`experimental_bearer_token`.

### Tests

`server/modules/providers/tests/codex-auth.test.ts` (10 cases, all colocated):
`auth.json` with `id_token` → `'credentials_file'`; `auth.json` with `OPENAI_API_KEY` →
`'api_key'`; only `config.toml` with `OPENAI_API_KEY` → `'config_toml'`;
`[providers.*]` with `apiKey` → `'config_toml'`; `[model_providers.*]` with
`experimental_bearer_token` → `'config_toml'`; top-level `experimental_bearer_token`
→ `'config_toml'`; only `process.env.OPENAI_API_KEY` → `'env_var'`; nothing
present → `'Codex not configured'`; empty `auth.json {}` with `config.toml` →
falls through to `config_toml`; `config.toml` without any credential field →
emits `'Codex not configured'`.

Run from `server/`:

```
npx tsx --test modules/providers/tests/codex-auth.test.ts
```

## SDK spawn bug — `Codex Exec exited with code 1: Reading prompt from stdin...`

When invoking Codex via CloudCLI the first time, the chat driver can fail with:

```
[Codex] Error: Error: Codex Exec exited with code 1: Reading prompt from stdin...
    at CodexExec.run (.../@openai/codex-sdk/src/exec.ts:232:15)
    at Thread.runStreamedInternal (.../@openai/codex-sdk/src/thread.ts:97:24)
    at async queryCodex (server/openai-codex.js:293:22)
```

### What it means

`@openai/codex-sdk` wraps the `codex` CLI as a subprocess and **streams the prompt
to its stdin** instead of passing it as a positional argument. When the CLI does not
recognise the model name (or when `model_provider` cannot be resolved), it enters a
mode where it complains `"Reading prompt from stdin..."` and exits with code 1
because the SDK's `CodexExec.run()` was waiting for the prompt but didn't write it.

This is *especially* common when the user's `~/.codex/config.toml` declares a
**custom model provider** (like `[model_providers.minimax]` above). The SDK passes
`--model <userModel>` to the CLI, the CLI tries to resolve it against the
`model_provider = "minimax"` block, and if `experimental_bearer_token` is missing
or invalid the CLI bails before reading the prompt from stdin.

### Why direct CLI calls work

Invoking the CLI directly with the same args succeeds because the prompt is passed
as a positional argument, which is what the CLI expects in the fallback mode:

```bash
codex exec --model MiniMax-M3 --skip-git-repo-check --sandbox workspace-write "echo hello"
# → "Hello! How can I help you today?"
```

…with one warning:

```
warning: Model metadata for `MiniMax-M3` not found. Defaulting to fallback metadata;
this can degrade performance and cause issues.
```

So the CLI is **functioning** (it ran the prompt and got an answer), but the SDK
wrapper chokes on the model's metadata warning because it correlates it with
"stdin wasn't read" and bails.

### Workarounds

Until the SDK upstream fixes the race, three workarounds:

1. **Use a known model name** — change the model picker in the chat composer to a
   model whose metadata the SDK knows (e.g. `gpt-5.5`). This avoids the metadata
   warning entirely.
2. **Pass the prompt via stdin manually** (advanced) — open the embedded terminal,
   run `codex exec --model <m>`, type the prompt, hit Enter twice.
3. **Wait for SDK fix** — track `https://github.com/openai/codex/issues` for a
   resolution that handles the "model metadata missing" warning without exiting.

The runtime emits the error via `ws.send({ kind: 'error', content: stderrText })`
at `server/openai-codex.js:237-243` so the UI shows it as a red error card in the
stream.

## Interactive prompts UI

Codex has **`supportsPermissionRequests: false`** in
`server/modules/providers/services/provider-capabilities.service.ts:48`. This means:

- The CLI does not surface interactive prompts to CloudCLI's `permission_request`
  flow. All permission decisions go through the `--sandbox` and `--approval-policy`
  flags at spawn time (`openai-codex.js:197-216`):
  - `permissionMode: 'acceptEdits'` → `sandboxMode: 'workspace-write'`, `approvalPolicy: 'never'`
  - `permissionMode: 'bypassPermissions'` → `sandboxMode: 'danger-full-access'`, `approvalPolicy: 'never'`
  - `permissionMode: 'default'` → `sandboxMode: 'workspace-write'`, `approvalPolicy: 'untrusted'`
- `<PermissionRequestsBanner />` never appears in the chat composer for codex sessions
  because `pendingPermissionRequests` stays empty.
- `AskUserQuestionPanel` is **not** rendered. If the Codex CLI internally asks the
  user something via its own TUI, that interaction happens outside CloudCLI (in the
  embedded terminal if the user is running `codex login` from there).

The Codex chat composer still shows the `<CodexPermissions />` component
(`PermissionsContent.tsx`) which lets the user pick between the three modes. The
choice is forwarded to the SDK as spawn flags — the CLI then handles any
"approve this?" prompts internally, completely outside the WebSocket envelope.

See [`docs/providers/claude.md#interactive-prompts-ui`](./claude.md#interactive-prompts-ui)
for the full Claude interactive flow, and [`docs/providers/agente.md`](./agente.md)
for the cross-provider comparison matrix.

## Capabilities & UI support (Codex row)

| Property | Codex value | Source |
|---|---|---|
| Login command | `codex login` (or `codex login --device-auth` on SaaS) | `ProviderLoginModal.tsx:36-38` |
| Permission modes | `default` \| `acceptEdits` \| `bypassPermissions` | `useChatProviderState.ts` |
| `supportsPermissionRequests` | `false` | `provider-capabilities.service.ts:48` |
| Interactive UI | **No** — capability off; CLI handles decisions via `--approval-policy` | `openai-codex.js:197-216` |
| `tool_use` renderer | Rich (`BashCommandDisplay`, `ToolDiffViewer`, `FileListContent`, etc.) | `toolConfigs.ts` (same as Claude) |
| Custom providers | **Yes** — `[model_providers.*]` with `experimental_bearer_token` | `codex-auth.provider.ts:123-152` |
| Status | Production | — |

See [`docs/providers/agente.md`](./agente.md) for the full cross-provider comparison
table and the auth resolution matrix.

## Memory file convention

Codex CLI's `/memory` and `/init` builtins open the project's `AGENTS.md` for editing.

- **Filename**: `AGENTS.md` (literal, project root). This is the cross-agent convention adopted by Codex, OpenCode, and Qwen.
- **Auto-loaded**: Codex scans `<project>/AGENTS.md` (and parent directories up to the git root) on every prompt. Unlike Claude's three-source cascade, Codex has a single project-root convention.
- **UI surface**: Listed in the Command Palette under "Built-in commands" as `/memory` (or `/init` to scaffold a fresh file). CloudCLI lists it as-is from the provider.
- **Symbiosis with skills**: Skills (under `~/.agents/skills/<name>/SKILL.md`) and the memory file share the `~/.agents/` root — see "Skills panel" above for the lookup rules.

## See also

- `server/modules/providers/README.md` — canonical provider-facet guide.
- `server/modules/websocket/README.md` — message envelope and per-run event log.
- `CLAUDE.md` — top-level project conventions and the CloudCLI runtime model.
- `docs/providers/README.md` — index of provider documentation (renamed to `agente.md`; this link may break — see `docs/providers/agente.md`).
- `docs/providers/opencode.md` — sibling subprocess+JSONL comparison (opencode shells out, codex
  uses the SDK; both have shared session storage strategies).
- `docs/providers/gemini.md` — sibling subprocess+NDJSON comparison (gemini is also a shell-out
  provider, but with TOML-style permission semantics different from codex's).
- `docs/providers/claude.md` — sibling in-process SDK comparison (Claude's `@anthropic-ai/claude-agent-sdk`
  pattern parallels Codex's `@openai/codex-sdk` pattern; both have per-tool-call `StreamEvent`
  lifecycles).
