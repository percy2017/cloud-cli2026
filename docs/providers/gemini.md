# Gemini provider

This document explains how CloudCLI integrates [Google's Gemini CLI][gemini-cli] as one of
its AI coding agents. Gemini sits in the middle of the architectural spectrum: it's the only
**subprocess + stream-json** provider that's reached production maturity in this repo with
a **fully hardcoded model catalog** (no runtime enumeration), and unlike Claude it has **no
interactive permission flow** — the CLI runs in `--yolo` or auto-edit mode by default. That, plus
a dual storage model (modern JSONL transcripts under `~/.gemini/tmp/` **and** a legacy in-memory
session manager), makes Gemini the most operationally distinct provider in the catalog after
Claude and opencode, which is why it deserves its own doc.

For the canonical guide on **adding a new provider** (facet contract, registration, types),
see `server/modules/providers/README.md`. This doc assumes you already know the facet model
and zooms in on how Gemini implements each one.

[gemini-cli]: https://github.com/google-gemini/gemini-cli

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
                 │  → spawnFn['gemini']       │
                 │  → spawnGemini()           │
                 └──────────────┬─────────────┘
                                │
                                ▼
              ┌────────────────────────────────────────┐
              │  spawnGemini                           │
              │  sh -c 'exec "$0" "$@"' <gemini>      │
              │    --prompt <command>                  │
              │    [--resume <cliSessionId>]           │
              │    --skip-trust                        │
              │    --model <model>                     │
              │    --output-format stream-json         │
              │    [--yolo|--approval-mode ...]        │
              └──────────────┬────────────────────────┘
                             │ stdio NDJSON
                             ▼
        ┌────────────────────────────────────────────────┐
        │ GeminiResponseHandler                          │
        │  - buffer newline-split                        │
        │  - inactivity timeout 120 s                    │
        │  - forceFlush on close                         │
        └──────────────┬─────────────────────────────────┘
                       │ parsed events
                       ▼
        ┌────────────────────────────────────────────────┐
        │ GeminiSessionsProvider.normalizeMessage       │
        │  - init  → session_created                     │
        │  - message → stream_delta + stream_end         │
        │  - tool_use / tool_result                     │
        │  - result → stream_end + token_budget status  │
        │  - error → error frame                        │
        └──────────────┬─────────────────────────────────┘
                       │ NormalizedMessage
                       ▼
                ┌────────────────────────────┐
                │  Frontend (React)          │
                │  renders stream in UI      │
                └────────────────────────────┘
```

## Backend layout

Everything that "is" Gemini-from-CloudCLI's-point-of-view lives under
[`server/modules/providers/list/gemini/`][gemini-dir]:

| File | Role |
|---|---|
| `gemini.provider.ts` | Registry entry. 6 standard facets (no extras, like Claude). |
| `gemini-auth.provider.ts` | Auth facet. Detects CLI install, resolves credentials (env → `~/.gemini/.env` → OAuth credentials file → Vertex AI). |
| `gemini-models.provider.ts` | Models facet. Returns a **hardcoded** `GEMINI_FALLBACK_MODELS` catalog — no runtime enumeration. |
| `gemini-mcp.provider.ts` | MCP facet. Reads/writes `~/.gemini/settings.json` (user) and `<project>/.gemini/settings.json` (project). No `local` scope. |
| `gemini-skills.provider.ts` | Skills facet. Scans `~/.gemini/skills/`, `~/.agents/skills/`, `<project>/.gemini/skills/`, `<project>/.agents/skills/`. **No plugin skills** (unlike Claude). |
| `gemini-sessions.provider.ts` | Sessions facet. Reads modern JSONL transcripts under `~/.gemini/tmp/<projectHash>/chats/` and falls back to a legacy JSON reader for older sessions. |
| `gemini-session-synchronizer.provider.ts` | Synchronizer. Recursively scans `~/.gemini/tmp/**/*.jsonl` (chokidar itself lives in `sessions-watcher.service.ts`). |

[gemini-dir]: ../../server/modules/providers/list/gemini/

## Runtime CLI: `server/gemini-cli.js`

This is the subprocess driver the gateway calls. It exports `spawnGemini`,
`abortGeminiSession`, `isGeminiSessionActive`, and `getActiveGeminiSessions`.

### Subprocess args

`spawnGemini` assembles the CLI args in this order:

```
sh -c 'exec "$0" "$@"' <geminiPath> \
  --prompt <command> \
  [--resume <cliSessionId>] \
  --skip-trust \
  [--mcp-config <~/.gemini.json or .gemini/settings.json>] \
  --model <model> \
  --output-format stream-json \
  [--yolo | --approval-mode auto_edit | --approval-mode plan] \
  [--allowed-tools a,b,c] \
  [--debug]
```

Notes:

- `geminiPath = process.env.GEMINI_PATH || 'gemini'`.
- `--skip-trust` is injected unconditionally — the CLI prompts for trust on first run in
  a new directory, which would deadlock the spawn.
- `--mcp-config` is added only when there's an `mcpServers` entry to pass through.
- On Windows, `cross-spawn` is used directly; on Linux/macOS, args are wrapped in
  `sh -c 'exec "$0" "$@"'` to avoid `ENOEXEC` from scripts without a shebang.
- `cwd` is sanitized with `.replace(/[^\x20-\x7E]/g, '').trim()` to avoid command-line
  injection from malicious project paths.

### `--output-format stream-json`

This is the single switch that makes the integration work. It puts the CLI into NDJSON
mode (one JSON object per line on stdout). Without it, the CLI writes pretty terminal
output that the response handler can't parse.

### Communication

Stream **NDJSON over stdio**. The parser lives separately in
`server/modules/gemini-response-handler.js`:

- Buffers stdout, splits on newlines, ignores empty lines.
- Tries `JSON.parse` per line; non-JSON lines are silently dropped.
- Recognized events: `init`, `message`, `tool_use`, `tool_result`, `result`, `error`.
- **Inactivity timeout: 120 s** — rearmed on every stdout chunk. Exceeding it kills the
  subprocess to avoid zombie processes.
- `buildGeminiTokenBudget` converts the last `event.tokens` to a `tokenBudget` payload and
  emits `kind: 'status', text: 'token_budget'`.
- `forceFlush()` parses any leftover buffer when the process closes.

### Mapping to `NormalizedMessage`

`GeminiSessionsProvider.normalizeMessage` (`server/modules/providers/list/gemini/gemini-sessions.provider.ts:247-339`):

| Raw event | `NormalizedMessage.kind` |
|---|---|
| `init` (first valid one) | `session_created` |
| `message` (assistant content) | `stream_delta` + `stream_end` (if not delta-only) |
| `tool_use` | `tool_use` (`toolName=tool_name`, `toolInput=parameters`, `toolId=tool_id`) |
| `tool_result` | `tool_result` (`isError = status === 'error'`) |
| `result` | `stream_end` + optional `status(text=Complete, tokens=stats.total_tokens, canInterrupt=false)` |
| `error` | `error` (`content=raw.error || raw.message || 'Unknown Gemini streaming error'`) |

### Abort

`abortGeminiSession(sessionId)` (`server/gemini-cli.js:589-623`):

1. Looks up the subprocess in the `activeGeminiProcesses` map (also matches by
   `proc.sessionId === sessionId` to handle the rename that happens after `init`).
2. Sets `geminiProc.aborted = true` so the `close` handler doesn't emit a duplicate
   `complete`.
3. Sends `SIGTERM`; if still alive after 2 s, escalates to `SIGKILL`.

### Exit code mapping

`server/gemini-cli.js:20-33`:

- `41` → "Gemini authentication failed" (with auth-status suffix).
- `42` → "Gemini rejected the request input".
- `44` → "Gemini sandbox error".
- `52` → "Gemini configuration error".
- `53` → "Gemini conversation turn limit reached".
- `127` → "Gemini CLI is not installed" (re-checked via `providerAuthService.isProviderInstalled('gemini')`).

Stderr noise `[DEP0040]` and `Loaded cached credentials` is filtered out (`server/gemini-cli.js:462-466`).

## Auth & environment

### Credential resolution order

`gemini-auth.provider.ts#checkCredentials`:

1. `process.env.GEMINI_API_KEY` → `method: 'api_key'`.
2. `GEMINI_API_KEY` from `~/.gemini/.env` (or `~/.env` fallback) → `method: 'api_key'`.
3. If `selectedType === 'vertex-ai'` → require `GOOGLE_API_KEY` or
   `GOOGLE_APPLICATION_CREDENTIALS` or (`GOOGLE_CLOUD_PROJECT[_ID]` + `GOOGLE_CLOUD_LOCATION`).
4. `~/.gemini/oauth_creds.json` — validate `access_token` against
   `https://oauth2.googleapis.com/tokeninfo?access_token=<token>`; refresh via `google_accounts.json` if the access token fails.
5. Specific user-friendly errors per `selectedType`.

### Files & folders read

- **`~/.gemini/.env`** (first) or **`~/.env`** (fallback) — dotenv format, supports
  `export KEY=value`, quoted values, and inline comments.
- **`~/.gemini/settings.json`** → `security.auth.selectedType` (one of `'oauth-personal'`,
  `'gemini-api-key'`, `'vertex-ai'`, `'compute-default-credentials'`, `'gateway'`,
  `'cloud-shell'`).
- **`~/.gemini/oauth_creds.json`** → tokens + email.
- **`~/.gemini/google_accounts.json`** → offline email fallback.

### Env vars

- `GEMINI_API_KEY` — primary API key env var (also read from `.env` files).
- `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_PROJECT_ID`,
  `GOOGLE_CLOUD_LOCATION`, `GOOGLE_APPLICATION_CREDENTIALS` — Vertex AI.
- `GEMINI_CLI_HOME` — overrides `~/.gemini/` for auth, watcher, and session synchronizer
  paths (so a single user can run isolated Gemini setups, useful in tests).
- `GEMINI_PATH` — overrides the path to the Gemini binary.

### Login flow in the UI

`ProviderLoginModal` (`src/components/provider-auth/view/ProviderLoginModal.tsx:90-141`)
takes a **dedicated branch** for Gemini (no `StandaloneShell`):

1. Show numbered instructions:
   - "Get your API key" with a link to Google AI Studio.
   - Run `gemini config set api_key YOUR_KEY` to apply it.
2. "Done" button closes the modal.

Other providers (`claude`, `codex`, `cursor`, `opencode`) get the embedded-terminal flow;
Gemini is the only one that needs this manual-instruction flow.

The status endpoint is `/api/providers/gemini/auth/status` (in
`PROVIDER_AUTH_STATUS_ENDPOINTS.gemini`).

## Models

### Hardcoded catalog

`gemini-models.provider.ts` returns a `GEMINI_FALLBACK_MODELS` constant with six entries:

- `gemini-3-flash-preview`
- `gemini-3.1-flash-lite-preview`
- `gemini-2.5-flash`
- `gemini-2.5-flash-lite`
- `gemma-4-31b-it`
- `gemma-4-26b-a4b-it`

Default = `gemini-3-flash-preview`.

Note the `gemma-*` entries: these are Google's open model checkpoints that the Gemini CLI
can execute, included in the catalog alongside the proprietary Gemini checkpoints.

### No caching

Gemini is in `UNCACHED_PROVIDERS = new Set<LLMProvider>(['claude', 'gemini'])`
(`server/modules/providers/services/provider-models.service.ts:20`). The catalog is
**always re-queried** instead of being persisted to disk. (Claude and Gemini both have this
behavior; the others cache.)

### Frontend fallback divergence

The frontend's `useChatProviderState.ts:16` falls back to `'gemini-3.1-pro-preview'` —
which is **not** in the backend catalog. If the live `/api/providers/gemini/models`
response is unavailable, the UI shows a model the backend doesn't know. This is a known
divergence (see Quirks).

## MCP

`gemini-mcp.provider.ts` extends the shared `McpProvider` base.

### Scopes & transports

- **User scope:** `~/.gemini/settings.json` → `mcpServers`.
- **Project scope:** `<workspacePath>/.gemini/settings.json` → `mcpServers`.
- **No `local` scope** (Claude has three scopes; Gemini has two).
- Transports: `['stdio', 'http', 'sse']` (one of two providers supporting `sse`).

### Frontend constants (`src/components/mcp/constants.ts`)

- `MCP_SUPPORTED_SCOPES.gemini = ['user', 'project']`
- `MCP_SUPPORTED_TRANSPORTS.gemini = ['stdio', 'http', 'sse']`
- `MCP_PROVIDER_BUTTON_CLASSES.gemini = 'bg-primary text-primary-foreground hover:bg-primary/90'`
- `MCP_SUPPORTS_WORKING_DIRECTORY.gemini = true` (shares this capability with codex)

## Skills

`gemini-skills.provider.ts` extends `SkillsProvider`. **No plugin skills** (unlike Claude) —
Gemini has no equivalent of `enabledPlugins`.

### Skill sources

| Scope | `rootDir` | `commandPrefix` |
|---|---|---|
| user | `~/.gemini/skills/` | `/` |
| user | `~/.agents/skills/` | `/` |
| project | `<workspace>/.gemini/skills/` | `/` |
| project | `<workspace>/.agents/skills/` | `/` |

The two `.agents/skills/` paths are shared with Cursor (which has the same dual layout) —
keep the discovery in sync if you edit one provider's `getSkillSources`.

### Frontend (`src/components/skills/view/ProviderSkills.tsx:63-71`)

- `gemini: 'Gemini'`
- `gemini: '~/.gemini/skills/<skill-name>/SKILL.md'`

## Sessions and sessionSynchronizer

### Storage

`GeminiSessionSynchronizer` scans `~/.gemini/tmp/**/*.jsonl`. Each session lives at:

```
~/.gemini/tmp/<projectHash>/chats/<sessionId>.jsonl
```

The watcher itself (chokidar with `{ interval: 6000, usePolling: true, depth: 6 }`) lives in
`server/modules/providers/services/sessions-watcher.service.ts:34-37` over
`path.join(os.homedir(), '.gemini', 'tmp')`. Gemini's type filter is `.json|.jsonl`
(uniquely broad — other providers only see `.jsonl`).

### Reading history

`GeminiSessionsProvider#getGeminiCliSessionMessages` decides between two readers based on
`jsonl_path`:

- `.jsonl` → `getGeminiJsonlSessionMessages` (stream-readline, one event per line).
- `.json` (legacy) → `getGeminiLegacySessionMessages` (full-file JSON parse).

The JSONL parser maps each line into:

```
{ type, id, timestamp, role, content, thoughts,
  tokens, tool_name, parameters, tool_id, output, status }
```

- `$set:{ … }` metadata lines are dropped.
- `extractGeminiTextContent` flattens `text:` parts of an array content.
- `extractGeminiThoughts` joins `subject: description` pairs.
- `tool_use` / `tool_result` map to `toolName`/`toolInput`/`toolCallId`/`output`/`isError`.
- `tokenUsage` is taken from the **last** assistant row that has `tokens`.

`fetchHistory` builds the `NormalizedMessage[]`, then does a second pass to backlink each
`tool_use` with its matching `tool_result` (matched by `toolId`), populating
`msg.toolResult = { content, isError }`.

### Differentiator: dual storage model

- **Modern:** JSONL transcripts under `~/.gemini/tmp/<projectHash>/chats/` (what the
  synchronizer reads).
- **Legacy:** in-memory `sessionManager` reading from `~/.gemini/sessions/*.json` for older
  sessions.

`server/index.js:135-144`'s `resolveProviderSessionId` for Gemini is the only one that
falls through to `sessionManager.getSession(sessionId).cliSessionId`, while everything
else queries the DB. This dual storage is the source of subtle edge cases (see Quirks).

## Registry and types

Gemini is the fourth member of `LLMProvider` in both:

- [`server/shared/types.ts:68`][shared-types] — `export type LLMProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';`
- [`src/types/app.ts:1`][app-types] — the same union mirrored for the frontend.

Registry entry in [`server/modules/providers/provider.registry.ts:14`][registry]:

```ts
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  gemini: new GeminiProvider(),   // ← this one
  opencode: new OpenCodeProvider(),
};
```

### Capabilities

`server/modules/providers/services/provider-capabilities.service.ts:60-68`:

```ts
gemini: {
  provider: 'gemini',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  defaultPermissionMode: 'default',
  supportsImages: false,
  supportsAbort: true,
  supportsPermissionRequests: false,
  supportsTokenUsage: true,
},
```

Note that `supportsImages: false` despite the runtime supporting image uploads through
`<cwd>/.tmp/images/...` (see Quirks).

No provider-specific fields exist on `NormalizedMessage` for Gemini (unlike Claude's
`isLocalCommand`, `requestId`, etc.).

[registry]: ../../server/modules/providers/provider.registry.ts
[shared-types]: ../../server/shared/types.ts
[app-types]: ../../src/types/app.ts

## UI integration

> **The UI surface shared by all 5 providers is documented in detail under
> `docs/providers/claude.md` → "UI integration"** (Header tabs / Chat tab / Shell CLI tab
> / Sidebar / Auth-status / Skills panel / MCP panel / Permissions). This section zooms
> in on the **gemini-specific deltas**, not on the parts that are common across
> providers. Read the Claude doc first for the shared mechanics; drop into this one
> when gemini behaves differently.

### Gemini at a glance

| Aspect | Gemini value | Source |
|---|---|---|
| Icon | `GeminiLogo.tsx` — the only **multicolor** SVG (yellow `#FFE432`, red `#FC413D`, green `#00B95C`, blue `#3186FF` with gradients and filters) | `src/components/llm-logo-provider/GeminiLogo.tsx`; `SessionProviderLogo.tsx:25-27` |
| Provider list position | 4th in `AGENT_PROVIDERS` / `CLI_PROVIDERS` / `provider.registry.ts`; 4th in `src/types/app.ts` and `server/shared/types.ts` | `constants.ts:42`; `provider-auth/types.ts:13`; `provider.registry.ts:14` |
| Sidebar dot color | `bg-indigo-500` (the icon carries the brand multicolor; the dot stays neutral accent) | `AgentSelectorSection.tsx:26-28` |
| `PROVIDER_META` vendor label | `name: 'Google'` (the only provider whose picker label is the vendor rather than the product) | `ProviderSelectionEmptyState.tsx:26-32` |
| Permission modes (UI) | `['default', 'acceptEdits', 'bypassPermissions', 'plan']` — all 4 modes | `useChatProviderState.ts:26-32` |
| Backend hardcoded catalog | 6 entries (`gemini-3-flash-preview` default, gemini-3.1-flash-lite-preview, gemini-2.5-flash, gemini-2.5-flash-lite, gemma-4-31b-it, gemma-4-26b-a4b-it) | `gemini-models.provider.ts` (see Models section) |
| Frontend fallback | `'gemini-3.1-pro-preview'` (does **not** match backend default — known UI/backend divergence) | `useChatProviderState.ts:12-18` |
| **Cache** | **Always re-queried** at runtime (no on-disk cache) — one of only 2 providers in `UNCACHED_PROVIDERS = ['claude', 'gemini']` | `provider-models.service.ts:20` |
| Login UI | **NOT terminal-based** — dedicated `ProviderLoginModal` panel with Google AI Studio link + `gemini config set api_key YOUR_KEY` instruction | `ProviderLoginModal.tsx:91-141` |
| Auth endpoint | `/api/providers/gemini/auth/status` | `src/components/provider-auth/types.ts:16` |
| Skill path display | `~/.gemini/skills/<skill-name>/SKILL.md` (also tracks `~/.agents/skills/`, shared with Codex) | `ProviderSkills.tsx:66` |
| MCP scopes | `['user', 'project']` (no `local`) | `src/components/mcp/constants.ts:11-25` |
| MCP transports | `['stdio', 'http', 'sse']` (the second provider supporting `sse`, alongside Claude) | same |
| MCP button | `bg-primary text-primary-foreground hover:bg-primary/90` | `MCP_PROVIDER_BUTTON_CLASSES.gemini` |
| `supportsWorkingDirectory` | true (shared with codex) | same |
| Capabilities | `permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan']`, `defaultPermissionMode: 'default'`, `supportsImages: false`, `supportsAbort: true`, `supportsPermissionRequests: false`, `supportsTokenUsage: true` | `provider-capabilities.service.ts:60-68` |
| Image UI | **gap**: `supportsImages: false` despite runtime supporting `<cwd>/.tmp/images/...` injection | `provider-capabilities.service.ts`; `gemini-cli.js:165-209` |
| Locales | `en`, `es`, `fr` (+ all 12 base locales); `onboarding.agents.providerTitles.gemini` missing in non-`en`/`es` locales | `chat.json`, `settings.json`, `sidebar.json` |

### Header tabs (gemini perspective)

The header tab switcher (`MainContentTabSwitcher.tsx:34-53`) is **provider-agnostic** —
no gemini-specific tab exists. The shell tab starts an `xterm.js` session and forwards
`provider: 'gemini'` to `buildShellCommand` on the server:

```ts
// server/modules/websocket/services/shell-websocket.service.ts:151-156
if (provider === 'gemini') {
  const command = initialCommand || 'gemini';
  if (resumeSessionId) return `${command} --resume "${resumeSessionId}"`;
  return command;
}
```

The first-time gemini shell session runs the bare `gemini` binary; resuming passes
`--resume "<id>"`. There is no `|| gemini` fallback (cursor's pattern) and no
`--trust` retry (cursor's pattern) — the gemini CLI handles both internally.

### Chat tab — gemini-specific bits

The chat panel is shared across all 5 providers (`ChatInterface.tsx`). Gemini branches:

- **`useChatProviderState.ts:81-83`** manages `geminiModel` / `setGeminiModel` separately, persisted under `localStorage['gemini-model']`.
- **`useChatProviderState.ts:304-316`** reconciles the model catalog effect for gemini (no special-casing).
- **`ProviderSelectionEmptyState.tsx:160-162`** writes `localStorage['gemini-model']` when the user picks a model in the picker.
- **`UNCACHED_PROVIDERS = ['claude', 'gemini']`** in `provider-models.service.ts:20` means **gemini's catalog is always re-queried** — no disk cache. Other providers cache.

- **`useChatComposerState.ts`** has **no** gemini-specific downgrade clause. The only provider-specific downgrade is codex's `plan → default` at line 744. Gemini's `permissionMode === 'plan'` is sent to the runtime unchanged.

- **`--skip-trust` injection** at the runtime layer (`gemini-cli.js`) is unconditional — but this is a backend-level concern, not a UI one.

- **`gemini --yolo` vs `--approval-mode auto_edit` vs `--approval-mode plan`** — gemini's runtime supports all three. The UI's `provider-capabilities.service.ts:60-68` exposes `permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan']`. Gemini's UI strings document the gemini mode names (default/autoEdit/yolo/plan); the runtime maps them to `--yolo`, `--approval-mode auto_edit`, `--approval-mode plan`, and the default bash-trust prompt.

### Shell / CLI tab — gemini spawn command

For interactive shells (the Shell tab), Gemini spawns `gemini` via the
`/shell` WebSocket transport (PTY mode). For non-interactive chat, the gateway uses
`spawnGemini` (the `--output-format stream-json` path) instead — see
[Runtime CLI](#runtime-cli-servergemini-clijs).

The two paths share the same `cwd` and the same `--model` flag; they differ in
**whether the NDJSON parser is on**. The shell path gives the user gemini's native
TUI. The chat path streams NDJSON frames into `NormalizedMessage`.

### Sidebar left sessions list

Standard provider-agnostic sidebar (see `claude.md → Sidebar left sessions list` for the
data flow). Gemini deltas:

- **Provider label** — `SidebarSessionItem.tsx` renders `<SessionProviderLogo provider="gemini" />`, which dispatches to `<GeminiLogo>` (the multicolor star SVG).
- **No provider filter** — `getAllSessions` returns every session under the project regardless of provider.
- **`useProjectsState.handleSidebarRefresh` (`:841-887`)** preserves `__provider: 'gemini'` across refreshes.
- **Sidebar drives active provider** — selecting a gemini session sets `localStorage['selected-provider'] = 'gemini'` via `useChatProviderState.ts:337-344`.

### Auth-status surface

`useProviderAuthStatus` (`src/components/provider-auth/hooks/useProviderAuthStatus.ts`).
For gemini the endpoint is `/api/providers/gemini/auth/status`
(`provider-auth/types.ts:16`).

Server-side `gemini-auth.provider.ts#checkCredentials` resolves credentials from:

1. `process.env.GEMINI_API_KEY` → `method: 'api_key'`.
2. `~/.gemini/.env` or `~/.env` (whichever exists; dotenv format with `export KEY=value` + quoted values + inline comments supported).
3. If `selectedType === 'vertex-ai'` → require `GOOGLE_API_KEY` or `GOOGLE_APPLICATION_CREDENTIALS` or `GOOGLE_CLOUD_PROJECT[_ID]` + `GOOGLE_CLOUD_LOCATION`.
4. `~/.gemini/oauth_creds.json` — validate `access_token` against `https://oauth2.googleapis.com/tokeninfo?access_token=...`; refresh via `google_accounts.json` if the access token fails.
5. Specific user-friendly errors per `selectedType`.

**Login redirect.** `AgentsSettingsTab.tsx:50-52` renders the gemini row:

```ts
gemini: {
  authStatus: providerAuthStatus.gemini,
  onLogin: () => onProviderLogin('gemini'),
},
```

**Crucially**, gemini's `ProviderLoginModal` branch does **not** launch an embedded
terminal. Instead it shows a two-step instruction panel (`ProviderLoginModal.tsx:91-141`):

```tsx
{provider === 'gemini' ? (
  <div className="flex h-full flex-col items-center justify-center bg-gray-50 p-8 text-center dark:bg-gray-900/50">
    <div className="mb-6 ...">
      <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
    </div>
    <h4>Setup Gemini API Access</h4>
    <p>The Gemini CLI requires an API key to function. Configure it in your terminal first.</p>
    <ol>
      <li>
        <p>Get your API key</p>
        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer">
          Google AI Studio <ExternalLink className="h-3 w-3" />
        </a>
      </li>
      <li>
        <p>Run configuration</p>
        <code>gemini config set api_key YOUR_KEY</code>
      </li>
    </ol>
    <button onClick={onClose}>Done</button>
  </div>
) : (
  <StandaloneShell project={...} command={command} onComplete={...} minimal={true} />
)}
```

A "Done" button closes the modal. There's no `process.env.GEMINI_API_KEY` mirror or
OAuth dance — the user pastes the key into their local config manually via
`gemini config set api_key YOUR_KEY`. **This is the only provider with a non-terminal
login UI.**

### Skills panel

`ProviderSkills.tsx` for gemini:

```ts
gemini: 'gemini'                              // card style
gemini: 'Gemini'
gemini: '~/.gemini/skills/<skill-name>/SKILL.md'    // line 66, PROVIDER_SKILL_PATHS
```

**Four skill roots** (`gemini-skills.provider.ts:16-58`):

| Scope | `rootDir` | Source line |
|---|---|---|
| `user` | `~/.gemini/skills/` | (gemini-skills.provider.ts; prefix `/`) |
| `user` | `~/.agents/skills/` | (shared with Codex) |
| `project` | `<workspace>/.gemini/skills/` | |
| `project` | `<workspace>/.agents/skills/` | (shared with Codex) |

**No plugin skills** (unlike Claude). Gemini has no equivalent of `enabledPlugins`.

Standard 5-minute TTL cache (`useProviderSkills.ts:25`).

The two `.agents/skills/` paths are also tracked by Codex — keep the discovery in
sync if you edit either provider's `getSkillSources`.

### MCP panel

Gemini is **one of two providers supporting `sse` transport** (the other is Claude).
The matrix in `src/components/mcp/constants.ts:11-25`:

```ts
MCP_SUPPORTED_SCOPES.gemini     = ['user', 'project']
MCP_SUPPORTED_TRANSPORTS.gemini = ['stdio', 'http', 'sse']
MCP_PROVIDER_BUTTON_CLASSES.gemini = 'bg-primary text-primary-foreground hover:bg-primary/90'
MCP_SUPPORTS_WORKING_DIRECTORY.gemini = true   // shared with codex
```

Storage (`gemini-mcp.provider.ts`):

- User scope: `~/.gemini/settings.json`
- Project scope: `<workspace>/.gemini/settings.json`
- **No `local` scope** (matches codex/opencode/cursor restrictions).

Standard 30-second TTL cache (`useMcpServers.ts:52-53`).

### Permissions

`GeminiPermissions` (`PermissionsContent.tsx:582`, type at `:582-586`) is the
**dedicated gemini React component**:

```ts
type GeminiPermissionsProps = {
  agent: 'gemini';
  permissionMode: GeminiPermissionMode;
  onPermissionModeChange: (value: GeminiPermissionMode) => void;
};

function GeminiPermissions({ permissionMode, onPermissionModeChange }: Omit<GeminiPermissionsProps, 'agent'>) {
  // ...t('gemini.permissionMode'), t('gemini.description'), t('gemini.modes.{default,autoEdit,yolo}')
}
```

(Compare to `CodexPermissions`, which takes 3 modes; gemini takes 4 — `plan` is
included.) Dispatcher (`PermissionsContent.tsx:701`):

```ts
if (props.agent === 'gemini') {
  return <GeminiPermissions {...props} />;
}
```

The capability row (`provider-capabilities.service.ts:60-68`):

```ts
gemini: {
  provider: 'gemini',
  permissionModes: ['default', 'acceptEdits', 'bypassPermissions', 'plan'],
  defaultPermissionMode: 'default',
  supportsImages: false,                  // ← known UI gap (see below)
  supportsAbort: true,
  supportsPermissionRequests: false,      // ← no canUseTool flow
  supportsTokenUsage: true,
},
```

**Two noteworthy consequences:**

1. **`supportsImages: false`** despite the runtime supporting images via `<cwd>/.tmp/images/...` injection (`gemini-cli.js:165-209`). The UI's `useChatProviderState` doesn't expose an image selector for gemini. Image uploads will succeed server-side but the UI may not let you trigger them — see [Known quirks](#known-quirks).
2. **`supportsPermissionRequests: false`** — Gemini's CLI doesn't surface interactive prompts to CloudCLI's `permission_request` flow. The CLI runs under `--yolo` / `--approval-mode auto_edit` / `--approval-mode plan` and the user opts into the approval mode in the UI.

The chat composer sends `permissionMode` to the runtime unchanged (no downgrade clause in `useChatComposerState.ts` for gemini).

### Icon + provider identity

- **Icon** — `src/components/llm-logo-provider/GeminiLogo.tsx`. The **only multicolor
  provider logo** in the catalog — SVG of the Gemini star using the official palette
  (`#FFE432` yellow, `#FC413D` red, `#00B95C` green, `#3186FF` blue, etc.) with SVG
  gradients and filters. Wired at `SessionProviderLogo.tsx:25-27`.
- **Color** — accent `bg-indigo-500` in `AgentSelectorSection.tsx:26-28`. The icon carries
  the brand colors; the UI badge stays neutral.
- **Provider lists** — `AGENT_PROVIDERS` and `CLI_PROVIDERS` order `[claude, cursor,
  codex, gemini, opencode]` (`constants.ts:42`).
- **`PROVIDER_META`** in `ProviderSelectionEmptyState.tsx:26-32` — `{ id: 'gemini', name:
  'Google' }`.
- **Sidebar / ChatInterface** — pass `geminiModel` and `setGeminiModel` props down.
- **Localstorage keys** — `'gemini-model'`, `'gemini-settings'`.
- **AccountContent** — `{ name: 'Gemini', description: 'Google Gemini AI assistant' }`.

### Login flow

Different from every other provider — Gemini's `ProviderLoginModal` branch does **not**
launch an embedded terminal. Instead it shows a two-step instruction panel:

1. "Get your API key" (link to Google AI Studio).
2. Run `gemini config set api_key YOUR_KEY`.

A "Done" button closes the modal. The reasoning: there's no interactive login flow to
forward through an embedded terminal; the user must paste the key into their local
config manually.

### i18n

Locales covered: `en`, `es`, `fr`, plus all 12 base locales (`de`, `en`, `es`, `fr`, `it`,
`ja`, `ko`, `ru`, `tr`, `zh-CN`, `zh-TW`). Notable keys:

- `chat.providerNames.gemini: "Gemini"`
- `chat.gemini.permissionMode`, `chat.gemini.description`,
  `chat.gemini.modes.{default,autoEdit,yolo}` — **these mode names differ from Claude's**
  (`default / autoEdit / yolo` vs `default / acceptEdits / bypassPermissions`).
- `chat.providerSelection.readyPrompt.gemini: "Ready to use Gemini with {{model}}…"`
- `settings.agents.account.gemini.description: "Google Gemini AI assistant"`
- `settings.agents.providers.gemini`
- `sidebar.codexSession` is **not** present (only the other 4 providers have sidebar
  session labels); gemini gets the implicit session label from i18n fallthrough.

Note: keep `en`, `es`, **and** `fr` in sync for any new key. Spanish is the default
language; the fallback chain trips to English only when a key is missing in all three.

## End-to-end message flow

1. User types in the chat panel; provider = `gemini`; model picked from
   `providerModelCatalog.gemini` (or the local fallback).
2. Frontend sends `chat.send { sessionId, content, options: { cwd, model, permissionMode, allowedTools } }` over WebSocket.
3. `handleChatSend` resolves the session via `sessionsDb.getSessionById` and builds
   `runtimeOptions` with `sessionId: session.provider_session_id ?? undefined` and `cwd`.
4. `spawnFns.gemini = spawnGemini` invokes `providerModelsService.resolveResumeModel('gemini', sessionId, options.model)`.
5. Subprocess starts: `sh -c 'exec "$0" "$@"' <gemini> --prompt <command> [--resume ...] --skip-trust --model <model> --output-format stream-json [...]`.
6. CLI emits `init` with canonical `session_id`. The handler calls `ws.setSessionId(...)`, registers the session in `sessionManager`, and emits `session_created` over WS.
7. Stream begins. Each chunk enters `GeminiResponseHandler.processData` →
   `sessionsService.normalizeMessage('gemini', event, sid)` → emitted as
   `stream_delta` / `tool_use` / `tool_result` / `stream_end` / `status(token_budget)`.
8. On terminal `result` or process close:
   - Save final assistant message to `sessionManager`.
   - Emit `complete` (unless aborted).
   - Clean `<cwd>/.tmp/images/...`.
   - Call `notifyTerminalState` → `notifyRunStopped` (success) or `notifyRunFailed` (error).
9. Abort: frontend sends `chat.abort` → `abortFns.gemini = abortGeminiSession` →
   `SIGTERM` + `SIGKILL` after 2 s. The `aborted` flag prevents the `close` handler from
   emitting a duplicate `complete`; the chat-run-registry issues one with `aborted:true`.

## Debugging & verification

Existing tests touching Gemini:

| Test | Coverage |
|---|---|
| `server/modules/providers/tests/mcp.test.ts:262-355` | stdio + http for gemini; `~/.gemini/settings.json` (user) + `<ws>/.gemini/settings.json` (project); read/write flows. |
| `server/modules/providers/tests/skills.test.ts:450+` | 4 skill roots (`~/.gemini/skills`, `~/.agents/skills`, `<ws>/.gemini/skills`, `<ws>/.agents/skills`). |
| `server/modules/providers/tests/provider-models.service.test.ts:173-194` | mock provider with id `gemini-*`; verifies `UNCACHED_PROVIDERS` behavior. |
| `server/modules/database/tests/sessions-provider-mapping.test.ts:103` | legacy session with `provider='gemini'`. |
| `server/modules/websocket/tests/chat-run-registry.test.ts:189-204` | app session creation + event emission for `provider='gemini'`. |

**No `gemini-cli.test.js` or `gemini-sessions.test.ts`** exists — the runtime `gemini-cli.js`
lacks a dedicated test (contrast `opencode-cli.test.js` which does exist).

Logs worth grepping:

- `Gemini authentication failed` — exit code 41.
- `Gemini rejected the request input` — 42.
- `Gemini sandbox error` — 44.
- `Gemini configuration error` — 52.
- `Gemini conversation turn limit reached` — 53.
- `Gemini CLI is not installed` — 127.

## Known quirks

- **No interactive permissions.** `supportsPermissionRequests: false`. Unlike Claude there's no
  `canUseTool` / `permission_request` flow — the CLI runs under `--yolo` or `--approval-mode
  auto_edit` and the user opts into approval mode in the UI.
- **Image support gap.** `gemini-cli.js` handles images via `<cwd>/.tmp/images/...` and
  injects paths into the prompt (lines 165-209), but the capability table reports
  `supportsImages: false` and the UI's `useChatProviderState` doesn't expose an image selector
  for gemini. Image uploads will succeed server-side but the UI may not let you trigger them.
- **Model catalog divergence.** Backend default is `gemini-3-flash-preview`; frontend
  fallback is `gemini-3.1-pro-preview` (which isn't even in the backend catalog). Don't rely on
  the frontend fallback; always use the live `/api/providers/gemini/models` response.
- **Dual session storage.** Modern JSONL transcripts under `~/.gemini/tmp/...` are the
  source of truth for new sessions. Older sessions still live in legacy
  `~/.gemini/sessions/*.json` and are read by `getGeminiLegacySessionMessages`. The synchronizer
  deliberately skips the legacy path to avoid duplicating sessions.
- **`UNCACHED_PROVIDERS` includes gemini.** The catalog is always re-queried on demand; no
  disk cache for `useChatProviderState` either.
- **No plugin skills.** Gemini doesn't have `enabledPlugins`; if a user wants Claude's
  plugin commands in their Gemini session, they're out of luck.
- **Stringly-typed `provider === 'gemini'` checks** scattered across `server/index.js:138`,
  `server/index.js:1315`, `shell-websocket.service.ts:149,480`, etc. Renaming the provider is
  a multi-file find-and-replace.
- **`GEMINI_PATH` misconfiguration** is not always caught early; if `cross-spawn` fails
  silently the runtime falls back to error messaging via exit code 127 at first spawn attempt.
- **`--skip-trust` is unconditional.** Removing this would cause the CLI to block on
  workspace trust prompts in fresh directories.
- **No `cloudcli gemini …` sub-command.** The only public entry point is the chat panel's
  WebSocket.

## See also

- `server/modules/providers/README.md` — canonical provider-facet guide.
- `server/modules/websocket/README.md` — message envelope and per-run event log.
- `CLAUDE.md` — top-level project conventions and the CloudCLI runtime model.
- `docs/providers/README.md` — index of provider documentation.
- `docs/providers/opencode.md` — sibling subprocess+stdIO comparison (different CLI, similar shape).
- `docs/providers/claude.md` — sibling in-process-vs-subprocess comparison.
