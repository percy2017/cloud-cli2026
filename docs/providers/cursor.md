# Cursor provider

This document explains how CloudCLI integrates [Cursor](https://www.cursor.com) as one of
its AI coding agents. Cursor is the **only terminal-agent CLI in CloudCLI's provider
catalog that spawns `cursor-agent`** (not just `cursor`) and stores its sessions in
**per-session content-addressed SQLite blob DAGs** (`~/.cursor/chats/<cwdHash>/<sessionId>/store.db`)
— not a single shared DB like opencode does. Combined with a workspace-trust retry
mechanism (`--trust` appended on the second spawn), Cursor is one of the most
operationally distinctive providers in the registry.

For the canonical guide on **adding a new provider** (facet contract, registration,
types), see `server/modules/providers/README.md`. This doc assumes you already know the
facet model and zooms in on how Cursor implements each one.

[cursor]: https://www.cursor.com

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
                 │  → spawnFn['cursor']       │
                 │  → spawnCursor()           │
                 └──────────────┬─────────────┘
                                │
                                ▼
        ┌──────────────────────────────────────────────┐
        │ spawnCursor                                  │
        │ server/cursor-cli.js                         │
        │                                              │
        │ cursor-agent [--resume=<id>] [-p <prompt>]   │
        │   --model <m> --output-format stream-json    │
        │   [-f | --trust]                              │
        └──────────────┬───────────────────────────────┘
                       │ stdio NDJSON (--output-format stream-json)
                       ▼
        ┌────────────────────────────────────────────────┐
        │ processCursorOutputLine()                      │
        │  - system/subtype:init → session_created       │
        │  - assistant → CursorSessionsProvider          │
        │      .normalizeMessage(...)                   │
        │  - result → terminal `complete`               │
        │     (exitCode: subtype==='success' ? 0 : 1)   │
        └──────────────┬─────────────────────────────────┘
                       │ NormalizedMessage
                       ▼
                ┌────────────────────────────┐
                │  Frontend (React)          │
                │  renders stream in UI      │
                └────────────────────────────┘
```

The shell path is **separate** — see [`server/modules/websocket/services/shell-websocket.service.ts:132-136`](../../server/modules/websocket/services/shell-websocket.service.ts#L132).
For an interactive PTY, CloudCLI spawns `cursor-agent` (no args, fresh session) or
`cursor-agent --resume="<id>"` (resume). Login happens inside this terminal with
`cursor-agent login`.

## Backend layout

Everything that "is" Cursor-from-CloudCLI's-point-of-view lives under
[`server/modules/providers/list/cursor/`][cursor-dir]:

| File | Role |
|---|---|
| `cursor.provider.ts` | Registry entry. Wires the six standard facets (`auth`, `models`, `mcp`, `skills`, `sessions`, `sessionSynchronizer`) — no extras. |
| `cursor-auth.provider.ts` | Auth facet. Probes `cursor-agent --version` and reads `cursor-agent status` (parses stdout for `Logged in as <email>` regex, `cursor-auth.provider.ts:109`). **No env vars, no API keys, no OAuth stored by CloudCLI** — auth is delegated entirely to the external CLI. |
| `cursor-models.provider.ts` | Models facet. **Dynamic** via `cursor-agent --list-models` (10 s timeout, `CURSOR_MODELS_TIMEOUT_MS = 10_000` at line 590) with a large hardcoded `CURSOR_FALLBACK_MODELS` fallback (line 22). Default = `'composer-2.5-fast'` (line 580). |
| `cursor-mcp.provider.ts` | MCP facet. Reads/writes **plain JSON** at `~/.cursor/mcp.json` (user) or `<workspace>/.cursor/mcp.json` (project). Scopes `['user', 'project']`, transports `['stdio', 'http']`. |
| `cursor-skills.provider.ts` | Skills facet. Three roots: project `<ws>/.agents/skills`, project `<ws>/.cursor/skills`, user `~/.cursor/skills`. Command prefix `/`. **Does not reuse Claude's catalog** (unlike opencode). |
| `cursor-sessions.provider.ts` | Sessions facet. Reads per-session SQLite blob DAGs from `~/.cursor/chats/<md5cwd>/<sessionId>/store.db` via lazy `better-sqlite3` (line 200). Filters internal `<user_info>` / `<system_reminder>` / `<user_query>` wrappers. |
| `cursor-session-synchronizer.provider.ts` | Synchronizer. Scans `~/.cursor/projects` for `.jsonl` transcripts (chokidar target `.jsonl`). Project path extracted from sibling `worker.log` (`workspacePath=...` regex, line 109). |

There is **no** `cursor-cli.ts` inside the provider folder — only `server/cursor-cli.js`
at the top level (the runtime driver). See the next section.

[cursor-dir]: ../../server/modules/providers/list/cursor/

## Runtime CLI: `server/cursor-cli.js`

This is the subprocess driver the gateway calls. It exports `spawnCursor`,
`abortCursorSession`, `isCursorSessionActive`, and `getActiveCursorSessions` (line 348–353).

### Subprocess args

`spawnCursor(command, options, ws)` assembles the CLI args in this order (cursor-cli.js:49–73):

```
cursor-agent
  [--resume=<sessionId>]
  [-p <prompt>]
  [--model <model>]
  --output-format stream-json
  [-f]                              // skip-permissions, when skipPermissions or toolsSettings.skipPermissions is set
  [--trust]                         // only on retry after workspace-trust prompt
```

Notes:

- `--resume=<id>` is added whenever `sessionId` is present (lines 53-56) — both fresh replies to existing sessions and brand-new sessions resume by id.
- `-p <prompt>` is the user message; it's required for the request to make sense.
- `--output-format stream-json` switches the CLI to NDJSON output (lines 64-67). Without it the CLI writes pretty terminal output the parser can't read.
- `-f` is the cursor CLI's "skip permissions" flag, equivalent to Claude's `--dangerously-skip-permissions` (cursor-log: `Using -f flag (skip permissions)` line 75-77).
- `--trust` is appended **only on a workspace-trust retry** (see below). It tells the cursor CLI to bypass the directory trust prompt.
- `cwd` is the per-chat working directory; `env` is `process.env` verbatim (line 137: `env: { ...process.env }`).
- `stdio: ['pipe', 'pipe', 'pipe']` — non-interactive. stdin is closed immediately (line 319).

### Workspace-trust retry (unique to Cursor)

When the cursor CLI is spawned in a fresh directory, it prompts the user to trust the
workspace. If the prompt is detected **and** the process exits non-zero, the driver
re-spawns with `--trust` appended. The detection lives in
`server/cursor-cli.js:14-19, 26` (regex patterns + matcher):

```js
const WORKSPACE_TRUST_PATTERNS = [
  /workspace trust required/i,
  /do you trust the contents of this directory/i,
  /working with untrusted contents/i,
  /pass --trust,\s*--yolo,\s*or -f/i
];

const isWorkspaceTrustPrompt = (text) => {
  return WORKSPACE_TRUST_PATTERNS.some((pattern) => pattern.test(text));
};
```

The retry branch (`:267-276`) checks three conditions before re-launching:

```js
if (
  runSawWorkspaceTrustPrompt &&
  code !== 0 &&
  !hasRetriedWithTrust &&
  !args.includes('--trust')
) {
  hasRetriedWithTrust = true;
  runCursorProcess([...args, '--trust'], 'trust-retry');
  return;
}
```

`hasRetriedWithTrust` is a local guard that prevents an infinite retry loop. No other
provider in the catalog has this mechanism — Claude reads `~/.claude/settings.json`
permissions, opencode has no trust prompt, codex/gemini gate via their `--yolo` /
`--approval-mode` flags directly without a two-pass flow.

### Communication protocol

Stream **NDJSON over stdio**. The parser lives inside `server/cursor-cli.js:153-225`
(the function `processCursorOutputLine`). It:

- Buffers partial stdout chunks, splits on newlines, and ignores empty lines.
- Tries `JSON.parse` per line. Non-JSON lines are emitted as `stream_delta` via the
  normalizer (line 225).
- Dispatches on `response.type`:

| Raw event | What `cursor-cli.js` does |
|---|---|
| `system` with `subtype: 'init'` | Captures `response.session_id` lazily; emits `kind: 'session_created'` over the WS (`:163-188`) |
| `assistant` | Calls `sessionsService.normalizeMessage('cursor', ...)` → emits `NormalizedMessage[]` frames (`:198`) |
| `result` | Sets `completeSent = true` (`:205-206`), emits terminal `complete` with `exitCode: subtype==='success' ? 0 : 1` (`:203-214`) |
| Other JSON shapes | Falls through; non-JSON lines emit as `stream_delta` |

### Mapping to `NormalizedMessage`

The conversion happens in `CursorSessionsProvider.normalizeMessage`
(`server/modules/providers/list/cursor/cursor-sessions.provider.ts:342`) — the live
event normalizer, distinct from `fetchHistory`. Per-message fields read:

- `providerOptions.cursor` (`cursor-sessions.provider.ts:472`) — for SDK-internal state that doesn't survive JSON serialization.
- `isInternalCursorText` / `isInternalCursorPart` (`cursor-sessions.provider.ts:34-55`) — strips `<user_info>`, `<system_reminder>` from the UI stream before forwarding.
- `unwrapUserQueryText` (`:57`) — strips `<user_query>` tags from user messages.

### One-terminal-complete contract

A second flag, `completeSent` (`cursor-cli.js:40`), ensures the WS receives
**exactly one** terminal `complete` per run, even when both the `result` line and the
`close` event fire. Three handlers guard against duplicate sends:

- `if (!completeSent && !cursorProcess.aborted)` at line 280 (close handler).
- `if (!completeSent && !cursorProcess.aborted)` at line 309 (error handler).
- The `result` branch (`:203-214`) sets `completeSent = true` first.

### Abort

`abortCursorSession(sessionId)` (line 326):

```js
function abortCursorSession(sessionId) {
  const process = activeCursorProcesses.get(sessionId);
  if (process) {
    console.log(`Aborting Cursor session: ${sessionId}`);
    // The abort handler sends the terminal complete (aborted: true); flag the
    // process so its close handler does not emit a second one.
    process.aborted = true;
    process.kill('SIGTERM');
    activeCursorProcesses.delete(sessionId);
    return true;
  }
  return false;
}
```

The flag `process.aborted = true` is what tells the `close` handler at line 280 to
suppress its own `complete`. SIGTERM is the signal; the cursor CLI doesn't have a
graceful-shutdown mode — it dies quickly.

### Timeout & GC

The driver has **no per-run timeout** (the cursor CLI is meant for long sessions). A
periodic GC sweep keeps the in-memory `activeCursorProcesses` map bounded; sessions
older than 30 minutes are evicted from the map regardless of status.

## Auth & environment

### Credential resolution

Cursor does **not** read any env vars or files for credentials. Authentication is
delegated entirely to the external `cursor-agent` CLI:

1. **`installed` check** (cursor-auth.provider.ts:17-24): `spawn.sync('cursor-agent', ['--version'], { stdio: 'ignore', timeout: 5000 })`.
2. **`authenticated` check** (cursor-auth.provider.ts:77): `spawn('cursor-agent', ['status'])` — parses stdout for the regex `/Logged in as ([email])/i` (line 109) or the bare `Logged in` (line 115). Returns `{ authenticated, email, method: 'cli' }`.
3. **`getStatus()`** (lines 45-52) — returns the standard `{ installed, provider: 'cursor', authenticated, email, method, error }` shape. When not installed → `error: 'Cursor CLI is not installed'`.

### Login flow in the UI

`ProviderLoginModal` (`src/components/provider-auth/view/ProviderLoginModal.tsx:32-34`)
embeds the cursor CLI in a `StandaloneShell`:

```tsx
if (provider === 'cursor') {
  return 'cursor-agent login';
}
```

```tsx
// ProviderLoginModal.tsx:49
if (provider === 'cursor') return 'Cursor CLI Login';
```

The terminal runs `cursor-agent login` interactively. After the CLI exits,
`refreshProviderAuthStatuses()` is called from the Agents tab
(`AgentsSettingsTab.tsx:40-43`) to flip the auth dot from gray to purple-500.

### `/api/cursor/config` (Cursor CLI's own config)

`server/routes/cursor.js:10-42` reads `~/.cursor/cli-config.json` and returns it to
the frontend. Falls back to a default shape built from `CURSOR_FALLBACK_MODELS.DEFAULT`
when the file is missing or invalid. The frontend
(`useChatProviderState.ts:354-374`) uses this to mirror Cursor's `modelId` into
`cursorModel` if the user hasn't set a local-storage override:

```ts
useEffect(() => {
  if (provider !== 'cursor') { return; }
  authenticatedFetch('/api/cursor/config')
    .then((response) => response.json())
    .then((data) => {
      if (!data.success || !data.config?.model?.modelId) { return; }
      const modelId = data.config.model.modelId as string;
      if (!localStorage.getItem('cursor-model')) {
        setCursorModel(modelId);
      }
    })
    ...
}, [provider]);
```

### No `cloudcli cursor …` sub-command

`server/cli.js` has **zero** `cursor` references (verified via grep). Cursor is not
surfaced in the CloudCLI CLI wrapper at all. There is no sandbox template for cursor
either — the chat gateway, the shell PTY, and the cursor backend's own CLI are the only
entry points.

## Models

### Dynamic catalog with hardcoded fallback

`getSupportedModels()` (`cursor-models.provider.ts:761`):

```ts
const stdout = await runCursorListModels();   // spawns cursor-agent --list-models
const models = parseModelsOutput(stdout);
return buildCursorModelsDefinition(models);
// on any throw → return CURSOR_FALLBACK_MODELS
```

`runCursorListModels()` (line 648) spawns the cursor CLI with a 10 s timeout
(`CURSOR_MODELS_TIMEOUT_MS`, line 590). On timeout, sends `SIGTERM`. The output is
parsed by `parseModelLine` (line 603) which strips ANSI escape codes, skips header /
`Loading` / `Tip:` lines, and parses `name - description` rows. `(current)` and
`(default)` markers drive the active-model selection (`buildCursorModelsDefinition`,
line 703).

`CURSOR_FALLBACK_MODELS` (line 22) is a large static list (~80 entries at the agent's
last count) covering: `auto`, multiple `composer-2` and `composer-2.5` tiers, several
`gpt-5.x-codex` variants, `claude-4-sonnet`, `gpt-5-mini`, `kimi-k2.5`, etc. **Default =
`'composer-2.5-fast'`** (line 580).

### Active model per session

`getCurrentActiveModel(sessionId)` (`:771`) is unusual among providers: it opens the
session's `store.db` (the SQLite blob DAG — see Sessions below) **read-only** via lazy
`better-sqlite3`, runs `SELECT value FROM meta WHERE key='0'`, hex-decodes the row to
JSON, and reads `metadata.lastUsedModel` (`:785-802`). This means Cursor's active
model lives **per-session** in the cursor CLI's own store, not in `~/.cursor/cli-config.json`.

`changeActiveModel(input)` (`:120`) delegates to the shared
`writeProviderSessionActiveModelChange('cursor', input)` helper.

### No cursor in `UNCACHED_PROVIDERS`

`provider-models.service.ts:20` lists `['claude', 'gemini']` for the no-cache set.
Cursor is **outside** that set, so the higher-level cache layer applies (catalogs
cached on disk keyed by mtime). The facet itself doesn't cache.

### Frontend fallback

`useChatProviderState.ts:14` — `FALLBACK_DEFAULT_MODEL.cursor = 'gpt-5.3-codex'`. Note
this is `'gpt-5.3-codex'`, not `'composer-2.5-fast'` — these are different defaults.
The frontend's localStorage fallback is the cursor-picker default; the backend's
catalog default is composer-2.5-fast. **This is a known divergence** between the
frontend's "if no model selected" path and the backend's `CURSOR_FALLBACK_MODELS.DEFAULT`.
Always use the live `/api/providers/cursor/models` response, not the frontend fallback
(see Quirks below).

## MCP

### Scopes & transports (plain JSON)

`CursorMcpProvider extends McpProvider` (cursor-mcp.provider.ts:18) with constructor:

```ts
super('cursor', ['user', 'project'], ['stdio', 'http']);
```

So **no `local` scope** (matches codex/opencode/gemini restrictions) and **no `sse`
transport** (only Gemini/Claude support SSE).

### Storage

MCP config is **plain JSON** at:

- User scope: `~/.cursor/mcp.json`
- Project scope: `<workspace>/.cursor/mcp.json`

`readJsonConfig` / `writeJsonConfig` helpers, keyed on `mcpServers`. Note the contrast
with opencode (which uses JSONC) and claude (which writes its own JSON-with-`mcpServers`
shape in `.mcp.json` + `.claude.json`).

### Field mapping

| UI field | Cursor JSON |
|---|---|
| `command` | `command` |
| `args` | `args` |
| `env` | `env` |
| `cwd` | `cwd` |
| `url` (http) | `url` |
| `headers` (http) | `headers` |

Cursor has no `envVars`, `envHttpHeaders`, or `bearerTokenEnvVar` fields
(unlike Codex, which has a codex-only branch in `McpServerFormModal` at line 121).

### Frontend constants

`src/components/mcp/constants.ts:11-25`:

```ts
MCP_PROVIDER_NAME_LABELS.cursor       = 'Cursor'
MCP_SUPPORTED_SCOPES.cursor           = ['user', 'project']
MCP_SUPPORTED_TRANSPORTS.cursor       = ['stdio', 'http']
MCP_PROVIDER_BUTTON_CLASSES.cursor    = 'bg-purple-600 hover:bg-purple-700 ...'
MCP_SUPPORTS_WORKING_DIRECTORY.cursor = false   // supports only codex/gemini
```

No cursor-specific UI block in `McpServerFormModal` (the modal falls through to the
default form using the constants above). No cursor-specific banner in `McpServers.tsx`.

## Skills

`CursorSkillsProvider extends SkillsProvider` (cursor-skills.provider.ts:11-13). Three
roots, all with `commandPrefix: '/'`:

| Scope | `rootDir` | Source line |
|---|---|---|
| `project` | `<workspace>/.agents/skills` | 23 |
| `project` | `<workspace>/.cursor/skills` | 28 |
| `user` | `~/.cursor/skills` | 33 |

`getGlobalSkillSource()` (lines 35-38) returns `~/.cursor/skills` as user-scoped.

**Cursor does NOT reuse Claude's catalog** (contrast opencode). It has its own skill
storage under `~/.cursor/skills`. The dual root `<ws>/.agents/skills` + `<ws>/.cursor/skills`
mirrors Gemini's pattern (which also has a dual layout with `.agents/` + `.gemini/`),
but unlike Gemini, Cursor's roots are filtered independently (no shared `~/.agents/skills/`
reading).

### Frontend (`src/components/skills/view/ProviderSkills.tsx`)

```ts
cursor: 'Cursor'                                     // line 62, PROVIDER_NAMES
cursor: '~/.cursor/skills/<skill>/SKILL.md'          // line 70, PROVIDER_SKILL_PATHS
```

Cursor is **included** in `PROVIDER_SKILL_PATHS` (only opencode is excluded per
`Record<Exclude<SkillsProvider, 'opencode'>, string>` on line 67).

## Sessions and sessionSynchronizer

### Storage — SQLite content-addressed blob DAG

Sessions live at `~/.cursor/chats/<md5(projectPath)>/<sessionId>/store.db`. Each
session is **its own SQLite database**, not a shared DB. The format is a content-addressed
blob DAG: rows are stored in `blobs(rowid, id, data)` and the conversation order is
reconstructed by walking parent/child references (`cursor-sessions.provider.ts:228`,
JSON blobs identified by first byte `0x7B` = `{`). Path-traversal is guarded
(`cursor-sessions.provider.ts:210-213`).

`loadCursorBlobs(sessionId)` (`:200`) lazy-imports `better-sqlite3`, opens
`readonly, fileMustExist: true`, and SELECTs all blobs. The driver then orders them
by their parent references and runs them through `normalizeMessage`.

`fetchHistory(sessionId, { limit, offset })` (`:371`) paginates via `sliceTailPage`.
`providerOptions.cursor` is the per-message SDK-internal state that doesn't survive
JSON serialization (`:472`); it's preserved through the normalizer.

### Filters for internal content

`isInternalCursorText` / `isInternalCursorPart` (`cursor-sessions.provider.ts:34-55`)
strip `<user_info>` and `<system_reminder>` wrappers before forwarding to the UI.
`unwrapUserQueryText` (`:57`) strips `<user_query>` tags from user messages. Without
these filters the UI would show internal tags mixed with the actual conversation.

### No token usage

`server/index.js:1303-1313` short-circuits the `/api/agent/token-usage` route for
cursor sessions — it returns `{ unsupported: true }`. Cursor's `provider-capabilities.service.ts:48`
declares `supportsTokenUsage: false`, and the route honors it. **The UI never sees a
token budget for cursor sessions.** This is unique among the production providers
(Claude, opencode, codex, gemini all return counts; only cursor doesn't).

### sessionSynchronizer

`CursorSessionSynchronizer` (`:39`). Watches `.jsonl` transcripts under
`~/.cursor/projects` (`:47, 51`). `synchronize(since?)` uses
`findFilesRecursivelyCreatedAfter(dir, '.jsonl', since)`. `synchronizeFile(path)`
early-returns unless `.jsonl`. Project path is extracted from a sibling `worker.log`
via the `workspacePath=(.*)` regex (`:109`). Session name = first
`<user_query>`-stripped user line (`:143-149`).

**Note the two storage locations**: the synchronizer indexes `.jsonl` files under
`~/.cursor/projects`, but history reading uses `store.db` under `~/.cursor/chats`. These
are distinct — `~/.cursor/projects` is the project-level worker log directory, while
`~/.cursor/chats/<cwdHash>/<id>/` is the per-session SQLite store. They're named the
same way on disk but their contents don't overlap.

### Watcher

Centralized in `server/modules/providers/services/sessions-watcher.service.ts`:

- `PROVIDER_WATCH_PATHS.cursor` (line 21) → `~/.cursor/projects`.
- `isWatcherTargetFile` (line 79) — falls into the default branch → `'.jsonl'` only (line 88).
- Shared chokidar (line 284): `{ interval: 6000, usePolling: true, depth: 6, ignoreInitial: true, persistent: true, followSymlinks: false }` (same config as opencode).
- Debounce 500 ms / max-wait 2000 ms (lines 54-55).
- On each event → `sessionSynchronizerService.synchronizeProviderFile('cursor', filePath)` (line 248), which delegates to `CursorSessionSynchronizer.synchronizeFile`.

## Registry and types

Cursor is in the `LLMProvider` union in both:

- [`server/shared/types.ts:68`](../../server/shared/types.ts) — `export type LLMProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';` (cursor is **4th** member)
- [`src/types/app.ts:1`](../../src/types/app.ts) — `export type LLMProvider = 'claude' | 'cursor' | 'codex' | 'gemini' | 'opencode';` (cursor is **2nd** member; the orderings differ between server and frontend)

Registry entry at [`server/modules/providers/provider.registry.ts:13`](../../server/modules/providers/provider.registry.ts):

```ts
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),   // ← 3rd in the registry map
  gemini: new GeminiProvider(),
  opencode: new OpenCodeProvider(),
};
```

### Capabilities

`server/modules/providers/services/provider-capabilities.service.ts:42-50`:

```ts
cursor: {
  provider: 'cursor',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  defaultPermissionMode: 'default',
  supportsImages: false,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: false,    // ← unique: only cursor has this = false
},
```

Three things are noteworthy:

1. Cursor has **all four** permission modes (`plan` is kept; Codex drops it).
2. **`supportsTokenUsage: false`** — see the Sessions section for what this means in practice.
3. **`supportsPermissionRequests: false`** — Cursor's CLI does not surface interactive prompts to CloudCLI's `permission_request` flow. All permission decisions go through the `-f` flag at runtime.

[registry]: ../../server/modules/providers/provider.registry.ts
[shared-types]: ../../server/shared/types.ts
[app-types]: ../../src/types/app.ts

## UI integration

> **The UI surface shared by all 5 providers is documented in detail under
> `docs/providers/claude.md` → "UI integration"** (Header tabs / Chat tab / Shell CLI tab
> / Sidebar / Auth-status / Skills panel / MCP panel / Permissions). This section zooms
> in on **cursor-specific deltas**, not on the parts that are common across providers.

### Cursor at a glance

| Aspect | Cursor value | Source |
|---|---|---|
| Icon | `CursorLogo.tsx` — 5-path isometric stacked-cube SVG, `viewBox="0 0 24 24"`, `fill="currentColor"` at opacities `.39/.6/.72/.8/.95` | `src/components/llm-logo-provider/CursorLogo.tsx`; `SessionProviderLogo.tsx:17-19` |
| Provider list position | 2nd in `AGENT_PROVIDERS` / `CLI_PROVIDERS`; 3rd in `provider.registry.ts`; **`AGENT_PROVIDERS` and `src/types/app.ts` differ from `server/shared/types.ts`** | `constants.ts:42`; `provider.registry.ts:13`; `app.ts:1`; `shared/types.ts:68` |
| Sidebar dot color | `bg-purple-500` | `AgentSelectorSection.tsx:26` |
| `PROVIDER_META` vendor label | `name: 'Cursor'` (the product name, not vendor) | `ProviderSelectionEmptyState.tsx:30` |
| Permission modes (UI) | `['default', 'acceptEdits', 'bypassPermissions', 'plan']` — all four, including `plan` | `useChatProviderState.ts:28`; `provider-capabilities.service.ts:44` |
| Default model fallback (frontend) | `'gpt-5.3-codex'` (note: this differs from backend `CURSOR_FALLBACK_MODELS.DEFAULT = 'composer-2.5-fast'` — see Quirks) | `useChatProviderState.ts:14` |
| Backend default model | `'composer-2.5-fast'` | `cursor-models.provider.ts:580` |
| Login command | `cursor-agent login` (no SaaS branch, no `--device-auth`) | `ProviderLoginModal.tsx:32-34` |
| Modal title | `'Cursor CLI Login'` | `ProviderLoginModal.tsx:49` |
| Auth endpoint | `/api/providers/cursor/auth/status` | `src/components/provider-auth/types.ts:17` |
| Skill path display | `~/.cursor/skills/<skill-name>/SKILL.md` (cursor is the only provider whose name matches the package's own dir convention) | `ProviderSkills.tsx:70` |
| MCP scopes | `['user', 'project']` (no `local`) | `src/components/mcp/constants.ts:11-25` |
| MCP transports | `['stdio', 'http']` (no `sse`) | same |
| AccountContent card | purple-themed | `AccountContent.tsx:32-39` |
| Onboarding card | `bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800` | `AgentConnectionsStep.tsx:18-22` |
| Code-named UI fields | none — `showCodexOnlyFields` is codex-exclusive | `McpServerFormModal.tsx:121` |
| Token usage in UI | **never shown** (capability `supportsTokenUsage: false`) | `provider-capabilities.service.ts:48` |
| Locales | `en`, `es`, `fr` + all 12 base locales (`de`, `it`, `ja`, `ko`, `ru`, `tr`, `zh-CN`, `zh-TW`); `onboarding.agents.providerTitles.cursor` missing in non-`en`/`es` locales | `chat.json`, `settings.json` |

### Header tabs (cursor perspective)

The header tab switcher (`MainContentTabSwitcher.tsx:34-53`) is **provider-agnostic** —
no cursor-specific tab exists. The shell tab starts `xterm.js` and forwards `provider:
'cursor'` to `buildShellCommand` on the server:

```ts
// server/modules/websocket/services/shell-websocket.service.ts:132-136
if (provider === 'cursor') {
  if (resumeSessionId) return `cursor-agent --resume="${resumeSessionId}"`;
  return 'cursor-agent';
}
```

The first-time cursor shell session runs the bare `cursor-agent` binary. Resuming a
session passes `--resume="<id>"`. There is **no** trust retry on the shell path (the
shell PTY is interactive; the user answers the trust prompt themselves). See
`claude.md → Shell / CLI tab` for the full transport description.

### Chat tab — cursor-specific bits

The chat panel is shared across all 5 providers (`ChatInterface.tsx`). The cursor
branches:

- **`useChatProviderState.ts:81-83`** manages `cursorModel` / `setCursorModel` separately from the other four slots, persisted under `localStorage['cursor-model']`.
- **`useChatProviderState.ts:275-286`** reconciles the model catalog effect for cursor (no special-casing — same pattern as the other four).
- **`useChatProviderState.ts:354-374`** is **cursor-only** — a dedicated effect that polls `/api/cursor/config` (which serves `~/.cursor/cli-config.json`) and copies the cursor CLI's `modelId` into `cursorModel` if the user hasn't already set a local-storage override:

  ```ts
  useEffect(() => {
    if (provider !== 'cursor') { return; }
    authenticatedFetch('/api/cursor/config')
      .then((response) => response.json())
      .then((data) => {
        if (!data.success || !data.config?.model?.modelId) { return; }
        const modelId = data.config.model.modelId as string;
        if (!localStorage.getItem('cursor-model')) {
          setCursorModel(modelId);
        }
      })
      ...
  }, [provider]);
  ```

  None of the other 4 providers have this effect. It's cursor-specific because the cursor CLI's own `cli-config.json` is the most authoritative source for "what model did the user last pick" — it overrides the frontend's localStorage on first mount.

- **`ProviderSelectionEmptyState.tsx:153-173`** writes `localStorage['cursor-model']` when the user picks a model in the picker. Cursor is the **fallback** else branch (lines 167-170).
- **`useChatComposerState.ts:695-720`** uses `'cursor-tools-settings'` as the localStorage key for cursor's tools settings (separate from the other providers).
- **`useChatComposerState.ts:745`** — **no** cursor-specific downgrade clause (the only provider-specific downgrade is codex's `plan → default`). Cursor's `plan` mode is sent to the cursor CLI unchanged.

### Shell / CLI tab — cursor spawn command

The cursor CLI integrates into the `/shell` WebSocket transport in two distinct ways:

**PTY mode** (`shell-websocket.service.ts:132-136`): the regular shell tab spawns
`cursor-agent` (fresh) or `cursor-agent --resume="<id>"` (resume). The user interacts
with the cursor CLI's native terminal UI — CloudCLI does not parse its output (only
provides the terminal emulator).

**Login detection** (`shell-websocket.service.ts:269`): if `initialCommand` contains
`cursor-agent login`, it's flagged as `isLoginCommand` and forces a fresh PTY session.
This is how `ProviderLoginModal`'s embedded terminal runs the login command.

There is **no chat-mode shell integration** for cursor — running `cursor-agent` inside
the terminal is a TTY-only experience, not the streaming-JSON spawn that
`spawnCursor` uses for the chat path. Users who want cursor's chat-style experience
must use the chat tab, not the shell tab.

### Sidebar left sessions list

The sidebar is shared across all providers (see `claude.md → Sidebar left sessions list`
for the data flow). Cursor deltas:

- **Provider label** — `SidebarSessionItem.tsx` renders `<SessionProviderLogo provider="cursor" />`, which dispatches to `<CursorLogo>` (the stacked-cube SVG).
- **No provider filter** — `getAllSessions` (`src/components/sidebar/utils/utils.ts:99-106`) returns every session regardless of provider.
- **`useProjectsState.handleSidebarRefresh` (`:841-887`)** preserves `__provider: 'cursor'` across refreshes.
- **Sidebar's session list = provider source-of-truth** — selecting a cursor session sets `__provider === 'cursor'`, which `useChatProviderState.ts:337-344` copies into `localStorage['selected-provider']`, switching the chat composer's active provider.

### Auth-status surface

The hook is `useProviderAuthStatus` (`src/components/provider-auth/hooks/useProviderAuthStatus.ts`).
For cursor the endpoint is `/api/providers/cursor/auth/status`
(`provider-auth/types.ts:17`). The server-side response comes from
`cursor-auth.provider.ts#getStatus()`:

```ts
{ installed, provider: 'cursor', authenticated, email, method, error }
```

`installed` comes from `spawn.sync('cursor-agent', ['--version'], ...)`; `authenticated`
and `email` come from parsing `cursor-agent status` stdout for `Logged in as <email>`
(regex).

**Login redirect.** `AgentsSettingsTab.tsx:40-43` renders the cursor row:

```ts
cursor: {
  authStatus: providerAuthStatus.cursor,
  onLogin: () => onProviderLogin('cursor'),
},
```

`Settings.tsx:228-235` renders `ProviderLoginModal` with `provider="cursor"`, which
runs `cursor-agent login` inside the embedded `StandaloneShell`. After exit,
`refreshProviderAuthStatuses()` is called.

### Skills panel

`ProviderSkills.tsx` for cursor:

```ts
cursor: 'Cursor'                                  // line 62, PROVIDER_NAMES
cursor: '~/.cursor/skills/<skill>/SKILL.md'       // line 70, PROVIDER_SKILL_PATHS
```

Cursor **is** included in `PROVIDER_SKILL_PATHS` — only opencode is excluded per
`Record<Exclude<SkillsProvider, 'opencode'>, string>` (line 67). The `providerPath` is
shown to users. Standard 5-minute TTL cache applies
(`useProviderSkills.ts:25`).

The skills discovery maps to three roots: `<ws>/.agents/skills`, `<ws>/.cursor/skills`,
`~/.cursor/skills`. All prefixed `/`.

### MCP panel

Standard provider matrix in `McpServers.tsx` (no provider-specific UI block for
cursor):

```ts
MCP_SUPPORTED_SCOPES.cursor     = ['user', 'project']
MCP_SUPPORTED_TRANSPORTS.cursor = ['stdio', 'http']
MCP_PROVIDER_BUTTON_CLASSES.cursor = 'bg-purple-600 hover:bg-purple-700 active:bg-purple-800'
MCP_SUPPORTS_WORKING_DIRECTORY.cursor = false
```

`McpServerFormModal.tsx:121` defines `showCodexOnlyFields = provider === 'codex' && !isGlobalMode`
— **cursor has no equivalent**. The modal renders the standard form with the two
scopes + two transports from the matrix above. No banner / no `cloudcli-*` exclusive
fields (the `cloudcli-*` managed rows render in the cursor list like everywhere else).

`mcpServers` lives at `~/.cursor/mcp.json` (user) or `<ws>/.cursor/mcp.json` (project).
Plain JSON, no JSONC, no `local` scope, no `sse` transport.

### Permissions

Cursor has a **dedicated `CursorPermissions` component** in
`src/components/settings/view/tabs/agents-settings/sections/content/PermissionsContent.tsx:273`
— one of two providers with a custom UI (alongside `CodexPermissions`).

The component:

- Props (`:263-272`): `skipPermissions`, `onSkipPermissionsChange`, `allowedCommands[]`, `onAllowedCommandsChange`, `disallowedCommands[]`, `onDisallowedCommandsChange`.
- Mapping to the cursor CLI flags: `skipPermissions: true` → `-f` flag at runtime; `allowedCommands[]` → `--allow-command`; `disallowedCommands[]` → `--deny-command`.
- Mounted when `props.agent === 'cursor'` (dispatch at `:693-694`).

The capability row (`provider-capabilities.service.ts:42-50`) declares
`permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan']` —
**all four modes**, including `plan` (unlike Codex which has only three). The chat
composer passes `permissionMode` to the cursor runtime unchanged — no downgrade
clause in `useChatComposerState.ts:745`.

### Icon + provider identity

- **Icon** — `src/components/llm-logo-provider/CursorLogo.tsx`. Five triangular
  paths forming a stacked-cube wireframe at `viewBox="0 0 24 24"`, each path filled
  with `currentColor` at varying opacity. Wired at `SessionProviderLogo.tsx:17-19`.
- **Brand color** — `bg-purple-500` for the sidebar dot (`AgentSelectorSection.tsx:26`).
- **AccountContent** — purple-themed card (`AccountContent.tsx:32-39`).
- **Onboarding** — purple-themed card (`AgentConnectionsStep.tsx:18-22`).

## End-to-end message flow

1. User types a message in the chat panel; provider = `cursor`; model picked from
   `/api/providers/cursor/models` or the local `gpt-5.3-codex` fallback.
2. Frontend sends `chat.send { sessionId, content, options: { cwd, model, permissionMode, skipPermissions } }` over WebSocket.
3. `handleChatSend` resolves the session via `sessionsDb.getSessionById` and builds `runtimeOptions` with `sessionId: session.provider_session_id ?? undefined`, `cwd`, and the resolved model.
4. `spawnFns.cursor = spawnCursor` invokes `providerModelsService.resolveResumeModel('cursor', sessionId, options.model)`.
5. `spawnCursor` assembles args:
   ```
   cursor-agent [--resume=<id>] -p <prompt> --model <m> --output-format stream-json [-f]
   ```
   then spawns via `child_process.spawn` (POSIX) or `cross-spawn` (Windows).
6. The cursor CLI writes NDJSON to stdout. `processCursorOutputLine` parses each line:
   - First `system`/`subtype:init` → captures `session_id` lazily, registers in `activeCursorProcesses`, emits `kind: 'session_created'`.
   - `assistant` lines → `sessionsService.normalizeMessage('cursor', ...)` → `NormalizedMessage[]` → `sendMessage(ws, msg)`.
   - `result` line → sets `completeSent = true`, emits terminal `complete` with `exitCode: subtype==='success' ? 0 : 1`.
7. On close event:
   - If `runSawWorkspaceTrustPrompt && code !== 0 && !hasRetriedWithTrust` → re-spawn with `--trust` appended. Loop ends here (the `return` at line 277 prevents the close handler from continuing).
   - Else if `!completeSent && !cursorProcess.aborted` → emit terminal `complete` with the actual exit code.
8. On abort: `abortCursorSession(sessionId)` → SIGTERM + set `process.aborted = true`. The close handler skips its own complete; the chat-run-registry has already issued one with `aborted: true`.
9. The frontend receives the terminal frame, clears streaming state, renders the final answer.

## Auth & environment (full reference)

Already documented above. Quick recap of the **uniqueness**:

- **`spawn.sync('cursor-agent', ['--version'], { timeout: 5000 })`** is the only probe (auth, lines 17-24).
- **`spawn('cursor-agent', ['status'])`** parses `Logged in as <email>` (regex line 109). No env-var fallback, no OAuth file — CloudCLI reads **nothing** other than the cursor CLI's own stdout.
- **No `cloudcli cursor` CLI sub-command**. Login happens only via the embedded `StandaloneShell`.

## Unique behaviors (vs other providers)

Cursor has several features that no other provider in the catalog does:

1. **Per-session SQLite blob DAG** at `~/.cursor/chats/<md5cwd>/<id>/store.db` —
   not a shared DB like opencode, not JSONL like claude, not chunked JSONL like gemini.
2. **Workspace-trust retry** — when the cursor CLI exits non-zero after a trust prompt,
   `server/cursor-cli.js:267-276` re-spawns with `--trust` appended. No other provider
   has a two-pass spawn pattern.
3. **`/api/cursor/config` config-mirror** — `useChatProviderState.ts:354-374` polls
   the cursor CLI's own `~/.cursor/cli-config.json` to sync `cursorModel`. None of
   the other 4 providers expose a `~/.cursor/...`-shape endpoint.
4. **No token usage** — `supportsTokenUsage: false` means `/api/agent/token-usage`
   short-circuits to `unsupported: true` (`server/index.js:1303-1313`). The UI never
   shows a context-window indicator on cursor sessions.
5. **`-f` flag** — analogous to claude's `--dangerously-skip-permissions`, the
   cursor CLI has `-f` (cursor-cli.js:73). CloudCLI passes it when `skipPermissions`
   or `toolsSettings.skipPermissions` is true.
6. **Per-session active model** — `getCurrentActiveModel(sessionId)` opens
   `store.db` read-only and reads `metadata.lastUsedModel` from the session's own
   metadata (`cursor-models.provider.ts:785-802`). Other providers read from a
   single config file.
7. **Two distinct storage paths** — synchronizer indexes `~/.cursor/projects/*.jsonl`
   for listing; sessions read `~/.cursor/chats/<cwdHash>/<id>/store.db` for
   history. Two different layouts under the same `~/.cursor` root.
8. **No plugin skills, no slash commands, no subagent tools** — Cursor's CLI doesn't
   surface any of those constructs. The Claude-style `<command-name>/<command-message>`
   tag filter doesn't apply.
9. **All four permission modes** (`plan` included) — `provider-capabilities.service.ts:44`
   has `['default', 'acceptEdits', 'bypassPermissions', 'plan']`. Codex is the
   outlier with only three; cursor matches Gemini/Claude.
10. **Dedicated `CursorPermissions` UI** — only Codex and Cursor have provider-specific
    React permission components in `PermissionsContent.tsx`. Claude/Gemini/OpenCode
    share generic containers.

## Debugging & verification

**Cursor has zero dedicated tests** as of the initial commit — no `cursor-cli.test.js`,
no `cursor-*.test.ts`. Coverage is incidental:

- `server/modules/providers/tests/mcp.test.ts` — cursor section (user/project scopes, stdio/http, rejection of `local`/`sse`).
- `server/modules/providers/tests/skills.test.ts` — cursor section (3 roots, save/remove).
- `server/modules/providers/tests/provider-models.service.test.ts` — cursor mock invocation.
- `server/modules/database/tests/sessions-provider-mapping.test.ts` — cursor app session registration.
- `server/modules/websocket/tests/chat-run-registry.test.ts` — cursor run registry entries.

Run them with:

```
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/mcp.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/skills.test.ts
PATH=/opt/node22/bin:$PATH npx tsx --test server/modules/providers/tests/provider-models.service.test.ts
```

Logs worth grepping:

- `Spawning Cursor CLI: cursor-agent <args>` — every chat spawn (cursor-cli.js:133).
- `Using -f flag (skip permissions)` — `-f` was added because `skipPermissions` is true (cursor-cli.js:75-77).
- `Retrying Cursor CLI with --trust after workspace trust prompt` — workspace-trust retry fired (cursor-cli.js:128).
- `Aborting Cursor session: <id>` — `abortCursorSession` called (cursor-cli.js:331).
- `Cursor config not found or invalid` — `/api/cursor/config` fallback to default shape (routes/cursor.js:27).
- `Cursor CLI is not installed` — auth probe (cursor-auth.provider.ts).
- `Cursor AI-powered code editor` — i18n description key (settings.json).

## Known quirks

- **Default-model divergence.** The backend's `CURSOR_FALLBACK_MODELS.DEFAULT` is `'composer-2.5-fast'`, but the frontend's `FALLBACK_DEFAULT_MODEL.cursor` is `'gpt-5.3-codex'`. When the live `/api/providers/cursor/models` endpoint returns a list, the UI uses the response. When it doesn't (offline / cached), the frontend falls back to `gpt-5.3-codex` — which may not be in the parsed list. Always use the live response.
- **`-f` is the cursor-CLI flag for skip-permissions, not a Claude-style `--dangerously-skip-permissions`.** Different names map to the same semantic in CloudCLI (`toolsSettings.skipPermissions: true`).
- **Workspace-trust retry is unconditional on first non-zero exit after a trust prompt.** If the user runs `cursor-agent` from a directory the cursor CLI doesn't trust, the first chat spawn silently retries with `--trust`. Don't be surprised by a "why is the second run passing?" behavior.
- **Per-session SQLite stores are write-once-from-the-CLI, read-only-from-CloudCLI.** CloudCLI never writes to `store.db`. If a session seems "stuck" on an old model, check whether the cursor CLI's own `cli-config.json` and the session's `metadata.lastUsedModel` agree — they can drift.
- **No log-noise demotion** for cursor — unlike opencode, cursor runtime failures stay at `console.error`. If you see `[Chat] Provider runtime "cursor" failed`, it's a real error.
- **`onProviderLogin('cursor')` only works if `cursor-agent` is installed.** If the binary isn't on PATH (or the install probe timed out), the Providers tab can't flip the dot. The user has to install the cursor CLI externally first.
- **Two distinct storage paths** (`~/.cursor/projects/*.jsonl` vs `~/.cursor/chats/<id>/store.db`). A `.jsonl` from `projects/` and a `store.db` from `chats/` for the same session are not interchangeable.
- **The `provider === 'cursor'` string** appears in at least 8 files (`server/index.js:30-32, 119, 126, 194, 1303`; `server/cursor-cli.js`, `server/routes/cursor.js`, `server/shared/types.ts:68`, etc.). Renaming the provider is a multi-file find-and-replace.
- **`onboarding.agents.providerTitles.cursor` is missing in 8 of 12 locales.** Only `en` and `es` define it. Spanish-first UX is unaffected (es is present), but i18next falls back to English for users whose preferred locale is one of the missing 8.
- **No `cloudcli cursor …` sub-command exists** — login is PTY-only via `ProviderLoginModal`. If you find yourself looking for `cloudcli cursor login`, it doesn't exist; use the embedded terminal instead.
- **`CursorDbBlob`, `CursorJsonBlob`, `CursorMessageBlob`** types live in `cursor-sessions.provider.ts:17-32`. If Cursor changes its on-disk format (which it has done historically), this file is the only one that needs to change.
- **No dedicated `cursor-cli.test.js`** — be careful when modifying `server/cursor-cli.js` because the runtime has no test coverage. Read the cursor-cli.js:37-40 comment that documents the one-terminal-complete contract before changing it.

## See also

- `server/modules/providers/README.md` — canonical provider-facet guide.
- `server/modules/websocket/README.md` — message envelope and per-run event log.
- `CLAUDE.md` — top-level project conventions and the CloudCLI runtime model.
- `docs/providers/README.md` — index of provider documentation.
- `docs/providers/opencode.md` — sibling subprocess+JSONL comparison (opencode shells out with `--format json`, cursor with `--output-format stream-json`; different session storage patterns — opencode is a shared DB, cursor is per-session SQLite blob DAG).
- `docs/providers/claude.md` — sibling with the most thorough UI integration documentation. The cursor UI integration section is structured as deltas-vs-claude.
