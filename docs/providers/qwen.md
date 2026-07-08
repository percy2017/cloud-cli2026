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
- Args assembled before spawn (analogue of `opencode-cli.js:195-219`):
  ```js
  const args = ['--output-format', 'stream-json', '--include-partial-messages'];
  if (sessionId) args.push('--resume', sessionId);
  else if (continueLast) args.push('--continue');
  if (resolvedModel) args.push('--model', resolvedModel);
  if (approvalMode) args.push('--approval-mode', approvalMode);
  if (sandboxMode) args.push('--sandbox');
  args.push(command?.trim() ?? '');   // empty for sessions without a fresh prompt
  ```
- `qwenProcess = spawnFunction('qwen', args, { cwd, stdio: 'pipe', env: ...process.env });`
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

Emit schema per docs (`qwen -p "..." --output-format stream-json
--include-partial-messages`). Event types confirmed by the binario (`cli.js`)
and `chunks/agent-headless-VLX4C7KX.js`:

| Event type | Meaning | → NormalizedMessage kind |
|---|---|---|
| `system` (subtypes `session_start`, `compact_boundary`, …) | session lifecycle | `status` / `session_created` |
| `assistant` (with `message.content[]` or `delta`) | model output | `stream_delta` / `text` |
| `user` | echoed user message | (echo — skip or pass-through) |
| `tool_use` | tool invocation | `tool_use` |
| `tool_result` | tool result | `tool_result` |
| `thinking` | reasoning | `thinking` |
| `result` (subtypes `success`/`error`, `duration_ms`, `usage`) | run-end | `stream_end` |
| `error` | error | `error` |
| `permission_request` | approval UI | `permission_request` |
| `permission_cancelled` | denied | `permission_cancelled` |

The exact field names (`session_id` vs `sessionId`, `message.content[]` vs
`message.content`) are **Phase-0 discovery** items (verify by running the
binary with `--include-partial-messages`). First PR normalization should map
the most common types and emit `kind: 'error'` with `text: 'unparsed_line' +
raw` as a fallback for unexpected shapes, mirror
[`opencode-sessions.provider.ts:222-319`](../../server/modules/providers/list/opencode/opencode-sessions.provider.ts#L222)'s
defensive shape.

## 6. Auth & environment

**Credential resolution priority** (highest first):

1. `~/.qwen/settings.json#security.auth.apiKey` (or whatever Phase-0 confirms).
2. Environment variables (per docs):
   - `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`, `OPENAI_MODEL`)
   - `ANTHROPIC_API_KEY` (+ `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`)
   - `GEMINI_API_KEY` (+ `GEMINI_MODEL`)
   - `BAILIAN_CODING_PLAN_API_KEY` (Qwen Coding Plan, base URL `coding.dashscope.aliyuncs.com/v1`)
3. `.qwen/.env` → `.env` → `~/.qwen/.env` → `~/.env` (per docs resolution order).

**Install detection** (mirror `opencode-auth.provider.ts:31-38`):
```ts
spawn.sync('qwen', ['--version'], { stdio: 'ignore', timeout: 5000 });
```

**Login UI** — add to `getProviderCommand` in
[`ProviderLoginModal.tsx:15-53`](../../src/components/provider-auth/view/ProviderLoginModal.tsx#L15):
```ts
if (provider === 'qwen') return 'qwen login';  // verify exact subcommand in Phase 0
```
Title: `"Qwen Code CLI Login"`.

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

## 13. Open questions (gate before implementation)

1. **Auth subcommand** — is it `qwen login` or `qwen auth <type>` or
   `qwen --auth`? Verify in Phase 0 via `qwen --help` and `qwen auth --help`.
2. **`qwen models` subcommand** — does the CLI expose a dynamic model
   listing, or is the model list static / read from `settings.json`?
   Verify in Phase 0.
3. **Event JSON shape** — exact field names for `session_id`,
   `message.content[]`, `tool_use.input`, `tool_result.output`. Verify
   in Phase 0 by running
   `qwen -p "test" --output-format stream-json --include-partial-messages`.
4. **Permission modes UI** — first iteration: `['default', 'bypassPermissions']`
   (mirrors opencode). Extend later when we know how users will use
   the 5-mode CLI (`plan`, `default`, `auto-edit`, `auto`, `yolo`).
5. **Brand color** — `red` Tailwind palette (Aliyun/Qwen brand red-orange).
   Confirm with design before merge.

## 14. What is NOT in scope

- ❌ `qwen serve` HTTP daemon integration (multi-client shared agent).
- ❌ `qwen channel` IM integration (Telegram, Discord, DingTalk, WeChat, Feishu).
- ❌ `qwen extensions` / `--install-extension` (plugin ecosystem).
- ❌ Computer Use UI panel (capability flag exists but no panel).
- ❌ Agent Arena UI (multi-model head-to-head).
- ❌ Refactor of `spawnFns`/`abortFns` into `provider.registry.ts` (architectural gap, follow-up).
- ❌ `routes/git.js` commit-message generation extension (deferred until qwen's CLI gains that feature).
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
  session" via `--continue` flag (qwen equivalent is `qwen --continue`).
- [`server/modules/providers/README.md`](../../server/modules/providers/README.md) —
  facet contract, registration, types.
