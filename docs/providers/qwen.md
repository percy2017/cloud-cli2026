# Qwen Code provider

> **Status: IMPLEMENTED.** Qwen Code (`@qwen-code/qwen-code`) is the 6th
> production provider of CloudCLI, wired in across the type unions, provider
> registry, capability matrix, spawner, sessions synchronizer, and the full UI
> surface (sidebar, chat composer, MCP, Skills, Settings → Agents, Settings →
> Permissions). See [section 2](#2-status) for what shipped and which follow-ups
> remain.

This document explains how CloudCLI integrates [Qwen Code][qwen-code] as one of
its AI coding agents. Qwen Code is an open-source CLI by Alibaba (Apache-2.0),
based on Gemini CLI v0.8.2, with explicit feature parity to Claude Code plus
multi-protocol model support (OpenAI, Anthropic, Gemini, Qwen, Ollama/vLLM
via OpenAI-compatible endpoints).

For the canonical guide on **adding a new provider** (facet contract,
registration, types), see [`server/modules/providers/README.md`](../../server/modules/providers/README.md).
This doc assumes you already know the facet model and zooms in on how **qwen**
implements each one.

For the **shared UI surface** (Header tabs, Sidebar, Settings → Agents shared
chrome) that's identical across all six production providers, see
[`docs/providers/claude.md` → "UI integration"](./claude.md#ui-integration).
This doc zooms in on the qwen-specific **deltas** from that baseline.

[qwen-code]: https://github.com/QwenLM/qwen-code

## 1. Quick reference

| Concern | Value |
|---|---|
| Provider id | `'qwen'` |
| Binary | `qwen` (npm `@qwen-code/qwen-code`) |
| Engines | `node >=22.0.0` (CloudCLI pins `>=22 <23` — ✓) |
| Verified CLI version | `0.19.8` |
| Default model | from `~/.qwen/settings.json#model.name` (falls back to `qwen3-coder-plus`) |
| Auth command | **None** (`qwen auth (removed)` in 0.19.7/8) — auth via env vars or direct edit of `~/.qwen/settings.json` (see § 5) |
| Permission modes (UI) | `['default', 'plan', 'auto-edit', 'bypassPermissions']` — mapped to Qwen's `--approval-mode` flag |
| Permission modes (CLI) | `plan`, `default`, `auto-edit`, `yolo` (verified against `qwen --approval-mode=plan` runtime behavior) |
| MCP scopes | `user`, `project` (no `local`) |
| MCP transports | `stdio`, `http`, `sse` |
| Skill roots | `~/.qwen/skills/`, `<git-root>/.qwen/skills/` |
| Skill command prefix | `/` |
| Skill file format | `SKILL.md` with YAML frontmatter (`name`, `description`, optional `priority`) |
| Session storage | JSONL at `~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl` |
| Resume (per-id) | `qwen --resume <id>` |
| Resume (last) | `qwen --continue` (analogous to `claude -c`) |
| Sidebar dot color | `bg-red-500` (Aliyun/Qwen brand) |
| Brand color (Tailwind) | `red` |
| Capability subagent | ✓ |
| Capability images | ✓ (Qwen VL models + Computer Use) |
| Capability computer-use | ✓ (flags exist) |
| Capability sandbox | ✓ (`--sandbox`) |
| Capability rawReasoning | ✓ (inline `parts[]` with `thought: true` flag) |
| Capability sessionContinuable | ✓ (`--continue`) |
| `supportsPermissionRequests` | `false` (real interactive prompts deferred — `qwen serve --http-bridge` is Stage 1 experimental; see § 14) |

## 2. Status

**IMPLEMENTED — all 12 phases shipped.** Verified live in `/opt/cloud-cli2026`
with `MiniMax-M3` as the configured model and a MiniMax token-plan subscription.

What shipped (verified in tree):

- Type unions updated (`server/shared/types.ts:68`, `src/types/app.ts`).
- Provider registry row (6th provider, all 6 capability facets).
- Module: `server/modules/providers/list/qwen/{qwen,qwen-auth,qwen-mcp,qwen-models,qwen-skills,qwen-sessions,qwen-session-synchronizer}.provider.ts`.
- Spawner: `server/qwen-cli.js` (NDJSON line buffer, abort handler, stderr filter, exit-code-≠-0 success tolerance).
- Watcher: `PROVIDER_WATCH_PATHS.qwen = { rootPath: '~/.qwen/projects' }` in
  `server/modules/providers/services/sessions-watcher.service.ts`.
- Frontend: full UI integration across `MessageComponent`, `ProviderSelectionEmptyState`,
  `ChatInterface`, `useChatProviderState`, `useChatComposerState`, `SessionProviderLogo`,
  `mcp/constants.ts`, `skills/view/ProviderSkills.tsx`, `AgentListItem`,
  `AgentConnectionsStep`, `useSettingsController`.
- i18n: all 11 locales updated (`en` + `es` natively; 9 fallback locales verbatim
  English per project convention).

What's deferred (follow-up, not blocking):

- `qwen serve --http-bridge` for real interactive prompts (`ask_user_question`,
  `exit_plan_mode`) — Stage 1 experimental in upstream Qwen. See § 14.
- `qwen channels` (Telegram/Discord/WeChat) integration — out of scope.
- `qwen extensions` / `--install-extension` plugin ecosystem — out of scope.
- Computer Use UI panel — capability flag exists, no panel yet.

## 3. Architecture at a glance

```
                 ┌────────────────────────────┐
                 │  User clicks "Send" in UI  │
                 └──────────────┬─────────────┘
                                │ chat.send (WebSocket)
                                ▼
                 ┌────────────────────────────┐
                 │  Gateway:                  │
                 │  handleChatSend()          │
                 │  → spawnFn['qwen']         │
                 │  → spawnQwen()             │
                 └──────────────┬─────────────┘
                                │
                                ▼
                 ┌────────────────────────────┐
                 │  server/qwen-cli.js        │
                 │  spawn 'qwen' subprocess   │
                 │  -p "<prompt>"             │
                 │  -m <resolvedModel>        │
                 │  --approval-mode <mode>    │
                 │  --output-format stream-   │
                 │  json                      │
                 │  NDJSON line buffer        │
                 └──────────────┬─────────────┘
                                │ session_created
                                │ text / thinking
                                │ tool_use / tool_result
                                │ stream_end
                                ▼
                 ┌────────────────────────────┐
                 │  QwenSessionsProvider      │
                 │  .normalizeMessage()       │
                 │  → NormalizedMessage[]     │
                 └──────────────┬─────────────┘
                                │ gws.send
                                ▼
                 ┌────────────────────────────┐
                 │  Frontend render           │
                 │  useChatProviderState      │
                 │  ChatInterface             │
                 │  MessageComponent          │
                 └────────────────────────────┘
```

**Transport note:** unlike Claude (in-process `@anthropic-ai/claude-agent-sdk`),
qwen is a **subprocess** model — exactly like opencode, gemini, cursor, codex.
The npm package `@qwen-code/qwen-code@0.19.8` is the CLI binary, **not** a
TypeScript API (verified by `npm pack` — `package.json#main` = `cli.js`, no
`types`, no `dist/index.js`).

## 4. Runtime CLI: `server/qwen-cli.js`

Mirror of `server/opencode-cli.js`, with three Qwen-specific behaviors
documented in this section.

### 4.1 Spawn flags (verified for qwen 0.19.8)

The Qwen CLI does **NOT** expose `--include-partial-messages` (the original
draft of this doc assumed it did — that was Claude's flag, not Qwen's).
Qwen emits one NDJSON line per `assistant` turn with the complete `content[]`
of that turn. Streaming UX = `stream_delta` per `assistant` frame, not per
token. This is a Qwen limitation noted in the comparative matrix.

Args assembled before spawn (current state of `qwen-cli.js`):

```js
if (sessionId) {
  // -r, --resume <string> — resume a specific session by id
  args.push('-r', sessionId);
} else {
  // -p, --prompt <string> — non-interactive single prompt.
  // We do NOT use -i (--prompt-interactive) because qwen CLI rejects it
  // when stdin is a pipe that has been closed (`stdin.end()`). Verified:
  // passing -i + a closed pipe yields "Error: The --prompt-interactive flag
  // cannot be used when input is piped from stdin." in qwen 0.19.8.
  args.push('-p', command?.trim() || '');
}
if (resolvedModel) args.push('-m', resolvedModel);
if (permissionMode && permissionMode !== 'default') {
  const qwenApprovalMode =
    permissionMode === 'plan' ? 'plan'
    : permissionMode === 'auto-edit' ? 'auto-edit'
    : permissionMode === 'bypassPermissions' ? 'yolo'
    : null;
  if (qwenApprovalMode) args.push('--approval-mode', qwenApprovalMode);
}
args.push('--output-format', 'stream-json');
```

### 4.2 Arg construction: `-r` and `-p` per mode

The spawner in `server/qwen-cli.js#spawnQwen` branches on `sessionId` to
build the argv. Both modes pass `-p` whenever there is text:

- **Fresh (`-p <text>`)** — the user's message goes straight in via the
  non-interactive prompt flag. No `-r`, no stdin needed.
- **Resume (`-r <id>`)** — the user message is ALSO forwarded as `-p <text>`
  in addition to `-r`. This is required, not optional, in qwen 0.19.8:
  `qwen --help` documents `-p` as "Prompt. Appended to input on stdin (if
  any)" and CLI rejects runs with just `-r` and an empty stdin with
  `No input provided via stdin. Input can be provided by piping data into
  gemini or using the --prompt option.` (which used to abort every
  continuation message). Stdin stays OPEN in resume mode so the CLI does
  not protest the pipe; we never feed it any data.

We deliberately do NOT use `-i` (`--prompt-interactive`) because qwen CLI
rejects it when stdin is a closed pipe — see the comment in
`qwen-cli.js:151-157` for the full rejection message. For forward-compat
with `qwen serve --http-bridge` (when it stabilizes), the spawner can be
swapped to consume that endpoint instead.

### 4.3 Stdin handling per mode

Stdin treatment differs by branch:

- **Fresh** (`-p`, no `-r`) — `qwenProcess.stdin.end()` is called right
  after spawn. Without `.end()`, the CLI keeps the parent pipe open and
  waits forever for input the parent never sends.
- **Resume** (`-r <id>` + `-p`) — stdin stays OPEN (no `.end()`). Qwen
  0.19.8's resume mode reads from stdin in a tight loop until EOF; closing
  the pipe forces an early abort even when the prompt was already
  supplied via `-p`. Verified: `qwen --version` and `qwen --help` give
  no flag to disable that read; we just leave the pipe alone.

The contract is enforced by a single `if (!sessionId) { qwenProcess.stdin.end(); }`
after the spawn in `qwen-cli.js:200-202`.

### 4.4 stderr handling — warning vs error

Qwen 0.19.x writes informational notices to stderr even on successful runs:

- `Warning: running headless with --yolo` (sandbox/YOLO warning)
- Deprecation hints
- MCP startup chatter

If we forward every stderr line as `kind:'error'` to the UI, the chat shows a
red banner for a successful run. The spawner filters stderr against these
patterns (only treat as real error):

```js
const looksLikeError =
  /^Error:/i.test(trimmed)
  || /\bENOENT\b/i.test(trimmed)
  || /\binvalid params\b/i.test(trimmed)
  || /\bpermission_denied\b/i.test(trimmed);
if (!looksLikeError) {
  console.warn('[Qwen] stderr:', trimmed);
  return;
}
ws.send(createNormalizedMessage({ kind: 'error', content: trimmed, ... }));
```

This is the same demote-noise-to-warn pattern documented for Claude's
`ede_diagnostic` event and OpenCode's PM2 restart kill in `CLAUDE.md`.

### 4.5 Exit code ≠ 0 on success

Qwen 0.19.x emits a non-zero exit code whenever it has printed anything on
stderr — even just the YOLO/headless warning. The spawner tracks whether the
NDJSON stream emitted a `result.success` frame, and treats the close as
success if either the exit code is 0 OR `resultSuccessSeen`:

```js
if (code === 0 || resultSuccessSeen) {
  notifyTerminalState({ code: 0 });
  resolve();
  return;
}
```

Without this guard, a successful chat run was being reported as "run failed"
in the notification orchestrator (web-push + desktop notifications fired with
`run_failed` instead of `run_stopped`).

### 4.6 Verified by Phase 0

- `which qwen` → `/root/.local/bin/qwen`
- `qwen --version` → `0.19.8`
- `qwen -p "hola" --output-format stream-json` → emits NDJSON with
  `system.init`, `assistant` (with `parts[]` carrying `thought: true`), `result`.

### 4.7 Resume vs continue

Qwen has two resume mechanisms:

- `qwen --resume <id>` (per-id, like Claude `claude --resume`)
- `qwen --continue` (most recent in cwd)

The CloudCLI chat path passes `-r <id>` when an app session id exists; the
`-c` form is only relevant if we add an explicit "Resume most recent session"
UI button (open question for a follow-up UX pass).

## 5. Auth & environment

**Phase 0 reality (`qwen --help`):** there is **NO login subcommand**.

```
qwen auth          Configure authentication (removed)
```

`qwen auth` is listed in `--help` only as a deprecation stub. Credentials are
configured **out-of-band** by writing `~/.qwen/settings.json` (or exporting
env vars before spawn).

### 5.1 Verified settings.json shape (this host, 2026-07-08)

```json
{
  "env": {
    "QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO_ANTHROPIC_<hash>": "sk-cp-..."
  },
  "modelProviders": {
    "anthropic": [
      {
        "id": "MiniMax-M3",
        "name": "MiniMax-M3",
        "baseUrl": "https://api.minimax.io/anthropic",
        "envKey": "QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO_ANTHROPIC_<hash>"
      }
    ]
  },
  "security": { "auth": { "selectedType": "anthropic" } },
  "model": { "name": "MiniMax-M3", "baseUrl": "https://api.minimax.io/anthropic" }
}
```

**Critical detail:** the `envKey` value is a **hash of the baseUrl**, not a
human-readable name. Qwen derives it deterministically when `modelProviders`
is rewritten via `qwen mcp` or other management commands. Read path: trust
whatever `envKey` the file currently contains.

### 5.2 Credential resolution priority (highest first)

`qwen-auth.provider.ts` walks this 4-source cascade, returning the first hit
and only emitting `'Qwen not configured'` when **all are empty or missing**:

1. **`~/.qwen/settings.json`** — `security.auth.selectedType === 'anthropic'` →
   look up `modelProviders.anthropic[0].envKey` and read `env[<that key>]`.
   Same shape for `'openai'` / `'gemini'` / `'qwen-oauth'`.
2. **Environment variables on the CloudCLI process**:
   - `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`
   - `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL`
   - `GEMINI_API_KEY` + `GEMINI_MODEL`
   - `BAILIAN_CODING_PLAN_API_KEY` (Qwen Coding Plan)
3. **Project-level**: `.qwen/.env`, `.env`, `<project>/.qwen/.env`.
4. **Global**: `~/.qwen/.env`, `~/.env`.

### 5.3 Multi-source cascade pattern (mandatory)

Mirror `codex-auth.provider.ts:64-75`. Each source must be a separate helper
(`readSettingsJson()`, `readEnvCredentials()`, `readProjectDotenv()`,
`readGlobalDotenv()`) so the test suite can patch each in isolation. The
negative case "all sources empty" must return
`{ authenticated: false, error: 'Qwen not configured' }`.

### 5.4 Login UI

**There is no `ProviderLoginModal` for qwen.** `getProviderCommand()` in
`ProviderLoginModal.tsx` must NOT add a `qwen login` case — `qwen auth` is
removed and there's no fallback verb. Instead, the Settings → Agents → Qwen
row shows:

- Status badge: green if at least one source authenticated; red if not.
- **No "Iniciar sesión" button.** The action button is
  **"Configurar credenciales"**, opening a `QwenAuthInstructionsModal` (NEW,
  mirrors `ProviderLoginModal` structure but shows instructions instead of
  launching a PTY):
  - Tab 1: "Exportar variables de entorno" — copyable blocks per selected
    provider (`anthropic` / `openai` / `gemini`).
  - Tab 2: "Editar `~/.qwen/settings.json`" — shows current file contents
    (read-only) + a textarea for edits with "Guardar" button. Write is wrapped
    in a backup-to-`settings.json.bak` + atomic rename pattern.
  - Tab 3: "Estado actual" — table with each source × `present`/`missing` and
    the resolved `selectedType` + `model.name`.

### 5.5 Path safety

All writes to `~/.qwen/settings.json` must go through `utils/safe-write.js`
(atomic write + chmod 600 + `.bak` rotation) — same guarantees we apply for
`~/.codex/auth.json`. See the recipe in
[`docs/providers/codex.md`](./codex.md#auth-resolution--3-source-cascade).

## 6. Models

**Catalog strategy: hybrid — settings.json promotion + static fallback.**

### 6.1 Two-source model resolution

`qwen-models.provider.ts` resolves the model catalog in this priority order
(verified end-to-end on this host with the MiniMax proxy):

1. **`settings.json#model.name`** — promoted to `DEFAULT`. If the catalog is
   otherwise empty, it also becomes the first option. This was added after
   real-world bug: Codex + Qwen were both returning a hardcoded fallback list
   that included models the upstream proxy didn't accept (e.g. `gpt-5.5` on
   Codex, which the MiniMax proxy rejected with `2013 unknown model`).
   Verified: when `~/.qwen/settings.json#model.name === 'MiniMax-M3'`, that's
   the DEFAULT, and the UI selector only shows `MiniMax-M3` plus the static
   fallback list.

2. **Static fallback** `QWEN_FALLBACK_MODELS`:
   ```ts
   {
     OPTIONS: [
       { value: 'qwen3-coder-plus',  label: 'Qwen3 Coder Plus' },
       { value: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash' },
       { value: 'qwen3-max',         label: 'Qwen3 Max' },
       { value: 'qwen-vl-max',       label: 'Qwen VL Max' },
     ],
     DEFAULT: 'qwen3-coder-plus',
   }
   ```
   Note: `claude-sonnet-4.5` and `gpt-5.4` were removed in the final catalog —
   they're not Qwen models; the multi-protocol routing is achieved through
   `settings.json#modelProviders` instead.

3. **Defensive runtime validation** in `server/routes/agent.js#resolveModel`:
   ```js
   const resolveModel = (requested, def) => {
     if (!requested) return def.DEFAULT;
     if (def.OPTIONS.some((opt) => opt.value === requested)) return requested;
     return def.DEFAULT;
   };
   ```
   Applied to both `qwen` and `codex` branches. Stops a stale localStorage
   model from reaching the upstream proxy (which would crash the whole run
   with `invalid params`).

### 6.2 Cache strategy

Do NOT add qwen to `UNCACHED_PROVIDERS`
(`server/modules/providers/services/provider-models.service.ts:20`). Use the
on-disk cache like opencode.

If `qwen models` is discovered in a future version, mirror
`opencode-models.provider.ts:216-270` (`runOpenCodeModelsCommand`, 20s timeout).

## 7. Event protocol — `qwen --output-format stream-json` shape

**Verified against qwen 0.19.8 on 2026-07-08** using real sessions in
`~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl`.

### 7.1 Per-event shapes (NDJSON, one per line)

| Event `type` | Required fields | Optional fields | → NormalizedMessage kind |
|---|---|---|---|
| `system`, `subtype:"init"` | `uuid`, `sessionId`, `cwd`, `version`, `tools[]`, `mcpServers[]`, `model`, `slashCommands[]`, `qwenCodeVersion`, `agents[]` | — | (consumed by gateway; not surfaced as a chat message) |
| `user` | `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`, `gitBranch`, `message: { role: "user", parts: [{ text }] }` | `attachment` | `kind: 'text', role: 'user'` |
| `assistant` | `uuid`, `parentUuid`, `sessionId`, `timestamp`, `cwd`, `version`, `model`, `message: { role: "model", parts: [{ text, thought? }] }` | `usageMetadata`, `contextWindowSize` | split per-part (see § 7.2) |
| `thinking` | (top-level event, also seen) | `content`, `message` | `kind: 'thinking'` |
| `tool_use` | `uuid`, `sessionId`, `tool_name`, `tool_input`, `tool_use_id` | `id` | `kind: 'tool_use'` |
| `tool_result` | `uuid`, `sessionId`, `tool_use_id`, `content` | `is_error` | `kind: 'tool_result'`, attached to parent `tool_use` via `toolId` map |
| `error` | `error` or `message` | — | `kind: 'error'` |
| `result` | `sessionId`, `duration_ms`, `result` | `stats.{models,tools,files,skills}` | `kind: 'stream_end'` (terminal) |

### 7.2 `message.parts[]` for `assistant` events — THE CRITICAL DETAIL

Qwen 0.19.8 writes assistant rows as:

```json
{
  "type": "assistant",
  "message": {
    "role": "model",
    "parts": [
      { "text": "The user is asking...", "thought": true,  "thoughtSignature": "..." },
      { "text": "Hello! I'm Qwen Code..." }
    ]
  },
  "usageMetadata": {
    "promptTokenCount": 18549,
    "candidatesTokenCount": 151,
    "cachedContentTokenCount": 128,
    "thoughtsTokenCount": 0,
    "totalTokenCount": 18700
  },
  "contextWindowSize": 1000000
}
```

**Two structural facts the parser must handle:**

1. **`role: "model"`, not `"assistant"`** — Qwen uses Gemini's terminology
   (its parent project), not Anthropic's. The normalizer remaps to
   `role: 'assistant'` for the frontend.

2. **Reasoning inline via `parts[].thought: true`** — unlike Claude (which
   emits a separate `type: 'thinking'` event) or Gemini (separate
   `type: 'thought'` block), Qwen embeds the model's internal monologue as
   a sibling part inside the same `assistant` row. The normalizer must
   split each `part` into its own `NormalizedMessage`:
   - `{ text, thought: true }` → `kind: 'thinking'`, separate row
   - `{ text }` (no thought flag) → `kind: 'text', role: 'assistant'`, separate row

The original draft of this parser concatenated all visible parts into one
message and **dropped thought parts silently** — which produced a chat where
the assistant text showed up but the reasoning did not, breaking the
side-by-side display that Claude users expect. The current implementation
(`collectAssistantParts`) returns an ordered list and emits each part
separately.

### 7.3 usageMetadata → tokenUsage

`usageMetadata` lives at the top level of the assistant row (not inside
`message`). The normalizer stamps it on the LAST emitted message of the
assistant batch so the sessionStore picks it up as the canonical message
cost:

```ts
if (usage && messages.length > 0) {
  const last = messages[messages.length - 1];
  last.tokenUsage = { input, output, cached, total };
}
```

Field mapping:

| `usageMetadata` | `tokenUsage` |
|---|---|
| `promptTokenCount` | `input` |
| `candidatesTokenCount` | `output` |
| `cachedContentTokenCount` | `cached` |
| `totalTokenCount` | `total` |

If all four are zero, the stamp is skipped (defensive — empty metadata
shouldn't be persisted).

### 7.4 `result.stats.*` (free telemetry)

```json
{
  "stats": {
    "models": { "<model-name>": { "tokens": {...} } },
    "tools":  { "totalCalls": 12, "byName": {...} },
    "files":  { "totalLinesAdded": 0, "totalLinesRemoved": 0 },
    "skills": { "totalCalls": 0 }
  }
}
```

Mapped to the WebSocket `usage` block.

### 7.5 Defensive normalization

`QwenSessionsProvider.normalizeMessage()` returns `[]` for unrecognised event
types — never crashes. This matters specifically because (a) the CLI is
third-party and may evolve the schema between minor versions and (b) Qwen
emits all 37 `computer_use__*` tools in `init.tools[]` even when unused.

The normalizer also has a `collectAssistantParts` helper that:
- Reads `parts[]` first (Qwen 0.19.x shape)
- Falls back to `content[]` (Anthropic-style, kept for forward-compat if
  Qwen changes back)
- Returns empty array if neither is present — caller treats as "drop the row"

### 7.6 Deferred events (no real-time UI in MVP)

| Event type | Reason deferred |
|---|---|
| `permission_request` / `permission_cancelled` | `qwen -p` mode refuses them; needs `qwen serve --http-bridge` (Stage 1). See § 14. |
| `ask_user_question` tool_use | `qwen -p` mode: "The `ask_user_question` tool is unavailable in the current non-interactive mode." |
| `exit_plan_mode` tool_use | Same — non-interactive mode rejects it. |
| `system`, `subtype:"compact_boundary"` | No schema yet in 0.19.8. |
| `system`, `subtype:"ui_telemetry"` | Pure telemetry, never surfaced to user. |

## 8. MCP

`qwen-mcp.provider.ts` extends `McpProvider` with the qwen-specific scope and
transport tuple:

```ts
super('qwen', ['user', 'project'], ['stdio', 'http', 'sse']);
```

**File shape** per docs (JSON, key `mcpServers`):

```json
{
  "mcpServers": {
    "pythonTools": {
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": { "API_KEY": "${EXTERNAL_API_KEY}" },
      "timeout": 15000
    },
    "httpServer": { "httpUrl": "http://localhost:3000/mcp", "headers": {...} },
    "sseServer": { "url": "http://localhost:8080/sse" }
  }
}
```

Read/write paths:
- **user scope** → `~/.qwen/settings.json`
- **project scope** → `<workspace>/.qwen/settings.json`

UI constants in
[`src/components/mcp/constants.ts`](../../src/components/mcp/constants.ts):

```ts
MCP_PROVIDER_NAMES.qwen          = 'Qwen';
MCP_SUPPORTED_SCOPES.qwen        = ['user', 'project'];
MCP_SUPPORTED_TRANSPORTS.qwen    = ['stdio', 'http', 'sse'];
MCP_PROVIDER_BUTTON_CLASSES.qwen = 'bg-primary text-primary-foreground hover:bg-primary/90';
MCP_SUPPORTS_WORKING_DIRECTORY.qwen = false;
```

### 8.1 Managed MCP interoperability

Qwen participates in the cross-provider MCP dispatcher
(`server/modules/providers/services/mcp.service.ts`). When the user toggles
**Settings → MiniMax → Enable**, the dispatcher writes `cloudcli-minimax` to
**all six** provider configs (including Qwen) at user scope. Verified working
entry shape in `~/.qwen/settings.json`:

```json
{
  "mcpServers": {
    "cloudcli-minimax": {
      "command": "uvx",
      "args": ["minimax-coding-plan-mcp", "-y"],
      "env": {
        "MINIMAX_API_KEY": "sk-cp-...",
        "MINIMAX_API_HOST": "https://api.minimax.io"
      }
    }
  }
}
```

The `cloudli-` prefix triggers the "Managed" lock badge in
`src/components/mcp/view/McpServers.tsx#isManagedServer` (line ~58). Toggling
**MiniMax** OFF removes the entry from all six providers atomically.

### 8.2 Real bug found during testing

If the user's `~/.qwen/settings.json` contains an MCP entry that points at a
URL that doesn't exist (or any other startup-fatal config), Qwen **refuses
to start at all** — the spawn returns exit code 1 and the chat shows
"MCP server(s) failed to start: <name>" without any user output. Mitigation:
the synchronizer + the user-facing UI both rely on the user's manual removal
of broken entries. CloudCLI does NOT auto-clean MCP configs.

In our test case, the broken entry was `test-sse` with
`httpUrl: "https://example.com/sse"` — removed manually from
`~/.qwen/settings.json`. Recommend documenting the "remove or fix before
next chat" pattern in any user-facing Qwen MCP troubleshooting.

## 9. Skills

`qwen-skills.provider.ts` extends `SkillsProvider`. Two roots (project root
walks up to git root, matching opencode):

| Path | Scope | CommandPrefix |
|---|---|---|
| `~/.qwen/skills/<name>/SKILL.md` | user | `/` |
| `<git-root>/.qwen/skills/<name>/SKILL.md` | project | `/` |

**Frontmatter** (YAML): `name` (required, regex `/^[\p{L}\p{N}_:.-]+$/u`),
`description` (required), `priority` (optional, finite number — sort order in
`/skills` listing).

**Discovery** uses the provider-neutral
`findProviderSkillMarkdownFiles`
(`server/shared/utils.ts:939`).

**No cross-compat** with `<cwd>/.claude/skills` or `<cwd>/.agents/skills` in
the first iteration. Qwen's docs only mention `.qwen` paths. Add cross-compat
later if users complain.

The per-skill enable/disable toggle (`server/modules/providers/services/skill-state.service.ts`)
works out-of-the-box for Qwen via the same `SkillsProvider` base class.

## 10. Sessions and sessionSynchronizer

### 10.1 Where Qwen stores sessions

- **Transcripts:** `~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl`.
- **Sanitization rule:** the cwd segment under `projects/` replaces every
  non-`[A-Za-z0-9-]` run with `-` (mirror of Claude's encoding).
- **Subagent transcripts** (if Qwen spawns sub-agents the way Claude does):
  `<sanitized-cwd>/chats/<sessionId>/subagents/agent-<id>.jsonl`. Skip in
  the synchronizer to mirror Claude's rationale (subagent rows would
  clobber the parent).
- **Settings + auth:** `~/.qwen/settings.json` (no `.credentials.json` —
  Qwen 0.19.7 removed `qwen auth`; auth via env vars or direct JSON edit).

### 10.2 Chokidar watcher

`sessions-watcher.service.ts` registers chokidar with
`{ interval: 6000, usePolling: true, depth: 6 }` over `~/.qwen/projects/`,
filtering to `.jsonl` files. On each `add`/`change`:

- `sessionSynchronizerService.synchronizeProviderFile('qwen', filePath)` →
  `QwenSessionSynchronizer.synchronizeFile`.
- After change-debouncing (max 500 ms, max-wait 2 s) the gateway emits
  `session_upserted` WebSocket events to all connected clients.

### 10.3 QwenSessionSynchronizer specifics

- `synchronize(since?)`: recursive scan from `~/.qwen/projects/`, restricted
  to `…/<sanitized-cwd>/chats/*.jsonl`. Skip subagent paths.
- `synchronizeFile(filePath)`: process a single JSONL.
- `processSessionFile`: extract `sessionId` + `cwd` from the first JSONL entry
  with a valid `cwd` field. (The first entry is usually a `system` row; we
  scan until we find a row that has both `sessionId` and `cwd`.)
- Default name fallback: `normalizeSessionName(firstUserMessage, 'Untitled Qwen Session')`.

### 10.4 JSONL re-read path (history fetch)

When the user clicks a Qwen session in the sidebar, the chat composer calls
`/api/providers/sessions/:id/messages`, which routes through
`sessions.service.ts#fetchHistory` → `QwenSessionsProvider#fetchHistory`.

`fetchHistory` walks the JSONL file and calls `normalizeMessage` for each
line. **This re-reads the file from disk and runs the full normalization
pipeline** — same code path as the streaming live events. This is by
design: the on-disk JSONL is the source of truth for what was said, and
the streaming events are just the wire-protocol for it.

Critical: the history parser must handle the same `parts[] + thought: true`
shape as the streaming parser. The earlier bug — where the assistant message
was being silently dropped on history load — was caused by
`extractAssistantText` only reading `content[]` (the Anthropic-style shape),
missing the `parts[]` shape entirely. See § 7.2 for the fix.

### 10.5 What the user sees in the UI (silent-drop UX)

The flow when the user runs Qwen while CloudCLI is open:

1. User runs `qwen` in a shell on `/path/to/cwd`.
2. Qwen writes JSONL entries to
   `~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl` within the
   first tool call (or first user message).
3. CloudCLI's chokidar polling (6 s) picks up the new file, debounces
   500 ms, and broadcasts `session_upserted` over WebSocket to all
   connected clients.
4. The frontend handler does three things automatically:
   - Calls `projectsDb.createProjectPath(<cwd>)` — materializes the project
     in the DB and the sidebar even if no other Qwen session for that cwd
     existed.
   - Prepends the new session to `project.sessions`.
   - Marks `externalMessageUpdate` if the session is the currently open one
     (triggers a `refreshFromServer` of the last 20 messages).

**There is no toast, banner, badge "NEW", slide-in animation, sound, or
push notification.** The session appears silently. The only visible cue is
the pulsing green dot on the sidebar row (`lastActivity < 10 min`).

### 10.6 When the UI does NOT show a Qwen session

The synchronizer silently drops a file when:

- The JSONL parse fails or yields no `sessionId`.
- The `cwd` cannot be resolved (no row in the JSONL has `cwd`).
- The file lives under a `subagents/` path (intentional).
- The session row is archived (`isArchived = 1`) — the watcher skips the WS
  broadcast but the row remains in the DB.

There is no error surface in the UI for any of these.

### 10.7 Difference from other providers

| Provider | Watch root | Native storage | Subagent handling |
|---|---|---|---|
| Claude | `~/.claude/projects` | JSONL | `subagents/` skipped explicitly |
| Codex | `~/.codex/sessions` | JSONL | not addressed |
| Cursor | `~/.cursor/projects` | JSONL + `worker.log` | not addressed |
| Gemini | `~/.gemini/tmp/**/chats/` | JSONL | not addressed |
| OpenCode | `~/.local/share/opencode` | shared SQLite | n/a |
| **Qwen** | `~/.qwen/projects` | JSONL | mirror Claude (skip `subagents/`) |

### 10.8 Race-window de-dupe (creates vs assigns)

The session gateway creates an app-allocated row first
(`createAppSession` → `provider_session_id IS NULL`), the qwen CLI writes
the transcript on disk, the watcher polls it (6 s default) and the
chat-run-registry's `assignProviderSessionId` lands later. Without
de-duplication, that race creates two rows per chat:

- **Race order A (common)** — watcher wins: `createSession(B)` finds no
  row with `provider_session_id=B`, INSERTs a new row keyed by the
  provider-native id. `assignProviderSessionId(A, B)` then sets `A`'s
  `provider_session_id=B`. The DB ends up with **two** rows for the same
  conversation.
- **Race order B (rare)** — chat-run-registry wins: `createSession(B)`
  finds `A` by `provider_session_id` (now populated), UPDATEs in place.
  Single row, as intended.

Mitigation: `sessionsDb.createSession` does a 60-second de-dupe check
before the INSERT — if a recent row exists for the same
`(provider, project_path)` tuple with `provider_session_id IS NULL`,
the provider-native id is bound to that row via UPDATE instead of
INSERT. Window size of 60 s was chosen as a comfortable multiple of the
6 s polling interval. Implementation in
`server/modules/database/repositories/sessions.db.ts:118-152`.

### 10.9 Wire-up snippet (already shipped)

```ts
// server/modules/providers/services/sessions-watcher.service.ts
export const PROVIDER_WATCH_PATHS = {
  claude:    { rootPath: '~/.claude/projects' },
  codex:     { rootPath: '~/.codex/sessions' },
  cursor:    { rootPath: '~/.cursor/projects' },
  gemini:    { rootPath: '~/.gemini/tmp' },
  opencode:  { rootPath: '~/.local/share/opencode' },
  qwen:      { rootPath: '~/.qwen/projects' },
} as const;
```

## 11. UI integration (qwen-specific deltas)

This section zooms in on qwen **deltas** from the shared UI surface
documented in [`docs/providers/claude.md` → "UI integration"](./claude.md#ui-integration).
Read that first for the shared mechanics.

### 11.1 Header tabs

Provider-neutral. Qwen appears automatically once added to the chat composer
state — no switch change needed.

### 11.2 Chat tab — `useChatProviderState.ts`

The heaviest frontend file for provider integration:

- `FALLBACK_DEFAULT_MODEL` (line 12-17) → `qwen: 'qwen3-coder-plus'`.
- `FALLBACK_PERMISSION_MODES` (line 26-32) →
  `qwen: ['default', 'plan', 'auto-edit', 'bypassPermissions']` (4 real modes,
  not the original 2 — see § 1).
- `useState` pair (line 81-95) → `qwenModel` / `setQwenModel`.
- `setStoredProviderModel` (line 119-149) → `qwen-settings` localStorage
  branch.
- `providers: LLMProvider[]` (line 149) → includes `'qwen'`.
- `useEffect` reconciliation (line 262-325) → mirror opencode branch.
- Return shape → `qwenModel`, `setQwenModel`.

### 11.3 `useChatComposerState.ts:697-706`

Add `'qwen-settings'` localStorage branch (analogue to `claude-settings`,
`cursor-settings`).

### 11.4 `ProviderSelectionEmptyState.tsx`

- `PROVIDER_META` (line 26-32) → `{ id: 'qwen', name: 'Qwen' }`.
- `getCurrentModel` / `getProviderDisplayName` (line 75-96) → qwen branch.
- New props `qwenModel`, `setQwenModel` (line 47-52, 110-113).
- `setModelForProvider` (line 153-172) → qwen branch.
- `readyPrompt` lookup → `qwen: t('providerSelection.readyPrompt.qwen', { model: qwenModel })`.

### 11.5 `MessageComponent.tsx:150-158`

**Critical bug fixed during integration:** the provider-label ternary did
NOT include a `qwen` branch, so chat messages from Qwen were labeled
"Claude" next to the Qwen logo SVG. Fixed by adding:

```tsx
provider === 'qwen'
  ? t('messageTypes.qwen', { defaultValue: 'Qwen' })
  : t('messageTypes.claude')
```

The `messageTypes.qwen` i18n key already existed in all 11 locales (verified)
— the bug was purely in the JSX ternary. The `defaultValue: 'Qwen'` mirrors
the `opencode` branch as a defensive fallback.

The same bug existed in `ChatInterface.tsx:287-297` (the
`selectedProviderLabel` ternary for the no-project landing page) — fixed
in the same commit.

### 11.6 `SessionProviderLogo.tsx`

Chained lookup at top:

```tsx
if (provider === 'qwen') return <QwenLogo />;
```

`QwenLogo.tsx` is the official Alibaba Qwen mark, faithful to the CLI's
ASCII output.

### 11.7 Shell / CLI tab

`shell-websocket.service.ts:132-171` (`buildShellCommand`):

```ts
if (provider === 'qwen') {
  if (resumeSessionId) return `qwen --resume "${resumeSessionId}" || qwen`;
  return 'qwen';
}
```

Plus chained `providerName` ternary at line 474-484.

### 11.8 Sidebar left sessions list

Provider-neutral. `SidebarSessionItem` automatically renders
`<SessionProviderLogo provider="qwen" />` once the icon file exists.

### 11.9 Auth-status surface

- `provider-auth/types.ts:13-29`:
  ```ts
  CLI_PROVIDERS = [..., 'qwen'];
  PROVIDER_AUTH_STATUS_ENDPOINTS.qwen = '/api/providers/qwen/auth/status';
  createInitialProviderAuthStatusMap = { ... new Map entry for qwen };
  ```
- `useProviderAuthStatus.ts:109` reads from the map — no direct change.
- Server: `/api/providers/qwen/auth/status` route serving
  `QwenProviderAuth.getStatus()`.

### 11.10 Skills panel

`src/components/skills/view/ProviderSkills.tsx:59-72`:

```ts
PROVIDER_NAMES.qwen = 'Qwen';
PROVIDER_SKILL_PATHS.qwen = '~/.qwen/skills/<skill-name>/SKILL.md';
providerPath rule at L223 handles qwen (not opencode which is excluded).
```

### 11.11 MCP panel

`src/components/mcp/constants.ts` — see § 8 for the five constants.

### 11.12 Permissions

Four modes in `FALLBACK_PERMISSION_MODES.qwen`:
`['default', 'plan', 'auto-edit', 'bypassPermissions']`. The first iteration
uses a generic permission selector (no dedicated `<QwenPermissions />`
component), which falls through to the same UI as OpenCode and Gemini.

Mapping (`qwen-cli.js`):

| UI value | `--approval-mode` flag |
|---|---|
| `default` | (no flag) |
| `plan` | `plan` |
| `auto-edit` | `auto-edit` |
| `bypassPermissions` | `yolo` |

### 11.13 Icon + provider identity

`src/components/llm-logo-provider/QwenLogo.tsx` — the official Alibaba Qwen
mark, faithful to the CLI's ASCII output.

Update `SessionProviderLogo.tsx:1-34`:

```ts
import { QwenLogo } from './QwenLogo';
// chained:
if (provider === 'qwen') return <QwenLogo />;
```

### 11.14 Login flow

`ProviderLoginModal.tsx:15-53`:
- `getProviderCommand(provider)` must NOT add a `qwen login` case — see § 5.4.
- `getProviderTitle(provider)` → `'Qwen Code CLI Configuración'` (instructions,
  not login).

The PTY path is unused for Qwen since there's no login verb.

### 11.15 Onboarding

`AgentConnectionsStep.tsx:12-40`:
- `providerCardStyles.qwen = { connectedClassName, iconContainerClassName, loginButtonClassName }` (red palette).
- `providerKeys` array → append `'qwen'`.

### 11.16 Settings → Agents

- `AgentListItem.tsx:18-57`:
  ```ts
  agentConfig.qwen = { name: 'Qwen', color: 'red' };
  colorClasses.red = { dot: 'bg-red-500' };
  ```
- `AgentsSettingsTab.tsx:23-101`:
  - `visibleCategories` for qwen: `['account', 'permissions', 'mcp', 'skills']`
    (full set — Qwen's skills provider is fully implemented).
  - `visibleAgents` → includes `'qwen'`.
  - `agentContextById.qwen` placeholder.
- `AccountContent.tsx:23-66` → qwen row in `agentConfig` record.
- `useSettingsController.ts:152-412` → state persistence for
  `qwenPermissions` (currently identical to the opencode path).

### 11.17 i18n keys to add (already shipped in all 11 locales)

en + es natively; 9 fallback locales verbatim English per project convention:

- `settings.onboarding.agents.providerTitles.qwen` → "Qwen Code"
- `settings.onboarding.agents.status.{authenticated,unauthenticated,checking}.qwen`
- `chat.providerSelection.readyPrompt.qwen` → "¿Qué puedo hacer por ti con {{model}}?"
- `chat.messageTypes.qwen` → "Qwen"

## 12. Real bugs found and fixed during integration

These are the field-discovered issues that turned the original draft into
the working integration. Documenting them so the next provider doesn't
repeat them.

### 12.1 `message.parts[]` not `message.content[]`

The original parser assumed Anthropic's `content: [{type, text}]` shape.
Qwen 0.19.x uses Gemini's `parts: [{text, thought?}]` shape. The first
version of `extractAssistantText` returned `''` for every Qwen assistant
row, so the assistant message was silently dropped on history load.

**Fix:** added `parts[]` reading + `content[]` fallback in
`collectAssistantParts`. See § 7.2.

### 12.2 Thought parts concatenated into visible text

Even after fixing the parser, the original `extractAssistantText` walked
`parts[]` and only took parts without `thought: true`, joining the rest
into one visible text. This produced a single "assistant" row that mixed
reasoning with the visible reply.

**Fix:** `collectAssistantParts` returns an array of `{kind, text}`
entries. The normalizer emits each as its own `NormalizedMessage` —
`kind: 'thinking'` for thought parts, `kind: 'text'` for the rest. See § 7.2.

### 12.3 `usageMetadata` discarded

The original parser only looked at `message.usage` (Anthropic-style).
Qwen writes `usageMetadata` at the top level of the assistant row. The
chat UI showed no token consumption for Qwen sessions.

**Fix:** the normalizer stamps `tokenUsage` on the last emitted message
of the assistant batch when `usageMetadata` is present. See § 7.3.

### 12.4 Stale localStorage model crashed the upstream proxy

User had `qwen-model = 'gpt-5.5'` in localStorage (probably set during a
different session). The hardcoded fallback catalog didn't include `gpt-5.5`
but the runtime happily forwarded it to the MiniMax proxy, which rejected
it with `2013 unknown model 'gpt-5.5'`. Same bug existed for Codex
(`gpt-5.5` instead of `MiniMax-M3`).

**Fix:** two-layer defense.
1. `qwen-models.provider.ts` (and `codex-models.provider.ts`) now read
   `settings.json#model.name` (or `~/.codex/config.toml#model`) and promote
   it to `DEFAULT` when the fallback catalog is empty.
2. `routes/agent.js#resolveModel` rejects any requested model that isn't in
   the current `def.OPTIONS`, falling back to `DEFAULT`. See § 6.1.

### 12.5 stderr treated as `kind:'error'`

Qwen prints informational notices to stderr on every successful run (YOLO
warning, sandbox notice, deprecation hints). The original spawner
forwarded every stderr line as `kind: 'error'`, so the chat UI showed a
red "Error" banner for successful runs.

**Fix:** filter stderr against `Error:`, `ENOENT`, `invalid params`,
`permission_denied` — only those become real errors. Everything else is
`console.warn`-ed. See § 4.3.

### 12.6 Exit code ≠ 0 on success

Even with the stderr filter, the spawner still rejected runs that exited
non-zero (because Qwen prints the YOLO warning before exiting). The
notification orchestrator fired `run_failed` instead of `run_stopped`.

**Fix:** track `resultSuccessSeen` — if a `result.success` frame was
emitted on stdout, the run is successful regardless of exit code. See § 4.4.

### 12.7 Duplicate sidebar rows on chat send

The first send in a new session produced TWO rows in the sidebar: one from
`registerOptimisticSession` (prepended by the frontend) and one from the
canonical `session_upserted` (after the watcher indexed the JSONL).
The merge logic in `useProjectsState.ts` was unreachable because it was
placed in the `if (!existingProject)` branch but the project always
existed (the user was already on the project page).

**Fix:** deleted `registerOptimisticSession` entirely (now a no-op kept
for backward compat with the hook signature). The `chat-run-registry`'s
canonical upsert handles the case correctly — the watcher event + the URL
`/session/<appId>` are enough on their own.

### 12.8 "Claude" label in Qwen chats

The provider-label ternary in `MessageComponent.tsx` (and
`ChatInterface.tsx`) didn't have a `qwen` branch, so Qwen chat messages
were labeled "Claude" next to the Qwen logo. See § 11.5.

### 12.9 Broken `test-sse` MCP entry blocked Qwen startup

User had manually added a fake MCP entry `test-sse` with
`httpUrl: "https://example.com/sse"` to `~/.qwen/settings.json`. Qwen
tried to start it at chat-spawn time, failed, and aborted the entire run
with `MCP server(s) failed to start: test-sse`. See § 8.2.

### 12.10 `-r <id>` without `-p` aborted every continuation message

The first send worked because `qwen-cli.js` used `-p <text>` only. Once the
chat-run-registry captured the provider-native session id, subsequent sends
were dispatched as `qwen -r <providerSessionId>` with no prompt flag — and
qwen 0.19.8 treats that as interactive mode and aborts with
`No input provided via stdin. Input can be provided by piping data into
gemini or using the --prompt option.` (note the gemini token in the error
string — Qwen forked the Gemini CLI codebase).

`qwen --help` documents the situation as `-p, --prompt Prompt. Appended
to input on stdin (if any).` — `-p` is **required** when resuming, not
optional as one might assume.

**Fix:** `qwen-cli.js#spawnQwen` always appends `-p <text>` whenever the
user supplied text, alongside `-r <id>` for resume mode. Stdin handling
also branches on `sessionId` (open in resume, closed in fresh) — see § 4.2
and § 4.7.

### 12.11 Watcher / chat-run-registry race created a phantom "Nueva sesión" row

Symptom: every new Qwen chat produced TWO rows in the sidebar — the real
session ("hola", with `provider_session_id` populated) plus an orphan
"Nueva sesión" row keyed by the app-allocated UUID with `provider_session_id
= NULL` and no `jsonl_path`.

Root cause: the file watcher polls every 6 s (`PROVIDER_WATCH_PATHS.qwen`)
and calls `sessionsDb.createSession(providerNativeId, ...)` whenever it
spots a new `.jsonl`. In the race window between `POST /api/providers/sessions`
(creates row `session_id=A`, `provider_session_id=NULL`) and
`assignProviderSessionId(A, B)` (sets `provider_session_id=B`), the
watcher can land first — see the existing row by `provider_session_id=B`
query in `createSession`, find nothing, and INSERT a second row keyed by
the provider-native id `B`. `assignProviderSessionId` then fills the
original row `A` with `provider_session_id=B`, leaving both rows in the
table. The sidebar renders both as separate conversations.

Claude/Cursor/Gemini don't hit this because the SDK emits the
`session_created` event before writing the transcript in most cases (or
the chat-run-registry assigns before the watcher polls). Qwen writes the
transcript on the first prompt emit, so the watcher wins the race often
enough to surface as a reproducible bug.

**Fix:** `sessionsDb.createSession` now does a 60-second de-dupe window
before the INSERT — if a recent row exists for the same
`(provider, project_path)` tuple with `provider_session_id IS NULL`, the
provider-native id is bound to that row via UPDATE instead of creating a
duplicate. See `server/modules/database/repositories/sessions.db.ts:118-152`
and § 10.9.

## 13. Capabilities & UI support (Qwen row — IMPLEMENTED)

This row is what `docs/providers/agente.md` mirrors. **Update in the same
commit as any change here.**

| Property | Qwen value |
|---|---|
| Login command | **None** (`qwen auth (removed)`) — auth via `~/.qwen/settings.json` or env vars |
| Auth cascade | **4 sources**: `settings.json → process.env → project dotenv → global dotenv` |
| Permission modes (UI) | `['default', 'plan', 'auto-edit', 'bypassPermissions']` (4 real modes) |
| Permission modes (CLI) | `plan`, `default`, `auto-edit`, `yolo` (verified against qwen 0.19.8) |
| MCP scopes | `['user', 'project']` |
| MCP transports | `['stdio', 'http', 'sse']` |
| `supportsPermissionRequests` | `false` (`qwen serve --http-bridge` is Stage 1 experimental) |
| Interactive UI | **No** (raw JSON fallback for `ask_user_question` / `exit_plan_mode`) |
| `tool_use` renderer | **Rich** (same renderers as Claude — qwen forked Claude's tool surface) |
| Custom providers | **Yes** — multi-model via `settings.json#modelProviders.<type>[]` with custom `baseUrl` |
| Model catalog | **Hybrid** — `settings.json#model.name` promoted to DEFAULT + static `QWEN_FALLBACK_MODELS` |
| Streaming | **Per-frame** (NDJSON `assistant` events contain full `parts[]` of that turn — no token-level deltas) |
| `stats` telemetry | **Yes** — `result.stats.{models,tools,files,skills}` |
| `usageMetadata` per-row | **Yes** — top-level on assistant row, mapped to `tokenUsage` on the last emitted message |
| Session store | Filesystem JSONL at `~/.qwen/projects/<encoded-cwd>/chats/<session-id>.jsonl` |
| Resume flag | `-c/--continue` (boolean, latest) and `-r/--resume <id>` (string) |
| Sandbox | `-s, --sandbox [boolean]` (qwen's own, not Claude's) |
| `chat-recording` | `--chat-recording [boolean]` — false → `-c/-r` won't work |
| Brand color | Tailwind `red` (Aliyun red-orange) |
| Reasoning format | Inline `parts[]` with `thought: true` flag (NOT a separate `type:'thinking'` event) |
| Assistant role in JSONL | `"model"` (NOT `"assistant"`) — Gemini-style terminology |
| Managed MCP participation | **Yes** — `cloudcli-minimax` verified working, `cloudcli-browser-use` etc. compatible |
| Skills panel | **Yes** — full Settings → Habilidades integration with per-skill enable/disable |
| Status | **IMPLEMENTED** — production-ready, all 12 phases shipped |

## 14. Out of scope

- ❌ `qwen serve` HTTP daemon integration (multi-client shared agent).
- ❌ `qwen channel` IM integration (Telegram, Discord, DingTalk, WeChat, Feishu).
- ❌ `qwen extensions` / `--install-extension` (plugin ecosystem).
- ❌ Real interactive prompts (`ask_user_question`, `exit_plan_mode`,
  `permission_request`) — requires `qwen serve --http-bridge` which is
  Stage 1 experimental in upstream Qwen. Tracked as follow-up.
- ❌ Computer Use UI panel (capability flag exists, no panel).
- ❌ Agent Arena UI (multi-model head-to-head).
- ❌ Refactor of `spawnFns`/`abortFns` into `provider.registry.ts` (architectural gap, follow-up).
- ❌ `routes/git.js` commit-message generation extension (qwen doesn't have that feature). The universal `ensureConventionalCommitPrefix()` helper already auto-prefixes free-form commit messages with `chore:` for **all** providers.
- ❌ Cross-compat with `<cwd>/.claude/skills` and `<cwd>/.agents/skills` (qwen docs only mention `.qwen`).

## 15. Verification

After every change to Qwen code, run:

```bash
# Static checks
npm run typecheck
npm run lint

# Backend tests
cd /opt/cloud-cli2026/server && PATH=/opt/node22/bin:$PATH \
  npx tsx --test modules/providers/tests/qwen-sessions.test.ts \
             modules/providers/tests/qwen-models.test.ts \
             modules/providers/tests/qwen-auth.test.ts
```

**Runtime smoke test** (with qwen-code installed):

```bash
qwen --version          # exits 0, prints 0.19.8
pm2 restart cloud-cli2026
```

**Manual UI verification (in order):**

1. Settings → Agents → row "Qwen" appears with red dot.
2. Settings → Agents → Qwen → Habilidades tab lists skills from
   `~/.qwen/skills/<name>/SKILL.md`.
3. Settings → MCP Servers → Qwen tab shows the cloudcli-minimax entry (if
   toggled on).
4. New chat → select Qwen provider → send "hola" → reply comes back as
   "Qwen" (not "Claude") next to the Qwen logo.
5. Open the same chat from the sidebar → history shows the full conversation
   (user + assistant, with reasoning block if Qwen used `thought: true`).
6. Send a SECOND message in the same chat ("que hora y fecha tienes?") →
   reply comes back. **Verify the sidebar still shows ONE row for the
   session, not two** — the race-window de-dupe in
   `sessionsDb.createSession` (see § 10.9) prevents the "Nueva sesión"
   phantom row.
7. Restart CloudCLI → reopen the same chat → history still loads (verified
   against `~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl`).

## 16. Sources

- [github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) — README +
  capability comparison table (Claude Code parity).
- [qwenlm.github.io/qwen-code-docs/en/users/configuration/auth](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth) — auth env vars.
- [qwenlm.github.io/qwen-code-docs/en/users/features/mcp](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp) — `mcpServers` schema, `qwen mcp add|remove|list`.
- [qwenlm.github.io/qwen-code-docs/en/users/features/headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless) — `--output-format stream-json`, `--continue`/`--resume`.
- [qwenlm.github.io/qwen-code-docs/en/users/features/skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills) — `SKILL.md` format.
- [qwenlm.github.io/qwen-code-docs/en/users/configuration/settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings) — settings.json schema.
- npm: `@qwen-code/qwen-code@0.19.8` (verified live on this host 2026-07-08).

## 17. See also

- [`docs/providers/claude.md`](./claude.md) — canonical UI integration
  reference (most sub-sections are shared chrome across all providers).
- [`docs/providers/opencode.md`](./opencode.md) — closest backend precedent
  (CLI subprocess + NDJSON + slash-style skills).
- [`docs/providers/gemini.md`](./gemini.md) — precedent for JSONL session
  storage + stream-json output. Qwen also follows Gemini's
  `parts[]` + `role: "model"` convention.
- [`docs/providers/codex.md`](./codex.md) — precedent for "resume last
  session" via `--continue` flag (qwen equivalent is `qwen --continue`). Also
  precedent for the **multi-source auth cascade** pattern
  (settings.json / env vars) — qwen follows the same shape.
- [`docs/providers/agente.md`](./agente.md) — cross-provider comparison matrix
  + auth resolution table (qwen row marked IMPLEMENTED). When implementation
  changes, update the qwen row of both matrices **in the same commit**.
- `server/modules/providers/README.md` — facet contract, registration, types.

## 18. Memory file convention

Qwen CLI's `/memory` builtin opens the project's `QWEN.md` (or `AGENTS.md`
if `QWEN.md` is not present).

- **Filename**: `QWEN.md` is the canonical Qwen-specific name; falls back to
  `AGENTS.md` (the cross-agent standard shared with Codex and OpenCode).
- **Auto-loaded**: Qwen reads `<project>/QWEN.md` then `<project>/AGENTS.md`
  on every prompt.
- **UI surface**: listed in the Command Palette as `/memory` with the chip
  `builtin`. CloudCLI lists it as-is from the provider.
- **Symbiosis with skills**: Skills live under qwen-specific folders
  (`~/.qwen/skills/` and `<git-root>/.qwen/skills/`, see § 9). The memory
  file is independent of the skills folder.