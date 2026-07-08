# Qwen Code provider

> **Status: DRAFT — not yet integrated.** This document is the integration plan
> for adding [Qwen Code][qwen-code] as the 6th provider of CloudCLI. See
> [section 11 — Implementation roadmap](#11-implementation-roadmap) for the
> sequenced step-by-step and [section 13](#13-open-questions) for the gate
> questions that block implementation.

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
chrome) that's identical across all five production providers, see
[`docs/providers/claude.md` → "UI integration"](./claude.md#ui-integration).
This doc zooms in on the qwen-specific **deltas** from that baseline.

[qwen-code]: https://github.com/QwenLM/qwen-code

## 1. Status

DRAFT — not yet integrated. Six facets to implement + ~40 frontend touch points
across 12 phases. See [section 11](#11-implementation-roadmap).

## 2. Architecture at a glance

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
                 │  --output-format stream-   │
                 │  json --include-partial-   │
                 │  messages                  │
                 │  NDJSON line buffer        │
                 └──────────────┬─────────────┘
                                │ session_created
                                │ tool_use
                                │ thinking
                                │ result
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
                 └────────────────────────────┘
```

**Transport note:** unlike Claude (in-process `@anthropic-ai/claude-agent-sdk`),
qwen is a **subprocess** model — exactly like opencode, gemini, cursor, codex.
The npm package `@qwen-code/qwen-code@0.19.7` is the CLI binary, **not** a
TypeScript API (verified by `npm pack` — `package.json#main` = `cli.js`, no
`types`, no `dist/index.js`).

## 3. Backend module layout

The qwen provider lives at `server/modules/providers/list/qwen/`. Seven files
mirror the opencode pattern (the closest precedent — see
[`docs/providers/opencode.md`](./opencode.md)):

| Facet | File | Exported class | Pattern source |
|---|---|---|---|
| Wrapper | `qwen.provider.ts` | `QwenProvider extends AbstractProvider` | `opencode.provider.ts` |
| Auth | `qwen-auth.provider.ts` | `QwenProviderAuth implements IProviderAuth` | `opencode-auth.provider.ts` |
| Models | `qwen-models.provider.ts` | `QwenProviderModels implements IProviderModels` + `QWEN_FALLBACK_MODELS` | `opencode-models.provider.ts` |
| MCP | `qwen-mcp.provider.ts` | `QwenMcpProvider extends McpProvider` | `gemini-mcp.provider.ts` (closer than opencode on JSON shape) |
| Skills | `qwen-skills.provider.ts` | `QwenSkillsProvider extends SkillsProvider` | `opencode-skills.provider.ts` |
| Sessions | `qwen-sessions.provider.ts` | `QwenSessionsProvider implements IProviderSessions` | `gemini-sessions.provider.ts` (JSONL) |
| Session sync | `qwen-session-synchronizer.provider.ts` | `QwenSessionSynchronizer implements IProviderSessionSynchronizer` | `gemini-session-synchronizer.provider.ts` |

Plus the chat runtime spawner at the server root (parallel to `server/opencode-cli.js`,
`server/gemini-cli.js`):

| Chat runtime | File | Exports |
|---|---|---|
| Spawner | `server/qwen-cli.js` (NEW) | `spawnQwen`, `abortQwenSession`, `isQwenSessionActive`, `getActiveQwenSessions` |

## 4. Runtime CLI: `server/qwen-cli.js`

Mirror `server/opencode-cli.js:85-319`. Concretely:

- `const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;`
- **Flags confirmed by Phase-0 probing** (`qwen --help`, v0.19.7):
  - `--output-format [choices: "text", "json", "stream-json"]` — **NO `--include-partial-messages`** flag exists (unlike Claude). `stream-json` is plain NDJSON, one event per line; `json` wraps the whole run as a single array.
  - `-c, --continue [boolean]` — resume most recent session for the current cwd.
  - `-r, --resume <string>` — resume a specific session by id; without id shows session picker.
  - `-m, --model <string>` — overrides `settings.json#model.name` for this run.
  - `--fallback-model <string[]>` — repeatable, max 3.
  - `-p, --prompt <string>` — appended to input on stdin (if any).
  - `-s, --sandbox [boolean]` — run in qwen's own sandbox (not Claude's).
  - `--safe-mode [boolean]` — disables context files / hooks / extensions / skills / MCP for troubleshooting.
  - `--bare [boolean]` — skip implicit startup auto-discovery; only honor explicit CLI inputs.
  - `--proxy <schema://user:pw@host:port>` — proxy for Qwen Code (deprecated → settings.json `proxy`).
  - `--insecure [boolean]` — skip TLS (lab only).
  - `--chat-recording [boolean]` — when false, history not saved; `-c/-r` won't work.
- Args assembled before spawn (corrected from `--include-partial-messages`):
  ```js
  const args = ['--output-format', 'stream-json'];
  if (sessionId) args.push('--resume', sessionId);
  else if (continueLast) args.push('--continue');
  if (resolvedModel) args.push('--model', resolvedModel);
  if (sandboxMode) args.push('--sandbox');
  args.push(command?.trim() ?? '');   // empty for sessions without a fresh prompt
  ```
- `qwenProcess = spawnFunction('qwen', args, { cwd, stdio: 'pipe', env: ...process.env });`
- **Stdin handling (do NOT close early).** Unlike `opencode-cli.js:219` which closes
  `opencodeProcess.stdin.end()` immediately after spawn (locking out future
  round-trip responses to mid-stream tools), the qwen spawner should keep
  `qwenProcess.stdin` open until the run completes or is aborted. This is a
  forward-compat decision: if qwen-code later exposes an interactive flow
  (analogous to Claude's `canUseTool` callback), the driver will need to
  inject responses back to the subprocess over stdin. Closing it on spawn
  forecloses that path. For the first iteration, the spawner simply does not
  touch stdin — the CLI does not read from it.
- `activeQwenProcesses: Map<sessionId, ChildProcess>`. `registerQwenSession()` re-keys when qwen announces its native session id (first event with `session_id`).
- NDJSON line buffer (`split(/\r?\n/)`) — reuse pattern at `opencode-cli.js:221-229`.
- `completeSent` flag shared between `close` and `error` handlers — `opencode-cli.js:97`.
- `stderr` → `stream_delta` frames with `kind:'error'` — mirror `opencode-cli.js:231-243`.
- `abortQwenSession(id)`: `process.aborted = true` + `kill('SIGTERM')` — mirror `opencode-cli.js:322-334`.

The chat path **does NOT use `server/qwen-cli.js` as a `spawnFn`** —
`query<Provider>SDK` analogues don't exist for qwen (no TS SDK). Instead
the runtime is wired in via the standard `spawnFns.qwen` slot in
[`server/index.js:117-130`](../../server/index.js#L117) (analogue: opencode at
`server/index.js:118`).

### Verified by Phase 0

- `which qwen` → `/root/.local/bin/qwen`
- `qwen --version` → `0.19.7`
- `qwen -p "hola" --output-format stream-json` → emits NDJSON with `system.init`, `assistant.thinking`, `assistant.text`, `result.success` events.

### Subprocess vs `qwen serve` daemon

`qwen serve` (Stage 1 experimental `--http-bridge` flag) exposes the agent as an
HTTP+SSE/ACP daemon for multi-client access. **NOT in scope for the first PR.**
Follow-up: when CloudCLI gains a "shared agent across tabs" feature, swap the
spawner to consume that endpoint instead.

### Resume vs continue

Unlike the Codex/Claude "resume by id" pattern (which CloudCLI follows), qwen
has two resume mechanisms:

- `qwen --resume <id>` (per-id, like Claude `claude --resume`)
- `qwen --continue` (most recent in cwd, the equivalent of `claude -c` we just
  discussed in the previous turn — see [`docs/providers/codex.md`](./codex.md)
  for the analogous decision point)

The shell path (`shell-websocket.service.ts:139-147`-style) wires the `--resume
<id>` form when CloudCLI has an app session id. The `--continue` form is only
relevant if we add an explicit "Resume most recent session" UI button (open
question for the follow-up UX pass).

## 5. Event protocol — `qwen --output-format stream-json` shape

**Phase 0 (v0.19.7) confirmed event names — verbatim shapes captured from a
live spawn** (`qwen -p "hola" --output-format stream-json`):

### Per-event shapes (NDJSON, one per line)

| Event `type` | Required fields | Optional fields | → NormalizedMessage kind |
|---|---|---|---|
| `system`, `subtype:"init"` | `uuid`, `session_id`, `cwd`, `tools[]`, `mcp_servers[]`, `model`, `permission_mode`, `slash_commands[]`, `qwen_code_version`, `agents[]` | — | `session_created` (first iteration — tracks model, available tools, agents, MCP) |
| `assistant` | `uuid`, `session_id`, `message.{id,role:"assistant",model,content[]}` | `parent_tool_use_id`, `message.usage` | frame-by-frame map of `message.content[]` (see below) |
| `user` (echoed user turn) | `uuid`, `session_id`, `message.{role:"user",content[]}` | `parent_tool_use_id` | pass-through (or skip — same as opencode) |
| `user` with `tool_result` | same as above, but `message.content[]` has items `{type:"tool_result",tool_use_id,is_error,content}` | — | `tool_result`, linked to prior `tool_use` by `tool_use_id` |
| `result`, `subtype:"success"` | `uuid`, `session_id`, `is_error`, `duration_ms`, `duration_api_ms`, `num_turns`, `result` (string), `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `total_tokens`) | `permission_denials[]`, `stats.{models,tools,files,skills}` | `stream_end` (single terminal event) |
| `result`, `subtype:"error_max_turns"` / `"error"` | same + `is_error:true`, error payload | — | `stream_end` with `kind: 'error'` |

### `message.content[]` for `assistant` events

Each item is one of:
- `{type:"thinking", thinking:"..."}` → `kind: 'thinking'`
- `{type:"text", text:"..."}` → `kind: 'text'`
- `{type:"tool_use", id:"call_function_xxx", name:"grep_search"|"read_file"|"ask_user_question"|..., input:{...}}` → `kind: 'tool_use'`

**No `delta` events.** Unlike Claude's `--include-partial-messages`, qwen emits
each `assistant` event with the complete `content[]` array for that turn.
Streaming UX = `stream_delta` per `assistant` frame, not per token. Document
this as a qwen limitation in the comparison table.

### `result.stats.*` (free telemetry)

```json
{
  "stats": {
    "models": { "<model-name>": { "api": {...}, "tokens": {...}, "bySource": {...} } },
    "tools":  { "totalCalls": 12, "totalSuccess": 12, "byName": { "grep_search": {...} } },
    "files":  { "totalLinesAdded": 0, "totalLinesRemoved": 0 },
    "skills": { "totalCalls": 0, "totalSuccess": 0, "byName": {} }
  }
}
```

`QwenSessionsProvider` maps `stats.models.<model>.tokens.{input,output,cached,total}`
directly into the WebSocket `usage` block — no need to scrape `usage` events.
`stats.tools.byName` is useful for the token-usage dashboard.

### `permission_denials[]` (free telemetry)

Empty array in all our probes (qwen does not block tools in non-interactive mode).
Map each entry as `kind: 'error'` with `text: 'permission_denied: <tool>'` if
non-empty — useful as a signal that the user's `permission_mode` is too strict.

### Tool names that qwen supports (from `tools[]` in init event)

`grep_search`, `read_file`, `glob`, `list_directory`, `web_fetch`, `cron_create`,
`cron_list`, `cron_delete`, `loop_wakeup`, `agent`, `task_stop`, `send_message`,
`read_mcp_resource`, `tool_search`, `skill`, `ask_user_question`, `exit_plan_mode`,
`enter_plan_mode`, `enter_worktree`, `exit_worktree`, plus
`computer_use__<action>` (37 computer-use tools).

**CloudCLI already recognizes most of these** from Claude (same names by design —
qwen forked Claude's tool surface). No new `ToolRenderer` registrations needed
in MVP except `skill` if we want to render skill invocations separately.

### Deferred events (Phase 0 + first iteration)

| Event type | → NormalizedMessage kind | First iteration? |
|---|---|---|
| `permission_request` | `permission_request` | **Deferred** — see [§ 18](#18-interactive-prompts-ui-planned) |
| `permission_cancelled` | `permission_cancelled` | **Deferred** — see [§ 18](#18-interactive-prompts-ui-planned) |
| `ask_user_question` tool_use (in assistant.content[]) | `tool_use` with `name: 'ask_user_question'` | **Deferred** — qwen's `-p` mode refuses to invoke it (verified: "The `ask_user_question` tool is unavailable in the current non-interactive mode"). Would require `qwen serve --http-bridge` (Stage 1 experimental) for real interactivity. |
| `exit_plan_mode` tool_use | `tool_use` with `name: 'exit_plan_mode'` | **Deferred** — same reason. |
| `system`, `subtype:"compact_boundary"` | `status` | Phase 2 (no schema yet) |
| `system`, `subtype:"session_start"` | `session_started` | Phase 2 |

### Defensive normalization

`QwenSessionsProvider.normalizeMessage()` must mirror opencode at
[`opencode-sessions.provider.ts:222-319`](../../server/modules/providers/list/opencode/opencode-sessions.provider.ts#L222):
return `[]` for unrecognised event types — never crash. This matters specifically
because (a) the CLI is third-party and may evolve the schema between minor
versions and (b) qwen emits all 37 `computer_use__*` tools in `init.tools[]`
even when unused. Fall back to `kind: 'error'` with `text: 'unparsed_line: ' + JSON.stringify(raw).slice(0,200)` for shapes the normalizer cannot map.

## 6. Auth & environment

**Phase 0 reality (`qwen --help`):** there is **NO login subcommand**.

```
qwen auth          Configure authentication (removed)
```

`qwen auth` is listed in `--help` only as a deprecation stub. Credentials are
configured **out-of-band** by writing `~/.qwen/settings.json` (or exporting
env vars before spawn). Verified in this host:

```json
{
  "env": {
    "QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO_ANTHROPIC_36C86C5DB998": "sk-cp-..."
  },
  "modelProviders": {
    "anthropic": [
      { "id": "MiniMax-M3", "name": "MiniMax-M3", "baseUrl": "https://api.minimax.io/anthropic", "envKey": "..." }
    ]
  },
  "security": { "auth": { "selectedType": "anthropic" } },
  "model": { "name": "MiniMax-M3", "baseUrl": "https://api.minimax.io/anthropic" }
}
```

### Credential resolution priority (highest first)

The 4-source cascade — `qwen-auth.provider.ts` must walk in this order,
returning the first hit, and only emit `'Qwen not configured'` when **all are
empty or missing**:

1. **`~/.qwen/settings.json`** (parsed as JSON5 or via `JSON.parse` for strict
   hosts):
   - `security.auth.selectedType === 'anthropic'` → look up
     `modelProviders.anthropic[0].envKey` and read `env[<that key>]`.
   - `security.auth.selectedType === 'openai'` / `'gemini'` / `'qwen-oauth'` →
     analogous lookup in `modelProviders[<type>][0]`.
   - Each `modelProviders.<type>[]` entry has `{ id, name, baseUrl, envKey }`;
     `envKey` is the env var that holds the credential (the key in
     `settings.json#env` is a hash of the baseUrl, not human-readable).
2. **Environment variables on the CloudCLI process** (verified by Phase 0 probe):
   - `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL` (used by this host)
   - `OPENAI_API_KEY` + `OPENAI_BASE_URL` + `OPENAI_MODEL`
   - `GEMINI_API_KEY` + `GEMINI_MODEL`
   - `BAILIAN_CODING_PLAN_API_KEY` (Qwen Coding Plan, base `coding.dashscope.aliyuncs.com/v1`)
3. **Project-level**: `.qwen/.env`, `.env`, `<project>/.qwen/.env` (per docs
   resolution order — must use a `.env` parser, e.g. `dotenv`).
4. **Global**: `~/.qwen/.env`, `~/.env`.

### Multi-source cascade pattern (mandatory)

Mirror `codex-auth.provider.ts:64-75` (10 cases in `codex-auth.test.ts`). Each
source must be a separate helper (`readSettingsJson()`, `readEnvCredentials()`,
`readProjectDotenv()`, `readGlobalDotenv()`) so the test suite can patch each
in isolation. The negative case "all sources empty" must return
`{ authenticated: false, error: 'Qwen not configured' }`.

### Install detection

```ts
spawn.sync('qwen', ['--version'], { stdio: 'ignore', timeout: 5000 });   // returns true on this host
```

`which qwen` was `/root/.local/bin/qwen` in our probe. No `QWEN_CLI_PATH`
override needed for MVP; users can `ln -s` if their install lives elsewhere.

### Login UI

**There is no `ProviderLoginModal` for qwen.** `getProviderCommand()` in
[`ProviderLoginModal.tsx:15-53`](../../src/components/provider-auth/view/ProviderLoginModal.tsx#L15)
must NOT add a `qwen login` case — `qwen auth` is removed and there's no
fallback verb. Instead, the Settings → Agents → Qwen row shows:

- Status badge: green if at least one source authenticated; red if not.
- **No "Iniciar sesión" button.** The action button is **"Configurar credenciales"**,
  opening a `QwenAuthInstructionsModal` (NEW component, mirrors the structure
  of `ProviderLoginModal` but shows instructions instead of launching a PTY):
  - Tab 1: "Exportar variables de entorno" — copyable blocks per selected
    provider (`anthropic` / `openai` / `gemini`).
  - Tab 2: "Editar `~/.qwen/settings.json`" — shows the current file contents
    (read-only) + a textarea for edits with "Guardar" button. Write is wrapped
    in a backup-to-`settings.json.bak` + atomic rename pattern.
  - Tab 3: "Estado actual" — table with each source × `present`/`missing` and
    the resolved `selectedType` + `model.name`.
- For OAuth-style providers (`qwen-oauth`), tab 1 links to the Aliyun
  console; tab 2 helps the user generate and paste the OAuth token into
  `settings.json#env[...]`.

This keeps the install detection + runtime path orthogonal to the auth UX:
runtime spawn reads `settings.json` or env vars; auth UX just **shows** where
the credentials live and helps the user edit them safely.

### Path safety

All writes to `~/.qwen/settings.json` must go through `utils/safe-write.js`
(atomic write + chmod 600 + `.bak` rotation) — same guarantees we apply for
`~/.codex/auth.json`. See the recipe in [`docs/providers/codex.md`](./codex.md#auth-resolution--3-source-cascade).

## 7. Models

**Catalog strategy: static-only first iteration.** No `qwen models` subcommand
was found in `cli.js` — model listing reads from settings or hardcoded binaries.

```ts
QWEN_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'qwen3-coder-plus',  label: 'Qwen3 Coder Plus',  description: '…' },
    { value: 'qwen3-coder-flash', label: 'Qwen3 Coder Flash', description: '…' },
    { value: 'qwen3-max',         label: 'Qwen3 Max',         description: '…' },
    { value: 'qwen-vl-max',       label: 'Qwen VL Max',       description: '…' },
    { value: 'claude-sonnet-4.5', label: 'Claude Sonnet 4.5 (via Anthropic)', description: '…' },
    { value: 'gpt-5.4',           label: 'GPT-5.4 (via OpenAI)',                description: '…' },
  ],
  DEFAULT: 'qwen3-coder-plus',
};
```

**Cache strategy:** do NOT add qwen to
`UNCACHED_PROVIDERS` ([`provider-models.service.ts:20`](../../server/modules/providers/services/provider-models.service.ts#L20))
in the first iteration — use the on-disk cache like opencode.

If `qwen models` is discovered in Phase 0, mirror
`opencode-models.provider.ts:216-270` (`runOpenCodeModelsCommand`, 20s timeout).

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
    "httpServer": {
      "httpUrl": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer xxx" }
    },
    "sseServer": { "url": "http://localhost:8080/sse" }
  }
}
```

Override `buildServerConfig`:

- `stdio` → `{ command, args, env?, cwd? }` (qwen native format)
- `http` / `sse` → `{ httpUrl | url, headers? }`

Read/write paths:
- **user scope** → `~/.qwen/settings.json`
- **project scope** → `<workspace>/.qwen/settings.json`

UI constants in
[`src/components/mcp/constants.ts`](../../src/components/mcp/constants.ts):
```ts
MCP_PROVIDER_NAMES.qwen          = 'Qwen';
MCP_SUPPORTED_SCOPES.qwen        = ['user', 'project'];
MCP_SUPPORTED_TRANSPORTS.qwen    = ['stdio', 'http', 'sse'];  // qwen supports all 3
MCP_PROVIDER_BUTTON_CLASSES.qwen = 'bg-primary text-primary-foreground hover:bg-primary/90';
MCP_SUPPORTS_WORKING_DIRECTORY.qwen = false;
```

## 9. Skills

`qwen-skills.provider.ts` extends `SkillsProvider`. Two roots (project root
walks up to git root, matching opencode):

| Path | Scope | CommandPrefix |
|---|---|---|
| `~/.qwen/skills/<name>/SKILL.md` | user | `/` |
| `<git-root>/.qwen/skills/<name>/SKILL.md` | project | `/` |

**Frontmatter** (YAML): `name` (required, regex `/^[\p{L}\p{N}_:.-]+$/u`), `description`
(required), `priority` (optional, finite number — sort order in `/skills`
listing).

**Discovery** uses the provider-neutral
`findProviderSkillMarkdownFiles` ([`server/shared/utils.ts:939`](../../server/shared/utils.ts#L939)).

**No cross-compat with `<cwd>/.claude/skills` or `<cwd>/.agents/skills` in the
first iteration.** Qwen's docs only mention `.qwen` paths. Add cross-compat
later if users complain.

## 10. Sessions and sessionSynchronizer

**JSONL** at `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl`.

`qwen-session-synchronizer.provider.ts`:
- Watches `~/.qwen/projects/**/*.jsonl`.
- `synchronize()`: parses each JSONL since last sync, groups by `session_id`.
- `synchronizeFile(path)`: parses one file, returns provider-native session id.

`qwen-sessions.provider.ts`:
- `normalizeMessage(line, sessionId)`: maps event types from [section 5](#5-event-protocol--qwen---output-format-stream-json-shape)
  to the `NormalizedMessage` envelope.
- `fetchHistory(sessionId, { projectPath, providerSessionId })`: reads JSONL,
  returns last N messages.

For the watcher hookup, mirror `sessions-watcher.service.ts:15-42`:
```ts
PROVIDER_WATCH_PATHS.qwen = { rootPath: '~/.qwen/projects' };
```

## 11. Implementation roadmap

12 phases, sequenced to keep each commit self-contained and reviewable.

| Phase | Outcome |
|---|---|
| **0. Discovery** | User installs `npm i -g @qwen-code/qwen-code@0.19.7` in `/opt/node22/bin`. Verify `qwen --version`, `qwen --help`, `qwen mcp --help`, `qwen sessions --help`. Confirm `--output-format stream-json` + `--include-partial-messages` produces the schema in [section 5](#5-event-protocol--qwen---output-format-stream-json-shape). Confirm exact auth subcommand (`qwen login` vs alternative). Confirm whether `qwen models` exists. |
| **1. Type unions** | `server/shared/types.ts:68` and `src/types/app.ts:1` add `'qwen'`. |
| **2. Module backend** | 7 files new under `server/modules/providers/list/qwen/`. Mirror opencode skeleton, point each at qwen-specific paths. |
| **3. Registry + capabilities** | `provider.registry.ts:10-16`, `provider-capabilities.service.ts:32-78` add qwen row. The `ProviderCapabilities` type at `provider-capabilities.service.ts:11` is **exhaustive** — without the qwen row, `tsc` fails. |
| **4. Spawner** | `server/qwen-cli.js` new. NDJSON line buffer, `completeSent`, abort handler, session capture. |
| **5. Wire spawner** | `server/index.js:117-130` adds `spawnFns.qwen` and `abortFns.qwen`. `routes/agent.js:865, 944-999` adds dispatch. |
| **6. Token usage endpoint** | `server/index.js:1279-1605` adds `provider === 'qwen'` branch reading JSONL. |
| **7. Watcher + search** | `sessions-watcher.service.ts:15-42, 79-89` adds qwen root. `session-conversations-search.service.ts:1143-1154` adds `parseQwenSessionMatches`. |
| **8. Commands routes** | `routes/commands.js:18, 20-26` adds qwen. |
| **9. Public API docs** | `public/api-docs.html:831` adds qwen to `PROVIDER_ORDER`. |
| **10. Frontend types + state** | `src/types/app.ts:1`, `provider-auth/types.ts:13-29`, `useChatProviderState.ts`, `useChatComposerState.ts:697-706`, `ProviderSelectionEmptyState.tsx`, `ChatInterface.tsx`, `ChatMessagesPane.tsx`, `MessageComponent.tsx`, `CommandResultModal.tsx`, `useSettingsController.ts`, `AgentsSettingsTab.tsx`, `AgentListItem.tsx`, `AccountContent.tsx`, `PermissionsContent.tsx`, `AgentConnectionsStep.tsx`, `useProviderAuthStatus.ts:109`. **The `useChatProviderState.ts` hook is the biggest frontend churn** — 7 touch points per provider (state, fallback, model storage, `setStoredProviderModel`, `providers[]`, `useEffect`, return shape). |
| **11. Logos + login + MCP + Skills** | `QwenLogo.tsx` new (~600 B SVG), `SessionProviderLogo.tsx`, `ProviderLoginModal.tsx`, `mcp/constants.ts`, `skills/view/ProviderSkills.tsx`. |
| **12. i18n + tests** | Update 22 locale files (`{de,en,es,fr,it,ja,ko,ru,tr,zh-CN,zh-TW}/{chat,settings}.json`). Add 4 colocated tests: `qwen-mcp.test.ts`, `qwen-skills.test.ts`, `qwen-sessions.test.ts`. Bump `mcp.test.ts:344` from `5` to `6`. Add qwen block to `skills.test.ts` at lines 268, 365, 430, 494, 502, 523, 543, 571, 588, 605, 621, 637, 653-669, 707. |

### Files to touch — summary

| Category | Count | Paths |
|---|---|---|
| **Backend type unions** | 2 | `server/shared/types.ts`, `src/types/app.ts` |
| **Backend registry** | 4 | `provider.registry.ts`, `provider-capabilities.service.ts`, `session-synchronizer.service.ts`, `sessions-watcher.service.ts` |
| **Backend switch chains** | 5 | `server/index.js` (2 spots: spawnFns + token-usage), `shell-websocket.service.ts` (2 spots), `routes/commands.js`, `session-conversations-search.service.ts` |
| **Backend agent REST** | 1 | `routes/agent.js` |
| **Backend public API docs** | 1 | `public/api-docs.html` |
| **NEW module files** | 7 | `server/modules/providers/list/qwen/{qwen.provider,qwen-auth,qwen-mcp,qwen-models,qwen-skills,qwen-sessions,qwen-session-synchronizer}.provider.ts` |
| **NEW spawner** | 1 | `server/qwen-cli.js` |
| **Frontend types/state** | 17 | see Phase 10 |
| **Frontend logos/login/MCP/skills** | 5 | see Phase 11 |
| **i18n locales** | 22 | `src/i18n/locales/{11 locales}/{chat,settings}.json` |
| **Tests NEW** | 4 | colocated qwen-*.test.ts |
| **Tests update** | 2 | `mcp.test.ts`, `skills.test.ts` |
| **Total backend** | ~22 new/touched | |
| **Total frontend** | ~44 new/touched | |
| **Total tests** | 6 files | |

## 12. UI integration (qwen-specific deltas)

This section zooms in on qwen **deltas** from the shared UI surface documented
in [`docs/providers/claude.md` → "UI integration"](./claude.md#ui-integration).
Read that first for the shared mechanics (provider-neutral sidebar, capability
matrix dispatch, model storage, login modal mechanics).

### 12.1 Qwen at a glance

| Concern | Value |
|---|---|
| Provider id | `'qwen'` |
| Binary | `qwen` (npm `@qwen-code/qwen-code`) |
| Engines | `node >=22.0.0` (CloudCLI pins `>=22 <23` — ✓) |
| Default model | `qwen3-coder-plus` |
| Auth command (TBD Phase 0) | `qwen login` (verify) |
| Permission modes | CLI: `plan`, `default`, `auto-edit`, `auto`, `yolo`. **UI first iteration:** `['default', 'bypassPermissions']` (extend later) |
| MCP scopes | `user`, `project` (no `local`) |
| MCP transports | `stdio`, `http`, `sse` |
| Skill roots | `~/.qwen/skills/`, `<git-root>/.qwen/skills/` |
| Skill command prefix | `/` |
| Skill file format | `SKILL.md` with YAML frontmatter (`name`, `description`) |
| Session storage | JSONL at `~/.qwen/projects/<sanitized-cwd>/chats/` |
| Resume (per-id) | `qwen --resume <id>` |
| Resume (last) | `qwen --continue` (analogous to `claude -c`) |
| Sidebar dot color | `bg-red-500` (Aliyun/Qwen brand) |
| Brand color (Tailwind) | `red` |
| Capability subagent | ✓ |
| Capability images | ✓ (Qwen VL models + Computer Use) |
| Capability computer-use | ✓ (flags exist) |
| Capability sandbox | ✓ (`--sandbox`) |
| Capability rawReasoning | ✓ (`thinking` events) |
| Capability sessionContinuable | ✓ (`--continue`) |
| Capability sessionForkable | ✓ (`qwen fork --last`) |

### 12.2 Sub-sections

#### Header tabs

Qwen appears in both Chat tab and Shell tab. The header tabs are dispatching
by provider identity in `MainContentTabSwitcher` (provider-neutral); adding
qwen to the chat composer state makes the Chat tab work without any switch
change.

#### Chat tab

`useChatProviderState.ts` (the heaviest frontend file):

- `FALLBACK_DEFAULT_MODEL` (line 12-17) → add `qwen: 'qwen3-coder-plus'`.
- `FALLBACK_PERMISSION_MODES` (line 26-32) → add
  `qwen: ['default', 'bypassPermissions']` (first iteration).
- `useState` pair (line 81-95) → new `qwenModel` / `setQwenModel`.
- `setStoredProviderModel` (line 119-149) → extend with
  `if (targetProvider === 'qwen') { ... }`.
- `providers: LLMProvider[]` (line 149) → add `'qwen'`.
- `useEffect` reconciliation (line 262-325) → mirror the opencode branch.
- Return shape (line 425-448) → add `qwenModel`, `setQwenModel`.

`useChatComposerState.ts:697-706` → add `'qwen-settings'` localStorage key
branch (analogue to `claude-settings` and `cursor-settings`).

`ProviderSelectionEmptyState.tsx`:
- `PROVIDER_META` (line 26-32) → add `{ id: 'qwen', name: 'Qwen' }`.
- `getCurrentModel` / `getProviderDisplayName` (line 75-96) → add qwen branch.
- New props `qwenModel`, `setQwenModel` (line 47-52, 110-113).
- `setModelForProvider` (line 153-172) → add qwen branch.
- `readyPrompt` lookup (line 303-323) → add
  `qwen: t('providerSelection.readyPrompt.qwen', { model: qwenModel })`.

`ChatInterface.tsx` (line 67-75, 197-201, 286-294, 325-333, 430-438) →
destructure `qwenModel`/`setQwenModel`, add chained ternaries for
`messageTypes.qwen`.

`ChatMessagesPane.tsx` (line 33-91, 181-190) → pass-through.

`MessageComponent.tsx:150-158` → provider label ternary.

`CommandResultModal.tsx:60-66` → `PROVIDER_LABELS.qwen = 'Qwen'`.

#### Shell / CLI tab

`shell-websocket.service.ts:132-171` (`buildShellCommand`) → add:
```ts
if (provider === 'qwen') {
  if (resumeSessionId) return `qwen --resume "${resumeSessionId}" || qwen`;
  return 'qwen';
}
```
Plus chained `providerName` ternary at line 474-484 (`provider === 'qwen' ? 'Qwen' : …`).

#### Sidebar left sessions list

Provider-neutral. `SidebarSessionItem` automatically renders
`<SessionProviderLogo provider="qwen" />` once the icon file exists.

#### Auth-status surface

- `provider-auth/types.ts:13-29`:
  ```ts
  CLI_PROVIDERS = [..., 'qwen'];
  PROVIDER_AUTH_STATUS_ENDPOINTS.qwen = '/api/providers/qwen/auth/status';
  createInitialProviderAuthStatusMap = { ... new Map entry for qwen };
  ```
- `useProviderAuthStatus.ts:109` reads from the map — no direct change.
- Server: new `/api/providers/qwen/auth/status` route serving
  `QwenProviderAuth.getStatus()`.

#### Skills panel

`src/components/skills/view/ProviderSkills.tsx:59-72`:
```ts
PROVIDER_NAMES.qwen = 'Qwen';
PROVIDER_SKILL_PATHS.qwen = '~/.qwen/skills/<skill-name>/SKILL.md';
providerPath rule at L223 handles qwen (not opencode which is excluded).
```

#### MCP panel

`src/components/mcp/constants.ts` — see [section 8](#8-mcp) for the five constants.

#### Permissions

- First iteration: `FALLBACK_PERMISSION_MODES.qwen = ['default', 'bypassPermissions']`.
- `useChatComposerState.ts` — no codex-style `plan → default` downgrade.
  Mirrors opencode's minimal permission handling.
- No dedicated `QwenPermissions` React component in the first iteration
  (`PermissionsContent.tsx` already covers `ClaudePermissions`,
  `CursorPermissions`, `CodexPermissions`, `GeminiPermissions`).
  Add later when users need per-mode UI for plan/auto-edit/yolo.

#### Icon + provider identity

`src/components/llm-logo-provider/QwenLogo.tsx` (NEW, ~600 B SVG, red-on-white
mark matching Aliyun brand).

Update `SessionProviderLogo.tsx:1-34`:
```ts
import { QwenLogo } from './QwenLogo';
// chained:
if (provider === 'qwen') return <QwenLogo />;
```

#### Login flow

`ProviderLoginModal.tsx:15-53`:
- `getProviderCommand(provider)` → add `if (provider === 'qwen') return 'qwen login';`
- `getProviderTitle(provider)` → add `'Qwen Code CLI Login'`.

The shell PTY already handles interactive login via
`StandaloneShell` (provider-neutral).

#### Onboarding

`AgentConnectionsStep.tsx:12-40` →
- `providerCardStyles.qwen = { connectedClassName, iconContainerClassName, loginButtonClassName }` (red palette).
- `providerKeys` array → append `'qwen'`.

#### Settings → Agents

- `AgentListItem.tsx:18-57` →
  ```ts
  agentConfig.qwen = { name: 'Qwen', color: 'red' };
  colorClasses.red = { dot: 'bg-red-500' };
  ```
- `AgentsSettingsTab.tsx:23-101` →
  - `selectedAgent` default stays `'claude'` (provider-neutral).
  - `visibleCategories` for qwen: `['account', 'permissions', 'mcp']` only
    (no Skills tab in first iteration — see [section 13](#13-what-is-not-in-scope)).
    Wait — re-evaluating: opencode DOES show skills now (the previous turn
    confirmed). qwen's skills provider is also fully implemented in our plan
    (see [section 9](#9-skills)), so include `skills`.
    **Final: `['account', 'permissions', 'mcp', 'skills']`.**
  - `visibleAgents` → add `'qwen'`.
  - `agentContextById.qwen` placeholder.
- `AccountContent.tsx:23-66` → add qwen row in `agentConfig` record.
- `PermissionsContent.tsx:264, 474-702` → no dedicated component for qwen in
  first iteration; falls through to default UI.
- `useSettingsController.ts:152-412` → add `qwenPermissions`/`onQwenPermissionsChange`
  state pair only if needed (deferred — default UI covers it).

### 12.3 i18n keys to add

en + es (mirrors in 9 other locales — de, fr, it, ja, ko, ru, tr, zh-CN, zh-TW):

- `settings.onboarding.agents.providerTitles.qwen` → "Qwen Code"
- `settings.onboarding.agents.status.{authenticated,unauthenticated,checking}.qwen`
- `chat.providerSelection.readyPrompt.qwen` → "¿Qué puedo hacer por ti con {{model}}?"
- `chat.messageTypes.qwen` → "Qwen" (display name)

`s` is the default locale; mirrors must be exact.

## 13. Open questions (RESOLVED by Phase 0)

All original 5 questions resolved against `qwen --version 0.19.7` on this host.
The matrix below is the new baseline.

| # | Question | Phase-0 answer | Section |
|---|---|---|---|
| 1 | Auth subcommand | **`qwen auth (removed)`** — no login verb. Auth = edit `~/.qwen/settings.json` or export env vars. | § 6 |
| 2 | `qwen models` subcommand | **No** dynamic listing subcommand. Catalog = static `QWEN_FALLBACK_MODELS` + `settings.json#model.name`. | § 7 |
| 3 | Event JSON shape | NDJSON with `system.init`, `assistant.{thinking,text,tool_use}`, `user.{tool_result}`, `result.{success,error}` + `stats` + `permission_denials`. Field names: `session_id` (snake_case in stream-json events), `message.content[]` array, `tool_use.input`/`tool_use.name`/`tool_use.id`. | § 5 |
| 4 | Permission modes UI | Qwen CLI has 5 modes (probable: `plan`, `default`, `auto-edit`, `auto`, `yolo` — none documented in `--help`; need a Phase-0.5 probe). MVP first iteration: `['default', 'bypassPermissions']` mirror opencode. Auto-discover the real names via `qwen --help` long-form. | § 12.1 |
| 5 | Brand color | Tailwind `red` (Aliyun/Qwen red-orange). Confirm with design before merge. | § 12 |

**New questions surfaced by Phase 0 (gated "nice-to-know", not blocking):**

6. **`qwen serve --http-bridge`** — Stage 1 experimental daemon for real
   interactivity (`ask_user_question`, `exit_plan_mode`). Skip in MVP; revisit
   when stabilized.
7. **`qwen channels` / `qwen extensions` / `qwen hooks`** — out of scope (see
   § 14).
8. **`qwen --safe-mode`** — useful troubleshooting flag. Surface a toggle in
   advanced settings later.

## 14. What is NOT in scope

- ❌ `qwen serve` HTTP daemon integration (multi-client shared agent).
- ❌ `qwen channel` IM integration (Telegram, Discord, DingTalk, WeChat, Feishu).
- ❌ `qwen extensions` / `--install-extension` (plugin ecosystem).
- ❌ Computer Use UI panel (capability flag exists but no panel).
- ❌ Agent Arena UI (multi-model head-to-head).
- ❌ Refactor of `spawnFns`/`abortFns` into `provider.registry.ts` (architectural gap, follow-up).
- ❌ `routes/git.js` commit-message generation extension (deferred until qwen's CLI gains that feature). **Clarification:** the universal helper `ensureConventionalCommitPrefix()` in [`server/routes/git.js`](../../server/routes/git.js) already auto-prefixes any free-form commit message with `chore:` so commitlint accepts it. This applies to **all** commits made through CloudCLI's git panel, regardless of which provider is active. No qwen-specific work is required.
- ❌ Cross-compat with `<cwd>/.claude/skills` and `<cwd>/.agents/skills` (qwen docs only mention `.qwen`).

## 15. Verification

After all 12 phases:

```bash
# Static checks
npm run lint
npm run typecheck                          # exhaustive ProviderCapabilities forces build success
npm run build:server && npm run build:client

# Backend tests
npx tsx --test server/modules/providers/tests/qwen-*.test.ts
npx tsx --test server/modules/providers/tests/skills.test.ts
npx tsx --test server/modules/providers/tests/mcp.test.ts

# Runtime smoke test (with qwen-code installed)
qwen --version          # exits 0
npm run dev             # or pm2 restart cloud-cli2026

# Manual UI verification:
# - Settings → Agents → row "Qwen" appears with red dot
# - Login → modal launches `qwen login` in PTY
# - Chat composer shows Qwen model selector
# - Run a prompt → NDJSON lines normalize to messages
# - Settings → MCP Servers (qwen selected) → add/remove stdio server
# - Settings → Skills → list ~/.qwen/skills/* paths
```

End-to-end timing target: phase 0 takes 30 min; phases 1-9 (backend) ~2-3 days;
phases 10-12 (frontend + i18n + tests) ~2-3 days. Total ~1 week.

## 16. Sources

- [github.com/QwenLM/qwen-code](https://github.com/QwenLM/qwen-code) — README +
  capability comparison table (Claude Code parity)
- [qwenlm.github.io/qwen-code-docs/en/users/configuration/auth](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/auth) — auth env vars and `/auth` slash command
- [qwenlm.github.io/qwen-code-docs/en/users/features/mcp](https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp) — `mcpServers` schema, `qwen mcp add|remove|list|reconnect|approve|reject`
- [qwenlm.github.io/qwen-code-docs/en/users/features/headless](https://qwenlm.github.io/qwen-code-docs/en/users/features/headless) — `--output-format stream-json`, `--continue`/`--resume`
- [qwenlm.github.io/qwen-code-docs/en/users/features/skills](https://qwenlm.github.io/qwen-code-docs/en/users/features/skills) — `SKILL.md` format
- [qwenlm.github.io/qwen-code-docs/en/users/configuration/settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings) — settings.json schema
- npm: `@qwen-code/qwen-code@0.19.7` (tarball inspection via `npm pack`)

## 17. See also

- [`docs/providers/claude.md`](./claude.md) — the canonical UI integration
  reference (5 of the 12 sub-sections are shared chrome across all providers).
- [`docs/providers/opencode.md`](./opencode.md) — the closest backend
  precedent (CLI subprocess + NDJSON + slash-style skills).
- [`docs/providers/gemini.md`](./gemini.md) — precedent for JSONL session
  storage + stream-json output (qwen follows gemini's pattern for sessions).
- [`docs/providers/codex.md`](./codex.md) — precedent for "resume last
  session" via `--continue` flag (qwen equivalent is `qwen --continue`). Also
  precedent for the **3-source auth cascade** pattern (auth.json / config.toml /
  env vars) — qwen follows the same shape with settings.json / env vars.
- [`docs/providers/agente.md`](./agente.md) — cross-provider comparison matrix
  + auth resolution table (qwen row is marked DRAFT). When implementation starts,
  the qwen row of both matrices must be filled in **in the same commit**.
- [`docs/voice.md`](../voice.md) — orthogonal voice feature (STT/TTS). No
  qwen-specific work required; voice is provider-agnostic and proxies to any
  OpenAI-compatible audio backend.
- `server/modules/providers/README.md` — facet contract, registration, types.

## 18. Interactive prompts UI (planned)

**Phase 0 confirmation:** qwen registers `ask_user_question` and
`exit_plan_mode` in `system.init.tools[]`, but **the CLI refuses to invoke them
when run non-interactively**:

```
The `ask_user_question` tool is unavailable in the current non-interactive mode.
```

This is the same first-iteration restriction as Codex (see
[`docs/providers/codex.md`](./codex.md)): a real interactive UI requires a
daemon mode. For qwen, the daemon is `qwen serve --http-bridge` (Stage 1
experimental). **Out of MVP scope.**

### First-iteration parity with Codex

In the first iteration, qwen mirrors the **Codex pattern** — capability off,
CLI handles permission decisions internally via spawn flags. Concretely:

- `supportsPermissionRequests: false` in `provider-capabilities.service.ts`.
- Chat composer shows `<QwenPermissions />` (a thin copy of `<CodexPermissions />`)
  with the same three modes (`default` / `acceptEdits` / `bypassPermissions`).
- **No** real-time interactive prompts in MVP: `ask_user_question` and
  `exit_plan_mode` tool_use events surface as raw JSON in a `Default`
  collapsible card (same fallback as OpenCode's `question` tool gap documented
  in [`docs/providers/opencode.md`](./opencode.md)).
- No `<PermissionRequestsBanner />` ever appears for qwen sessions in MVP.

### Roadmap to close the gap (future work)

If qwen-code later exposes a `canUseTool`-style mid-stream callback (e.g. via
`qwen serve --http-bridge` stabilizing), the permission flow can be enabled
the same way Claude's is:

1. Add a `qwen-canUseTool`-style hook in `qwen-session-synchronizer.provider.ts`
   that consumes `permission_request` events and produces
   `permission_cancelled` / `permission_allowed` events.
2. Register `QwenAskUserQuestionPanel` and `QwenPlanDisplay` in
   `PermissionRequestsBanner.tsx` (parallel to `AskUserQuestionPanel`).
3. Set `supportsPermissionRequests: true` in the `QwenProvider` capability
   descriptor.
4. Add column rows to the comparative table in `agente.md`.

Out of MVP; tracked as a follow-up after `qwen serve` exits Stage 1.

## 19. Capabilities & UI support (Qwen row — POST PHASE 0)

**Phase 0 closed all DRAFT markers below.** This row is what `docs/providers/agente.md`
must mirror when the qwen provider is enabled.

| Property | Qwen value | Source |
|---|---|---|
| Login command | **None** (`qwen auth (removed)`) — auth = edit `~/.qwen/settings.json` or env vars | § 6 |
| Auth cascade | **4 sources**: `settings.json → process.env → project dotenv → global dotenv` | § 6 |
| Permission modes (MVP) | `['default', 'acceptEdits', 'bypassPermissions']` (mirror Codex; qwen CLI real modes `plan`, `default`, `auto-edit`, `auto`, `yolo` deferred) | § 12.1, § 18 |
| MCP scopes | `['user', 'project']` | § 8 |
| MCP transports | `['stdio', 'http', 'sse']` | § 8 |
| `supportsPermissionRequests` | `false` (mirrors Codex first iteration) | § 18 |
| Interactive UI | **No** (raw JSON fallback; `qwen serve --http-bridge` is Stage 1) | § 18 |
| `tool_use` renderer | **Rich** (same renderers as Claude — qwen forked Claude's tool surface: `read_file`, `grep_search`, `web_fetch`, etc.) | § 5 |
| Custom providers | **Yes** — multi-model via `settings.json#modelProviders.<type>[]` with custom `baseUrl` (verified: this host uses `anthropic → api.minimax.io`) | § 6 |
| Model catalog | **Static** — `QWEN_FALLBACK_MODELS` (no `qwen models` subcommand in 0.19.7) | § 7 |
| Streaming | **Per-frame** (NDJSON `assistant` events contain full `content[]` of that turn — no token-level deltas) | § 5 |
| `stats` telemetry | **Yes** — `result.stats.{models,tools,files,skills}` free telemetry; maps to `usage` block | § 5 |
| Session store | Filesystem JSONL at `~/.qwen/projects/<encoded-cwd>/chats/<session-id>.jsonl` (mirror Claude) | § 10 |
| Resume flag | `-c/--continue` (boolean, latest) and `-r/--resume <id>` (string) | § 4 |
| Sandbox | `-s, --sandbox [boolean]` (qwen's own, not Claude's) | § 4 |
| `chat-recording` | `--chat-recording [boolean]` — false → `-c/-r` won't work | § 4 |
| Brand color | Tailwind `red` (Aliyun red-orange) — confirm with design before merge | § 12 |
| `tool_use` renderer | (planned) Rich (same renderers as Claude/Codex) | `toolConfigs.ts` |
| Custom providers | (planned) Yes — multi-model like OpenCode | TBD |
| Status | **DRAFT — plan only** | `docs/providers/agente.md` |

See [`docs/providers/agente.md`](./agente.md) for the full cross-provider
comparison table and the auth resolution matrix.

When implementation starts, the qwen row of the comparative table in
[`docs/providers/agente.md`](./agente.md) must be updated **in the same commit**:
- Capabilities matrix (login / permission modes / supportsPermissionRequests / interactive UI / tool_use renderer / custom providers / status).
- Auth resolution matrix (primary source / fallbacks / custom providers).

This is what the `Adding a new provider doc` section of `agente.md` mandates.
