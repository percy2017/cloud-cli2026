# Claude Code provider

This document explains how CloudCLI integrates [Anthropic's Claude Code][anthropic-claude-code]
as one of its AI coding agents. Claude Code is the **default provider** in CloudCLI and the
only one that uses an **in-process SDK** — every other provider (opencode, codex, cursor,
gemini) shells out to a CLI subprocess. That architectural choice cascades into a lot of
provider-specific features that exist only for Claude: the interactive permission flow,
the plugin skills subsystem, OAuth credentials, and the slash-command parser.

For the canonical guide on **adding a new provider** (facet contract, registration,
types), see `server/modules/providers/README.md`. This doc assumes you already know the
facet model and zooms in on how Claude implements each one.

[anthropic-claude-code]: https://www.anthropic.com/claude-code

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
                 │  → spawnFn['claude']       │
                 │  → queryClaudeSDK()        │
                 └──────────────┬─────────────┘
                                │
                                ▼
              ┌─────────────────────────────────────┐
              │  Claude Agent SDK (in-process)      │
              │  @anthropic-ai/claude-agent-sdk     │
              │                                     │
              │  query({ prompt, options })         │
              │  → AsyncIterable<SDKMessage>        │
              └──────────────┬──────────────────────┘
                             │
                             ▼
        ┌────────────────────────────────────────────────┐
        │ transformMessage + ClaudeSessionsProvider      │
        │ .normalizeMessage                               │
        │                                                │
        │ stream_delta / thinking / tool_use /           │
        │ tool_result / text / status(tokenBudget) /     │
        │ session_created                                │
        └──────────────┬─────────────────────────────────┘
                       │ NormalizedMessage
                       ▼
        ┌────────────────────────────────────────────────┐
        │ canUseTool() per tool call                     │
        │   ├─ match allowedTools → allow                 │
        │   ├─ match disallowedTools → deny               │
        │   └─ interactive AskUserQuestion / ExitPlanMode │
        │      → WebSocket permission_request → user UI   │
        └──────────────┬─────────────────────────────────┘
                       │ permission_response (allow/deny)
                       ▼
                ┌────────────────────────────┐
                │  Frontend (React)          │
                │  renders stream in UI      │
                └────────────────────────────┘
```

## Backend layout

Everything that "is" Claude-from-CloudCLI's-point-of-view lives under
[`server/modules/providers/list/claude/`][claude-dir]:

| File | Role |
|---|---|
| `claude.provider.ts` | Registry entry. Declares the 6 standard facets (no extras). |
| `claude-auth.provider.ts` | Auth facet. Detects CLI installation + resolves credentials (env vars → `~/.claude/settings.json` → OAuth credentials file). |
| `claude-models.provider.ts` | Models facet. Returns the fallback catalog and reads the active model per-session from the JSONL. |
| `claude-mcp.provider.ts` | MCP facet. Reads/writes the project's `.mcp.json` and merges user/project/local scopes from `~/.claude.json`. |
| `claude-skills.provider.ts` | Skills facet. Reads `~/.claude/skills/`, `<project>/.claude/skills/`, **plus enabled plugins'** commands and skills. Largest skills implementation of any provider. |
| `claude-sessions.provider.ts` | Sessions facet. Reads JSONL transcripts, normalizes SDK events to `NormalizedMessage[]`. Handles compact summaries, slash commands, local-command stdout, subagent tools, and extended thinking. |
| `claude-session-synchronizer.provider.ts` | File watcher that scans `~/.claude/projects/` and indexes sessions in the DB. Skips `subagents/` subdirectories to avoid session-id collisions. |

[claude-dir]: ../../server/modules/providers/list/claude/

## Runtime SDK: `server/claude-sdk.js`

This is **not** the files in the provider folder. `server/claude-sdk.js` is the in-process
SDK driver that the gateway calls. It exposes `queryClaudeSDK(...)` and `abortClaudeSDKSession(...)`.

### In-process vs subprocess

| | Claude | OpenCode | Others |
|---|---|---|---|
| Process model | in-process SDK | subprocess | subprocess |
| Stream source | `AsyncIterable<SDKMessage>` | JSONL over stdio | various |
| API | `query({ prompt, options })` | `spawn(opencode run --format json ...)` | `spawn(provider-cli ...)` |

Claude imports `query` directly from `@anthropic-ai/claude-agent-sdk` (installed as a normal
npm dependency). The SDK returns an `AsyncIterable<SDKMessage>` that the driver for-await
loops over, normalizing each message to the unified `NormalizedMessage` shape.

### Key options wired by `queryClaudeSDK`

- **`permissionMode`** → mapped to SDK's `bypassPermissions` (when `skipPermissions` is true) or `plan`.
- **`allowedTools`** → defaults for plan mode (`Read`, `Task`, `exit_plan_mode`, `TodoRead`, `TodoWrite`, `WebFetch`, `WebSearch`), extended with anything the user granted via the in-app approval prompt.
- **`tools: { type: 'preset', preset: 'claude_code' }`** — exposes the full built-in toolset (including `AskUserQuestion`).
- **`systemPrompt: { type: 'preset', preset: 'claude_code' }`** — required so the SDK honors the project's `CLAUDE.md`.
- **`settingSources: ['project', 'user', 'local']`** — auto-loads `CLAUDE.md` from the three conventional locations.
- **`sessionId` → `resume: sessionId`** — when resuming a previous session.
- **`pathToClaudeCodeExecutable`** → resolved from `CLAUDE_CLI_PATH` (see Env vars).
- **`env: { ...process.env }`** — forwards all env vars verbatim.
- **`canUseTool(toolName, input, context)`** — central permission interceptor (see Permissions).

### Stream-close timeout

The SDK defaults to 5 s for closing streams — too short for real usage. `queryClaudeSDK`
saves and restores `process.env.CLAUDE_CODE_STREAM_CLOSE_TIMEOUT = '300000'` (5 min) around
the `query()` call, because the SDK reads it synchronously at construction time.

### Message shapes

The SDK emits SDKMessage variants that `ClaudeSessionsProvider.normalizeMessage`
(`server/modules/providers/list/claude/claude-sessions.provider.ts`) maps into
`NormalizedMessage` kind values:

| SDKMessage | NormalizedMessage kind |
|---|---|
| `content_block_delta` (text) | `stream_delta` |
| `content_block_stop` | `stream_end` |
| `message.role: 'user'` (text content) | `text` (system-reminder filtered out) |
| `message.role: 'user'` (compact summary) | `text` with `isCompactSummary: true` |
| `message.role: 'user'` (local command) | `text` with `isLocalCommand`, `commandName`, etc. |
| `message.role: 'user'` (local-command-stdout) | `text` re-labeled as assistant with `isLocalCommandStdout` |
| `message.role: 'assistant'` (text) | `text` |
| `type: 'thinking'` | `thinking` |
| `type: 'tool_use'` | `tool_use` |
| `type: 'tool_result'` | `tool_result` with optional `subagentTools` |

In addition, `queryClaudeSDK` itself emits some frames outside of `normalizeMessage`:

- `session_created` — exactly once, the first time the SDK reports a `session_id`.
- `status` with `text: 'token_budget'` — every time `message.usage` arrives.

### Abort

`abortClaudeSDKSession(sessionId)` (`server/claude-sdk.js:806`):

1. Adds `sessionId` to `abortedSessionIds` Set **before** interrupting, so the run loop doesn't emit a duplicate `complete`.
2. Calls `await session.instance.interrupt()` (SDK method).
3. Cleans up temp images and removes the session from the internal map.
4. If `interrupt()` throws, removes the flag so the run loop emits its own `complete`.

The WebSocket `chat.abort` message (`server/modules/websocket/services/chat-websocket.service.ts:199`)
dispatches to `abortFns[run.provider]` which is `abortClaudeSDKSession` for the claude provider.

### The `ede_diagnostic` warning

The Anthropic SDK throws errors with message `ede_diagnostic result_type=user last_content_type=n/a stop_reason=tool_use`
when a session ends with `stop_reason: 'tool_use'` (a continuation, not a failure — the next
user message will resume it). The catch block in `queryClaudeSDK` detects `/ede_diagnostic/`
in the message and demotes `console.error` to `console.warn`. Without this demotion the
logs would flood with false errors on every normal continuation.

This is **noise, not a real failure**.

## Permissions and tools

### `canUseTool` — the central interceptor

Every tool call Claude Code wants to make goes through this callback (configured in the SDK
options). The decision flow:

1. If `permissionMode === 'bypassPermissions'` and the tool is **not** interactive (`AskUserQuestion` or `ExitPlanMode`) → return `{ behavior: 'allow' }` without prompting.
2. If the tool matches a `disallowedTools` entry → return `{ behavior: 'deny' }`.
3. If the tool matches an `allowedTools` entry → return `{ behavior: 'allow' }`.
4. Otherwise → ask the user.

### The interactive approval flow

1. The SDK calls `canUseTool(toolName, input, context)` with a tool that needs a decision.
2. We generate a `requestId` (UUID), emit a `permission_request` frame over WebSocket, and emit a `notification_event` with `kind: 'action_required'`, `code: 'permission.required'`, `requiresUserAction: true`.
3. The driver awaits `waitForToolApproval(requestId, { timeoutMs, signal, … })`:
   - Interactive tools (`AskUserQuestion`, `ExitPlanMode`) → `timeoutMs: 0` (waits indefinitely).
   - Default → `TOOL_APPROVAL_TIMEOUT_MS = parseInt(process.env.CLAUDE_TOOL_APPROVAL_TIMEOUT_MS, 10) || 55000` (55 s).
4. The frontend shows the approval UI and sends `chat.permission-response { requestId, allow, updatedInput?, message?, rememberEntry? }`.
5. `handlePermissionResponse` (`server/modules/websocket/services/chat-websocket.service.ts:306`) calls `resolveToolApproval(requestId, decision)`, which resolves the promise in `waitForToolApproval`.
6. The driver returns `{ behavior: 'allow' | 'deny', updatedInput?, message? }` to the SDK.
7. If `rememberEntry` was set, the allow list is mutated in-place so subsequent calls of the same tool run without prompting.

### Reconnect mid-stream: `getPendingApprovalsForSession(sessionId)`

When a client reconnects via `chat.subscribe { sessions: [{ sessionId, lastSeq }] }`,
the gateway calls `getPendingApprovalsForSession(sessionId)` to replay any in-flight
permission requests so the new client can show them immediately instead of waiting for
the 55 s timeout.

### Known limitation

In `auto` and `bypassPermissions` modes, the SDK resolves the permission inside its own
permission-mode step **before** calling `canUseTool`. As a result, interactive tools
(`AskUserQuestion`, `ExitPlanMode`) do not reach the UI in those modes — the classifier
auto-approves. The class comment notes that the workaround is to move those tools to a
`PreToolUse` hook instead.

## Skills, agents, subagents

### Skill sources

`ClaudeSkillsProvider.getSkillSources(workspacePath)` exposes two scopes:

- `user`: `~/.claude/skills/` (prefix `/`)
- `project`: `<workspace>/.claude/skills/` (prefix `/`)

### Plugin skills (unique to Claude among current providers)

`listPluginSkills` reads `~/.claude/settings.json` → `enabledPlugins` (a `Record<pluginId, boolean>`),
cross-references it with `~/.claude/plugins/installed_plugins.json` → `plugins[pluginId]` →
array of installs (each with an `installPath`), and enumerates each install's payloads:

- If `commands/<name>.md` exists in the install folder → each file becomes a slash command: `/${pluginName}:${name}` with `description` from YAML frontmatter.
- Otherwise, if `skills/<name>/SKILL.md` exists (recursive glob) → each becomes a skill.

Symlinks to directories are followed explicitly (because `Dirent#isDirectory()` reports the
type of the link itself, not the target). Plugin name comes from `<installPath>/.claude-plugin/plugin.json`
or is derived by splitting the `pluginId` on `@`.

### Slash commands

`<command-name>/<command-message>/<command-args>` tags in the JSONL transcript are parsed
by `parseLocalCommandPayload` and re-exposed to the UI as user messages with
`isLocalCommand: true`, `commandName`, `commandMessage`, `commandArgs`. Without this
re-exposure, slash commands would vanish from the session history.

### Subagent tools

`parseAgentTools` reads `<sessionId>/subagents/agent-<id>.jsonl` files (relative to the
session JSONL) and attaches them as `subagentTools` on the parent tool_result. This makes
subagent activity visible in the parent session's transcript.

## Sessions and sessionSynchronizer

### Where Claude stores sessions

- **Transcripts:** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the cwd encoding is `cwd.replace(/[^a-zA-Z0-9-]/g, '-')`.
- **Subagent transcripts:** `~/.claude/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl`.
- **Display-name map:** `~/.claude/history.jsonl` maps sessionId → display name.
- **Plugin + env config:** `~/.claude/settings.json`.
- **OAuth tokens:** `~/.claude/.credentials.json`.

### Chokidar watcher

`server/modules/providers/services/sessions-watcher.service.ts` registers chokidar with
`{ interval: 6000, usePolling: true, depth: 6 }` over `~/.claude/projects/`, filtering to
`.jsonl` files only. The Claude path is first in `PROVIDER_WATCH_PATHS`. On each `add`/`change`:

- `sessionSynchronizerService.synchronizeProviderFile('claude', filePath)` →
  `ClaudeSessionSynchronizer.synchronizeFile`.
- After change-debouncing (max 500 ms, max-wait 2 s) the gateway emits `session_upserted`
  WebSocket events to all connected clients.

### Claude-session-synchronizer specifics

- `synchronize(since?)`: recursive scan from `~/.claude/projects/`, skipping `subagents/`
  explicitly (those files repeat the parent's session id and would clobber the main row).
- `synchronizeFile(filePath)`: process a single JSONL (called by chokidar).
- `processSessionFile`: extract `sessionId` + `cwd` from the first JSONL entry, resolve the
  display name via `~/.claude/history.jsonl` lookup, fall back to scanning the end of the
  JSONL for `ai-title`, `last-prompt`, or `custom-title` events for that session id.
- Default name if neither yields anything: `'Untitled Claude Session'`.
- Session-id resolution: checks `sessionsDb.getSessionByProviderSessionId(parsed.sessionId)`
  first (provider-native → app id), then `sessionsDb.getSessionById`.

### Difference from opencode

OpenCode reads from a shared SQLite database that the CLI manages; CloudCLI reads it
read-only via `opencode-sessions.provider.ts`. Claude reads JSONL files directly that the
Claude CLI itself writes to — so Claude's watcher is mutating the local view in lock-step
with the CLI, while opencode's is observing an external writer.

## Registry and types

Claude is the **first** member of the `LLMProvider` union in both:

- [`server/shared/types.ts:68`][shared-types] — `export type LLMProvider = 'claude' | 'codex' | 'gemini' | 'cursor' | 'opencode';`
- [`src/types/app.ts:1`][app-types] — the same union mirrored for the frontend.

Claude is also first in the registry map in
[`server/modules/providers/provider.registry.ts:10–16`][registry].

Provider-specific message kinds live in `server/shared/types.ts`:

- `MessageKind` includes `'permission_request' | 'permission_cancelled'` (Claude only).
- `NormalizedMessage` carries Claude-only fields:
  - `isLocalCommand`, `isLocalCommandStdout`, `isCompactSummary`
  - `commandName`, `commandMessage`, `commandArgs`
  - `subagentTools`
  - `toolUseResult`
  - `requestId` (for permission requests)

[registry]: ../../server/modules/providers/provider.registry.ts
[shared-types]: ../../server/shared/types.ts
[app-types]: ../../src/types/app.ts

## UI integration

Claude is the **default provider** in CloudCLI's UI: every place that has an unset provider
falls back to `'claude'` (`Sidebar.tsx` and `useChatProviderState`), and every consumer
(`AGENT_PROVIDERS`, `CLI_PROVIDERS`, `PROVIDER_META`) lists it first. That means the UI side
of the integration is structural — it owns the header tab bar, the sidebar's session data
model, and the provider-login modal — and Claude has the most pronounced UI surface of any
provider in the catalog.

This section documents the **frontend** side of that integration. The 7 subsections below
each cover one piece: the header tab switcher (which carries no provider-specific state
but is shared across all providers), the chat tab (which loads history and dispatches WS
frames), the shell/CLI tab (which embeds `xterm.js` and forwards `provider` to the server),
the sidebar list of sessions (which is per-project, not per-provider), the auth-status
surface that decides when to pop `ProviderLoginModal`, the skills panel, and the MCP panel.

### Header tabs — `MainContentTabSwitcher`

The header is owned by `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
and the tab switcher lives in
`src/components/main-content/view/subcomponents/MainContentTabSwitcher.tsx`.

Built-in tabs are declared statically (`MainContentTabSwitcher.tsx:34–53`):

| `id` | `labelKey` | Icon | Notes |
|---|---|---|---|
| `'chat'` | `tabs.chat` | `MessageSquare` | The provider chat panel (see Chat tab section). |
| `'shell'` | `tabs.shell` | `Terminal` | The in-browser `xterm.js` terminal (see Shell/CLI tab section). |
| `'files'` | `tabs.files` | `Folder` | Read-only workspace file browser. |
| `'git'` | `tabs.git` | `GitBranch` | The version-control panel that was stabilized against identity rebuilds (see `git-panel-ux` memory). |

`browser` and `tasks` tabs are conditional, rendered when the `BrowserUseService` /
`TasksSettingsContext` enable them (`BROWSER_TAB`, `TASKS_TAB` constants). **None of the
built-in tabs are provider-specific** — the same chrome is shown regardless of whether
the user picks Claude or OpenCode. Plugin tabs are derived dynamically (`MainContentTabSwitcher.tsx:70–78`):

```ts
const pluginTabs: PluginTab[] = plugins
  .filter((p) => p.enabled)
  .map((p) => ({
    kind: 'plugin',
    id: `plugin:${p.name}` as AppTab,
    label: p.displayName,
    pluginName: p.name,
    iconFile: p.icon,
  }));
```

The `AppTab` union (`src/types/app.ts:20`) explicitly allows a plugin prefix:

```ts
export type AppTab = 'chat' | 'files' | 'shell' | 'git' | 'tasks' | 'browser' | `plugin:${string}`;
```

**State mechanism** — the active tab is plain React `useState` inside `useProjectsState`
(`src/hooks/useProjectsState.ts:355`):

```ts
const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);
```

`readPersistedTab` (`useProjectsState.ts:327–343`) reads `localStorage.getItem('activeTab')`
and validates against a fixed allow-list:

```ts
const VALID_TABS = new Set(['chat', 'files', 'shell', 'git', 'tasks', 'browser']);
const isValidTab = (tab: string): tab is AppTab =>
  VALID_TABS.has(tab) || tab.startsWith('plugin:');
```

Every change writes back to localStorage (`useProjectsState.ts:357–363`). **There is no
URL hash and no react-router for the tab** — only the session id is exposed in the
router (`App.tsx:117–118`, routes are `/` and `/session/:sessionId`). The
`setActiveTab` setter is also exercised imperatively from `MainContent.tsx:102–125`
to auto-switch off a now-disabled tab (e.g. when the user disables `tasks` while the
tab is active) and from `PaletteOpsContext` callbacks to open files at specific
projects.

Tab render guards in `MainContent.tsx:182–205` (chat) and `:213–222` (shell) ensure the
heavy components stay mounted across tab switches but stay invisible (`hidden` class):

```tsx
<div className={`h-full ${activeTab === 'chat' ? 'block' : 'hidden'}`}>
  <ErrorBoundary showDetails>
    <ChatInterface ... />
  </ErrorBoundary>
</div>

{activeTab === 'shell' && (
  <div className="h-full w-full overflow-hidden">
    <StandaloneShell
      project={selectedProject}
      session={selectedSession}
      showHeader={false}
      isActive={activeTab === 'shell'}
    />
  </div>
)}
```

i18n keys live in `src/i18n/locales/en/common.json` under the `tabs` namespace. Spanish
is the default locale; the table above maps to `"Chat" / "Shell" / "Files" / "Source Control"`.

### Chat tab — how chat history is loaded

The chat panel is rendered by `src/components/chat/view/ChatInterface.tsx`, mounted only
when the header tab is `'chat'` (see `MainContent.tsx:182–205`). It composes four major
hooks (file:line citations in `ChatInterface.tsx`):

- `useChatProviderState` (`:64–90`) — provider + per-provider model + per-provider permission mode.
- `useChatSessionState` (`:92–134`) — current `sessionStore` slot, scroll, processing state, token budget.
- `useChatComposerState` (`:145–216`) — composer input, attachments, `handleSubmit`, file uploads, slash-command parser.
- `useChatRealtimeHandlers` (`:235–251`) — WebSocket event reducer for the **chat** socket (excluding `session_upserted` and `loading_progress`, which `useProjectsState` owns — see the [Sidebar left sessions list](#sidebar-left-sessions-list) section).

**REST history load.** `useSessionStore` (`src/stores/useSessionStore.ts`) is the only
Zustand-style store in the codebase (everything else is `useState`/context). It's a
`Map<sessionId, SessionSlot>`; each slot persists messages + metadata per session.
The fetch path is at `useSessionStore.ts:478`:

```ts
const url = `/api/providers/sessions/${encodeURIComponent(sessionId)}/messages${qs ? `?${qs}` : ''}`;
```

`useChatSessionState.ts:556–568` triggers it via `sessionStore.fetchFromServer(selectedSessionId, { limit: 20, offset: 0 })`.
Pagination uses the same endpoint with `offset`.

**WebSocket sync.** On session change, `ChatInterface.tsx:226–233` sends `chat.subscribe`
with `lastSeq`, the seq number we last saw for that session:

```ts
sendMessage({
  type: 'chat.subscribe',
  sessions: [{
    sessionId: selectedSession.id,
    lastSeq: lastSeqRef.current.get(selectedSession.id) ?? 0,
  }],
});
```

The replay logic guarantees no gaps if the user reloads the page mid-stream. `useChatSessionState.ts:498–511`
also sends it on initial mount.

`useChatRealtimeHandlers` (`src/components/chat/hooks/useChatRealtimeHandlers.ts`) is the
receiver. It `subscribe()`s on the single app-wide `WebSocketContext` socket and dispatches
by `kind`:

| Frame | Line | Action |
|---|---|---|
| `chat_subscribed` | 113 | Resync per-session seq counter. |
| `protocol_error` | 144 | Surface to UI. |
| `stream_delta` | 176 | Append to current assistant message. |
| `stream_end` | 195 | Close streaming bubble. |
| `complete` | 223 | Mark session idle, clear `isProcessing`. |
| `permission_request` | 271 | Open the permission UI (see Permissions section). |
| `permission_cancelled` | 299 | Close the permission UI without decision. |
| `status(token_budget)` | 311 | Update token budget indicator. |
| `session_upserted`, `loading_progress` | **162–165** | **Explicitly ignored** — owned by `useProjectsState`. |

**Send path.** `useChatComposerState.handleSubmit` (`useChatComposerState.ts:737–751`):

```ts
sendMessage({
  type: 'chat.send',
  sessionId: targetSessionId,
  content: messageContent,
  options: {
    model,
    permissionMode,
    toolsSettings,
    skipPermissions: toolsSettings?.skipPermissions || false,
    sessionSummary,
    images: uploadedImages,
  },
});
```

A brand-new session id is lazily allocated on first send via
`POST /api/providers/sessions` (`useChatComposerState.ts:634–674`) and then immediately
relabeled into the WS via `chat.subscribe`. Changing the provider mid-conversation does
**not** reload the session — `useChatProviderState.ts:337–344` only reacts to a change
when there's a selected session whose `__provider` differs from the current UI provider
(it copies the session's `__provider` into `localStorage['selected-provider']`).

**Provider catalog load.** `useChatProviderState.ts:149` declares the full provider list
and loads all five catalogs in parallel:

```ts
const providers: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode'];
const results = await Promise.all(
  providers.map(async (p) => authenticatedFetch(`/api/providers/${p}/models?...`))
);
```

It also fetches `/api/providers/capabilities` (`:217`) for the per-provider permission-mode
matrix. The selector UI is rendered by `ProviderSelectionEmptyState.tsx:26–32`:

```ts
const PROVIDER_META = [
  { id: 'claude',   name: 'Anthropic' },
  { id: 'codex',    name: 'OpenAI' },
  { id: 'gemini',   name: 'Google' },
  { id: 'cursor',   name: 'Cursor' },
  { id: 'opencode', name: 'OpenCode' },
];
```

### Shell / CLI tab — how the TUI is loaded

The shell tab is rendered by `Shell.tsx` inside `StandaloneShell.tsx` (instantiated at
`MainContent.tsx:213–222`). The `StandaloneShell` wrapper passes `isActive={activeTab === 'shell'}`,
and `Shell.tsx:158–174` focuses the terminal when `isActive && isInitialized && isConnected`.

**Component chain:**

```
StandaloneShell         (src/components/standalone-shell/view/StandaloneShell.tsx)
  └─ Shell              (src/components/shell/view/Shell.tsx — xterm.js host)
       ├─ useShellRuntime        (combines terminal init + connection)
       │    ├─ useShellTerminal  (xterm.js setup)
       │    └─ useShellConnection (WebSocket lifecycle)
       └─ sendSocketMessage(...) for client→server keystrokes
```

`Shell.tsx:4` imports `@xterm/xterm/css/xterm.css` to render the terminal UI. Server
side, `server/modules/websocket/services/shell-websocket.service.ts:239` holds the
`IPty` node-pty instance: `let shellProcess: IPty | null = null;`.

**Transport.** WebSocket to `/shell` (NOT `/ws`):

```ts
// src/components/shell/utils/socket.ts:4–18
export function getShellWebSocketUrl(): string | null {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  if (IS_PLATFORM) return `${protocol}//${window.location.host}/shell`;
  const token = localStorage.getItem('auth-token');
  if (!token) return null;
  return `${protocol}//${window.location.host}/shell?token=${encodeURIComponent(token)}`;
}
```

Wire messages are limited to `init`, `input`, `output`. The init frame
(`useShellConnection.ts:141–152`) carries the provider selection:

```ts
sendSocketMessage(socket, {
  type: 'init',
  projectPath, sessionId, hasSession,
  provider, cols, rows, initialCommand, isPlainShell, forceRestart,
});
```

The provider source (`useShellConnection.ts:146`):

```ts
provider: isPlainShellRef.current
  ? 'plain-shell'
  : (selectedSessionRef.current?.__provider
     || localStorage.getItem('selected-provider')
     || 'claude'),
```

`isPlainShell` is set to `true` when the shell is hosting the login modal command and
should NOT be wrapped with provider-specific environment logic — see the Login flow
section below.

**Server-side spawn.** `buildShellCommand` (`shell-websocket.service.ts:115–172`)
maps `provider` to a CLI command. Excerpt (cursor/codex/gemini/opencode + Claude default):

```ts
if (provider === 'cursor') {
  if (resumeSessionId) return `cursor-agent --resume="${resumeSessionId}"`;
  return 'cursor-agent';
}
if (provider === 'codex') {
  if (resumeSessionId) {
    if (os.platform() === 'win32') {
      return `codex resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { codex }`;
    }
    return `codex resume "${resumeSessionId}" || codex`;
  }
  return 'codex';
}
if (provider === 'gemini') {
  const command = initialCommand || 'gemini';
  if (resumeSessionId) return `${command} --resume "${resumeSessionId}"`;
  return command;
}
if (provider === 'opencode') {
  if (resumeSessionId) return `opencode --session "${resumeSessionId}"`;
  return initialCommand || 'opencode';
}
// default Claude
const command = initialCommand || 'claude';
if (resumeSessionId) {
  if (os.platform() === 'win32') {
    return `claude --resume "${resumeSessionId}"; if ($LASTEXITCODE -ne 0) { claude }`;
  }
  return `claude --resume "${resumeSessionId}" || claude`;
}
return command;
```

The TUI **of the provider itself** (Claude's spinner, Codex's prompt, Gemini's checkpoint)
runs *inside* this shell. The user is interacting with the provider's native CLI, not with
a custom CloudCLI TUI. This is the inverse of the chat tab — chat is "CloudCLI owns the
stream"; shell is "CloudCLI owns the terminal emulator, the provider CLI owns the UI".

**CloudCLI login embed.** `ProviderLoginModal` (`src/components/provider-auth/view/ProviderLoginModal.tsx:143`)
embeds `StandaloneShell` directly:

```tsx
<StandaloneShell
  project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
  command={command}
  onComplete={handleComplete}
  minimal={true}
/>
```

`command` is selected per provider at `ProviderLoginModal.tsx:15–53`:
- Claude → `claude --dangerously-skip-permissions /login` (the `--dangerously-skip-permissions` is essential — without it `/login` would block on prompts the embedded terminal can't forward).
- Codex → `codex login --device-auth` (on `IS_PLATFORM`) else `codex login`.
- OpenCode → `opencode auth login`.
- Cursor → `cursor-agent login`.
- Gemini → dedicated API-key instructions panel (NOT a terminal), since Gemini has no interactive login.

`useShellConnection.ts:103–110` tears the connection down on session-id change so the
shell is recreated with the new session's provider and resume id.

### Sidebar left sessions list

The sidebar is built from
`src/components/sidebar/view/Sidebar.tsx` (top-level wrapper, lines 28–54 accept props)
plus two subcomponents:

- `src/components/sidebar/view/subcomponents/SidebarProjectSessions.tsx`
- `src/components/sidebar/view/subcomponents/SidebarSessionItem.tsx`

**Data flow.** The session list is **not** Zustand and **not** `useSessionStore`. It's
plain React state inside `useProjectsState` (see the Hooks section in CLAUDE.md /
`useProjectsState`):

1. `useProjectsState.fetchProjects()` (`useProjectsState.ts:413–440`) → `GET /api/projects` (`src/utils/api.js:56`).
2. `api.projectSessions(projectId, { limit: 20, offset })` (`useProjectsState.ts:889–936`) → `GET /api/projects/:projectId/sessions?...`.
3. `Sidebar.tsx` consumes `sidebarSharedProps` (`:964–1009`) which is `useProjectsState`'s export.

**Real-time updates.** `useProjectsState.ts:592–716` registers a
`subscribe(handleEvent)` on the same app-wide `WebSocketContext` socket. On
`kind: 'session_upserted'` it calls `upsertSessionIntoProject(...)` (`:659`) keyed by
**alias-matching** so the same row receives the updates whether the event arrived via
`sessionId`, `providerSessionId`, or `session.id` (`:212–230`):

```ts
const getSessionAliasIds = (event: SessionUpsertedEvent): Set<string> => {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed) ids.add(trimmed);
  };
  add(event.sessionId);
  add(event.providerSessionId);
  add(event.session?.id);
  return ids;
};
```

This matters because Claude's CLI may report a session id (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`)
that differs from the CloudCLI app-side session id until `chat.subscribe` round-trips. Alias
matching collapses both into one row. **The Git panel has a similar concern** — see the
`git-panel-ux` memory entry for how Claude Code's per-tool-call JSONL writes used to cause
silent refetch storms there, and for the useMemo stabilization fix in `GitPanel.tsx`.

**Identity stabilization.** Unlike the git panel, the sidebar was already mostly stable
because `key={session.id}` (`SidebarProjectSessions.tsx:120–126`) reuses list items across
upserts even if the React object is rebuilt. `mergeSessionProviderLists` (`:140–155`)
and `mergeExpandedSessionPages` (`:157–190`) merge paginated pages by id, not by
reference — so re-renders triggered by `session_upserted` don't change row identity.

`useProjectsState.handleSidebarRefresh` (`:841–887`) preserves `__provider` when the
refreshed payload drops it (`:873–878`):

```ts
const normalizedRefreshedSession =
  refreshedSession.__provider || !selectedSession.__provider
    ? refreshedSession
    : { ...refreshedSession, __provider: selectedSession.__provider };
```

**Provider filtering.** The sidebar shows **all** providers — there's no toggle to
filter by Claude / Codex / OpenCode / Gemini / Cursor. `getAllSessions`
(`src/components/sidebar/utils/utils.ts:99–106`) returns every session under the project
with `__provider` attached per row:

```ts
export const getAllSessions = (project: Project): SessionWithProvider[] => {
  return (project.sessions || []).map((session) => ({
    ...session,
    __provider: getSessionProvider(session),
  })).sort((a, b) => getSessionDate(b).getTime() - getSessionDate(a).getTime());
};
```

`useSidebarController.ts:624` only filters by `searchFilter` / mode (`projects` vs
`running`), never by provider. The per-row icon is `SessionProviderLogo`, which
dispatches per-provider (Claude in `claude.md`'s UI integration section, OpenCode in
`opencode.md`'s).

**Selected session drives provider state.** When a user clicks a row, that session's
`__provider` becomes the active provider via `useChatProviderState`'s effect (see Chat
tab section). The provider dropdown in the chat composer follows the sidebar
selection, not the other way around.

### Auth-status surface — how UI knows "installed + authenticated"

The hook is `useProviderAuthStatus` at
`src/components/provider-auth/hooks/useProviderAuthStatus.ts`. It exposes a single
status object per provider plus an imperative `refreshProviderAuthStatuses` callback.

**REST contract.** Endpoint map (`src/components/provider-auth/types.ts:13–21`):

```ts
export const CLI_PROVIDERS: LLMProvider[] = ['claude', 'cursor', 'codex', 'gemini', 'opencode'];
export const PROVIDER_AUTH_STATUS_ENDPOINTS: Record<LLMProvider, string> = {
  claude:   '/api/providers/claude/auth/status',
  cursor:   '/api/providers/cursor/auth/status',
  codex:    '/api/providers/codex/auth/status',
  gemini:   '/api/providers/gemini/auth/status',
  opencode: '/api/providers/opencode/auth/status',
};
```

Each provider's auth facet implements `checkInstalled()` (e.g.
`claude-auth.provider.ts:22–29`: `spawn.sync(cliPath, ['--version'], { timeout: 5000 })`)
and `checkCredentials()` (the 5-step resolution order documented in the **Auth &
environment** section below this one). The status payload is:

```ts
{ authenticated: boolean, email: string | null, method: 'api_key' | 'credentials_file' | null,
  error?: string, installed: boolean, loading: boolean }
```

**No polling, no setInterval.** The hook only refreshes on explicit invocation
(`useProviderAuthStatus.ts:109–111`):

```ts
const refreshProviderAuthStatuses = useCallback(async (providers: LLMProvider[] = CLI_PROVIDERS) => {
  await Promise.all(providers.map((provider) => checkProviderAuthStatus(provider)));
}, [checkProviderAuthStatus]);
```

Three trigger sites:

1. **Onboarding** (`Onboarding.tsx:57, 70`) — drives step navigation between agent setup pages.
2. **Settings opens** (`useSettingsController.ts:324–325`):
   ```ts
   useEffect(() => {
     if (!isOpen) return;
     setActiveTab(normalizeMainTab(initialTab));
     void loadSettings();
     void refreshProviderAuthStatuses();
   }, [initialTab, isOpen, loadSettings, refreshProviderAuthStatuses]);
   ```
3. **After login flow completes** — callers manually call `refreshProviderAuthStatuses()` to flip the UI status.

**Where the status renders.**

- **Sidebar dot color** — `SidebarSessionItem.tsx` renders the per-row `<SessionProviderLogo>` and, when the session has auth metadata, a colored dot (gray for not-authenticated, brand-color for authenticated).
- **Settings → Agents tab** — `AgentsSettingsTab.tsx:35–55` shows `providerAuthStatus.<provider>` per agent row, including email and an "Iniciar sesión" / "Sign in" button when `!authenticated`.
- **Onboarding** — `Onboarding.tsx:31–32` reads the status to decide which step the user lands on.

**Redirect to `ProviderLoginModal`.** Triggered by `AgentsSettingsTab.onProviderLogin(provider)`
→ `useSettingsController.ts:165, 558–562` flips `loginProvider` state and calls
`setShowLoginModal(true)`. `Settings.tsx:228–235` renders the modal:

```tsx
<ProviderLoginModal
  key={loginProvider || 'claude'}
  isOpen={showLoginModal}
  onClose={() => setShowLoginModal(false)}
  provider={loginProvider || 'claude'}
  onComplete={handleLoginComplete}
  isAuthenticated={isAuthenticated}
/>
```

Inside the modal, `ProviderLoginModal.tsx:15–53` chooses the login command per provider
and embeds `StandaloneShell` (see Shell / CLI tab section). `onProcessComplete(exitCode)`
fires when the CLI exits, but the modal **stays open** (`ProviderLoginModal.tsx:71–73`)
so the user can read the terminal output before manually closing it. The Agents tab
explicitly calls `refreshProviderAuthStatuses()` after the user closes it to flip the
dot from gray to brand color.

### Skills panel

`src/components/skills/view/ProviderSkills.tsx` with data from `useProviderSkills` (`src/components/skills/hooks/useProviderSkills.ts`).

**REST contract.**

```
GET /api/providers/<provider>/skills
GET /api/providers/<provider>/skills?workspacePath=<encoded-cwd>     (per-project)
POST /api/providers/<provider>/skills                                  (add / write)
DELETE /api/providers/<provider>/skills/<name>?scope=...&workspacePath=...
```

The fetch function (`useProviderSkills.ts:164–182`):

```ts
const fetchProviderSkills = async (provider, project?) => {
  const params = new URLSearchParams();
  if (project?.path) params.set('workspacePath', project.path);
  const response = await authenticatedFetch(`/api/providers/${provider}/skills${qs ? `?${qs}` : ''}`);
  // ...
};
```

**Cache.** Module-level `skillsCache` keyed by `${provider}:${projectPath}|...` with a
**5-minute TTL** (`SKILLS_CACHE_TTL_MS`, line 25). This is the *only* skill cache layer;
the server itself doesn't memoize.

The component loads:
- Once globally (`/api/providers/<p>/skills`) → returns user-scoped skills.
- Once per project (`/api/providers/<p>/skills?workspacePath=...`) → returns project-scoped + repo-scoped + admin/system skills.

Each project's results stream back into the list as they resolve
(`useProviderSkills.ts:282–296`).

**Scope grouping.** Automatic, by scope order (`ProviderSkills.tsx:74–91`):

```ts
const SCOPE_LABELS: Record<SkillsScope, string> = {
  user: 'User', plugin: 'Plugin', repo: 'Repo',
  project: 'Project', admin: 'Admin', system: 'System',
};
const SCOPE_ORDER: SkillsScope[] = ['user', 'plugin', 'repo', 'project', 'admin', 'system'];

const groupSkillsByScope = (skills: ProviderSkill[]) =>
  SCOPE_ORDER.map(scope => ({ scope, skills: skills.filter(s => s.scope === scope) }))
             .filter(g => g.skills.length > 0);
```

There is no UI toggle; grouping is fixed by the order above. Free-text search looks across
`command`, `name`, `description`, `scope`, `pluginName`, `projectDisplayName`,
`sourcePath` (`ProviderSkills.tsx:237–256`).

**Refresh triggers.**

- `useEffect(() => { void refreshSkills(); }, [refreshSkills])` (`useProviderSkills.ts:322–324`) — on mount + dependency change.
- **5-minute cache TTL** (`useProviderSkills.ts:234`).
- **Manual "Refresh" button** (`ProviderSkills.tsx:378–388`) — calls `refreshSkills({ force: true })`.
- **After successful save** (`addSkills`, line 309–320) → `clearProviderSkillCache(...)` then `refreshSkills({ force: true })`.
- On `selectedProvider` change (`useProviderSkills.ts:326–328`) — resets `saveStatus`.

**Plugin skills surface.** The data model carries `pluginName?` / `pluginId?`
(`src/components/skills/types.ts:20–21`). When present, `ProviderSkills.tsx:629–633`
renders a Plugin badge:

```tsx
{skill.pluginName && (
  <Badge variant="outline" className="rounded-full bg-background/70">
    Plugin: {skill.pluginName}
  </Badge>
)}
```

**Claude is the only provider that actually generates plugin-scoped skills** — every
other provider's `getSkillSources` returns empty for the `plugin` scope. The badge is
data-driven, so the UI works for any provider that ever exposes a plugin skill; right
now that's just Claude.

`PROVIDER_SKILL_PATHS` (`ProviderSkills.tsx:67`) deliberately excludes `opencode` from
the per-provider skill-paths table — OpenCode reuses Claude's skill discovery, so its
skills show up under the Claude slot.

### MCP panel

`src/components/mcp/view/McpServers.tsx` is the main list, with `useMcpServers`
(`src/components/mcp/hooks/useMcpServers.ts`) as the data layer and
`McpServerFormModal.tsx` for add/edit.

**REST contract.**

```
GET    /api/providers/<provider>/mcp/servers?scope=<scope>&workspacePath=...     (per-scope, per-project)
POST   /api/providers/<provider>/mcp/servers                                      (upsert)
DELETE /api/providers/<provider>/mcp/servers/<name>?scope=...&workspacePath=...   (delete)
POST   /api/providers/mcp/servers/global                                          (fan-out to all providers)
```

Fetch at `useMcpServers.ts:143–161`:

```ts
const fetchProviderScopeServers = async (provider, scope, project?) => {
  const params = new URLSearchParams({ scope });
  if (project?.path) params.set('workspacePath', project.path);
  const response = await authenticatedFetch(`/api/providers/${provider}/mcp/servers?${params.toString()}`);
  // ...
};
```

**Cache.** Module-level `mcpServersCache` keyed by `${provider}:${projectPath}|...`
with a **30-second TTL** (`useMcpServers.ts:52–53` — `MCP_CACHE_TTL_MS = 30_000`). The
shorter TTL vs skills (5 min) reflects the higher write-frequency expectation.

**Per-provider scope/transport matrix** (`src/components/mcp/constants.ts:11–25`):

```ts
export const MCP_SUPPORTED_SCOPES: Record<McpProvider, McpScope[]> = {
  claude:   ['user', 'project', 'local'],
  cursor:   ['user', 'project'],
  codex:    ['user', 'project'],
  gemini:   ['user', 'project'],
  opencode: ['user', 'project'],
};

export const MCP_SUPPORTED_TRANSPORTS: Record<McpProvider, McpTransport[]> = {
  claude:   ['stdio', 'http', 'sse'],
  cursor:   ['stdio', 'http'],
  codex:    ['stdio', 'http'],
  gemini:   ['stdio', 'http', 'sse'],
  opencode: ['stdio', 'http'],
};

export const MCP_SUPPORTS_WORKING_DIRECTORY = {
  claude: false, cursor: false, codex: true, gemini: true, opencode: false,
};
```

Claude has the broadest support (3 scopes, 3 transports); OpenCode has the narrowest
(2 scopes, 2 transports). `McpServerFormModal` switches what fields it shows based on
this matrix; see also the per-provider quirks in `docs/providers/codex.md`, `gemini.md`,
`opencode.md`.

**Global "all providers" form.** For pushing the same MCP server to every provider at
once, the modal in `mode='global'` mode is constrained to (`McpServers.tsx:130–133`):

```ts
export const MCP_GLOBAL_SUPPORTED_SCOPES: McpScope[] = ['user', 'project'];
export const MCP_GLOBAL_SUPPORTED_TRANSPORTS: McpTransport[] = ['stdio', 'http'];
```

i.e. `local` scope and `sse` transport are blocked in global mode because not every
provider supports them. The fan-out target is `POST /api/providers/mcp/servers/global`
(`useMcpServers.ts:198–212`) — server returns a per-provider success/failure list; the
hook renders that in a `saveStatus` banner.

**Modal flow** (`McpServerFormModal.tsx`). Props: `provider`, `mode` (`'provider' | 'global'`),
`editingServer?`, `supportedScopes?`, `supportedTransports?`. The fallback chain at
`:82–83`:

```ts
const availableScopes = supportedScopes ?? MCP_SUPPORTED_SCOPES[provider];
const availableTransports = supportedTransports ?? MCP_SUPPORTED_TRANSPORTS[provider];
```

Submit is wired in `useMcpServers.ts:424–479`:
- `submitForm(formData, editingServer)` → `saveProviderServer` (POST), optional `deleteProviderServer` if `name` / `scope` / `workspacePath` changed (`:432–435`), then `mcpServersCache.delete(cacheKey); refreshServers({ force: true })`.
- `submitGlobalForm(formData)` → `saveGlobalServer` (POST fan-out), `mcpServersCache.clear()`, `refreshServers({ force: true })`, sets `saveStatus` based on per-provider failures.

**Refresh triggers.**

- Mount and dependency change (`useMcpServers.ts:501–503`).
- After save/delete (invalidation + forced refresh).
- Manual: implicit via the form modal close.

**Managed (read-only) servers.** Servers whose name starts with `cloudcli-` are
flagged by `isManagedServer` (`McpServers.tsx:58`) and rendered without edit/delete
buttons — they belong to CloudCLI itself, not to the user (see CLAUDE.md "Built-in MCP
servers"). Adding one of the prefix `cloudcli-<feature>` MCPs (like `cloudcli-browser-use`)
in the server module automatically registers it as managed and surfaces the lock badge in
this list.

---

### Login flow

`ProviderLoginModal` triggers an embedded terminal (via `StandaloneShell`) running the
provider-specific CLI command declared at `ProviderLoginModal.tsx:15–53`:

| Provider | Command | Notes |
|---|---|---|
| `claude` | `claude --dangerously-skip-permissions /login` | `--dangerously-skip-permissions` is essential — without it `/login` would block on prompts that the embedded terminal cannot forward. |
| `cursor` | `cursor-agent login` | |
| `codex` | `codex login --device-auth` (SaaS) or `codex login` (self-hosted) | Branch at `ProviderLoginModal.tsx:36–38`. |
| `opencode` | `opencode auth login` | |
| `gemini` | (none — instructions panel) | Different UX (see the Gemini `cloudcli gemini …` section). |

After `onProcessComplete(exitCode)` fires (logged-in successfully), the modal stays
open (`ProviderLoginModal.tsx:71–73`) so the user can read the terminal output. The
Agents tab calls `refreshProviderAuthStatuses()` after the modal closes to flip the
dot from gray to the provider's brand color.

### Icon + brand identity

**Icon** — `src/components/llm-logo-provider/ClaudeLogo.tsx` renders the official
Anthropic asterisk inside an orange octagon (`#D77655` fill, `#FCF2EE` glyph).
`SessionProviderLogo.tsx` (path: see Header tabs section) dispatches to `<ClaudeLogo>`
for `provider === 'claude'`, and falls back to it when the provider is unset (the default).

**Provider lists** — claude is first in `AGENT_PROVIDERS` and `CLI_PROVIDERS`. The
sidebar uses `resolvedProvider = (provider || 'claude') as LLMProvider`, so any UI
without a stored provider defaults to Claude.

**Auth endpoint** — `/api/providers/claude/auth/status`.

**MCP button** — `bg-primary text-primary-foreground hover:bg-primary/90` (the only
provider with the "primary" style). Scopes `['user', 'local', 'project']`. Transports
`['stdio', 'http', 'sse']`.

### i18n

Locales: `en`, `es`, `fr` plus `ru`, `tr`, `zh-TW`, `zh-CN`, `ko`, `de`, `it`, `ja`.
Notable keys:

- `chat.providers.claude`
- `chat.readyPrompt.claude`
- `chat.newSession.startSession`
- `chat.claudeStatus.*` (entire section for status banners)
- `settings.agents.providers.claude.description`
- `settings.permissions.claudeDescription`
- `settings.providers.claude`
- `sidebar.fetchingProjects`
- `sidebar.runClaudeCli`
- `tabs.chat`, `tabs.shell`, `tabs.files`, `tabs.git` (under `common.json`)

Remember to update both `en`, `es`, **and** `fr` for any new key — Spanish is the project's
default language and the fallback chain trips to English only when a key is missing in all
three.

## End-to-end message flow

1. User types a message in the chat input, selects claude (or it's the default).
2. Frontend sends `chat.send { sessionId, content, options: { cwd, model, permissionMode, allowedTools, … } }` over WebSocket to `/ws`.
3. `handleChatSend` (`server/modules/websocket/services/chat-websocket.service.ts`) resolves the session via `sessionsDb.getSessionById(sessionId)` → provider, project path, provider-native session id. Calls `chatRunRegistry.startRun(...)` to create the per-run writer.
4. `await spawnFn(command, runtimeOptions, run.writer)` where `spawnFn = queryClaudeSDK`.
5. `queryClaudeSDK`:
   - Resolves model via `providerModelsService.resolveResumeModel('claude', sessionId, options.model)`.
   - Configures the SDK options (permission mode, tools preset, system prompt preset, setting sources, env).
   - Calls `loadMcpConfig(cwd)` to merge global + project-scoped MCP servers from `~/.claude.json`.
   - If the prompt contains images, `handleImages` writes them to `<cwd>/.tmp/images/<ts>/image_N.ext` and injects the paths back into the prompt (a workaround because the SDK expects file paths for image input).
   - Registers `canUseTool` and the `Notification` hook.
   - Sets `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT=300000` for the duration of the call.
   - Invokes `query({ prompt, options })` and stores the instance for abort.
6. `for await (const message of queryInstance)`:
   - First message containing `session_id` → emit `session_created`, remember provider session id, persist.
   - `transformMessage` renames `parent_tool_use_id` → `parentToolUseId` for subagent grouping.
   - `ClaudeSessionsProvider.normalizeMessage(...)` → `NormalizedMessage[]`.
   - Each `NormalizedMessage` is written to the per-run writer (which broadcasts over WebSocket).
   - `extractTokenBudget(message)` → emit `kind: 'status', text: 'token_budget'` when `message.usage` is present.
7. When a tool needs approval → `canUseTool` → `permission_request` over WebSocket → `waitForToolApproval` → user response → continue.
8. When the generator terminates:
   - Clean up temp images and remove the session.
   - If not aborted → emit `complete`, call `notifyRunStopped(...)`.
9. `chatRunRegistry.completeRun({exitCode})` for safety, even if the SDK already emitted its own `complete`.

## Auth & environment

### `CLAUDE_CLI_PATH`

Variable de entorno opcional, procesada por `server/shared/claude-cli-path.ts`:

- Linux / macOS: returned as-is (or defaults to `'claude'` on PATH).
- Windows: npm wrapper paths (`node_modules/@anthropic-ai/claude-code/bin/claude.cmd`) need
  special handling because the SDK uses `child_process.spawn` (not cross-spawn) on Windows
  and doesn't follow wrappers reliably. The helper parses wrapper contents to find the
  real `claude.exe`, falling back to `where.exe` lookup.

### Credential resolution order (`claude-auth.provider.ts:checkCredentials`)

1. `process.env.ANTHROPIC_AUTH_TOKEN` → `method: 'api_key'`
2. `process.env.ANTHROPIC_API_KEY` → `method: 'api_key'`
3. `~/.claude/settings.json` → `env.ANTHROPIC_API_KEY` → `method: 'api_key'`
4. `~/.claude/settings.json` → `env.ANTHROPIC_AUTH_TOKEN` → `method: 'api_key'`
5. `~/.claude/.credentials.json` → `claudeAiOauth.accessToken` (with `expiresAt` check) → `method: 'credentials_file'`. Email is `creds.email ?? creds.user`.

If `installed === false` (verified via `spawn.sync(cliPath, ['--version'])`), returns
`error: 'Claude Code CLI is not installed'`.

### No `cloudcli claude ...` sub-command

There's no CLI sub-command for claude. All interaction happens through the chat panel's
WebSocket. The login flow runs `claude --dangerously-skip-permissions /login` in an
embedded terminal.

## Unique behaviors

Claude has several features the other providers don't:

1. **In-process SDK** — only provider that doesn't shell out. Lower latency, more shared
   state, but tightly coupled to the SDK version.
2. **Interactive permission flow** — `canUseTool` + `permission_request` / `permission_cancelled`
   is unique to Claude.
3. **Plugin skills subsystem** — only provider that auto-detects `enabledPlugins` and
   exposes each plugin's commands and skills as first-class UI features.
4. **Slash command parsing** — `<command-name>/<command-message>/<command-args>` tags
   are parsed and re-exposed to the user.
5. **Compact summary remapping** — `isCompactSummary: true` rows originally authored as
   user content get re-labeled as assistant text.
6. **Local command stdout re-labeling** — `<local-command-stdout>` blocks are extracted,
   ANSI-stripped, and re-exposed as assistant text.
7. **Subagent transcripts** — `<sessionId>/subagents/agent-<id>.jsonl` files are attached
   as `subagentTools` on the parent tool_result, so subagent activity is visible in the
   parent's transcript.
8. **Extended thinking blocks** — supports `part.type === 'thinking'` with `part.thinking`.
9. **System prompt preset** — `systemPrompt: { type: 'preset', preset: 'claude_code' }`,
   necessary for `CLAUDE.md` to be honored.
10. **Multi-source `CLAUDE.md` auto-load** — `settingSources: ['project', 'user', 'local']`
    loads the system doc from the three conventional locations.
11. **OAuth credentials** — supports both API key and OAuth via `.credentials.json`.
    Other providers are API-key only.
12. **Images via temp files** — base64 input is written to `<cwd>/.tmp/images/<ts>/image_N.ext`
    and paths are injected into the prompt.
13. **Token budget emission** — `message.usage` is extracted and `kind: 'status',
    text: 'token_budget'` is emitted for the UI to show context-window usage.
14. **Notification hook** — the SDK's `Notification` hook becomes a
    `notification_event` action_required frame.
15. **Long-lived SDK stream-close timeout** — defaults to 5 min (vs SDK default of 5 s).

## Debugging & verification

Existing tests cover significant portions:

- `server/shared/tests/claude-cli-path.test.ts` — the Windows path resolver.
- `server/modules/providers/tests/mcp.test.ts` — claude section (`user`, `local`, `project` scopes; `stdio`, `http`, `sse` transports).
- `server/modules/providers/tests/skills.test.ts` — claude user, project, and **enabled plugin** skills (including plugin commands, recursive skills, multi-install, nested subdirectory).
- `server/modules/database/tests/sessions-provider-mapping.test.ts` and `sessions.db.integration.test.ts` — session mapping.
- `server/routes/tests/commands.test.js` — slash commands touching claude.
- `server/services/tests/notification-orchestrator.test.js` — notification pipeline.

**No dedicated test for `server/claude-sdk.js`.** Be careful when changing it.

Logs worth grepping:

- `SDK query error: ...` — real error, ignore `ede_diagnostic` matches (those are warn).
- `SDK query ended with ede_diagnostic ...` — continuation, not a failure (warn).
- `Permission requested for tool ...` (or similar) — see how the interactive flow logs.

## Known quirks

- **`canUseTool` is skipped under `auto` / `bypassPermissions`** for interactive tools.
  This is a SDK behavior, not a bug we can fix without restructuring the permission flow.
  Documented in the source at `server/claude-sdk.js`.
- **`stream_close_timeout` is overriden per call.** The SDK reads the env var synchronously
  at construction time, so we save/restore around `query(...)`.
- **`TOOL_APPROVAL_TIMEOUT_MS = 55000` default** (configurable via `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`).
  Interactive tools (`AskUserQuestion`, `ExitPlanMode`) explicitly use `timeoutMs: 0` (indefinite).
- **Subagent collision risk.** The synchronizer skips `subagents/` to avoid clobbering the
  parent session row, but be careful when changing the scan logic.
- **`isCompactSummary` remapping is intentional** — without it, compact summaries disappear
  from the visible session.
- **Hooks fallback** — if `query({ ..., hooks })` fails for SDK version compatibility,
  the call is retried without hooks (the `Notification` hook is the only one lost; `canUseTool`
  is configured separately and is unaffected).
- **`CONTEXT_WINDOW=160000` default** — controls the context-window denominator for token
  usage display; override via env var if your project uses a different window size.
- **Memory of allowed tools.** Each `permission-response` with `rememberEntry: true`
  mutates `sdkOptions.allowedTools` in place (this state lives in the SDK options object
  for the current run only — settings persist across runs only if the user re-grants them).

## See also

- `server/modules/providers/README.md` — canonical provider-facet guide.
- `server/modules/websocket/README.md` — message envelope and per-run event log.
- `CLAUDE.md` — top-level project conventions and the CloudCLI runtime model.
- `docs/providers/README.md` — index of provider documentation.
- `docs/providers/opencode.md` — sibling in-process-vs-subprocess comparison.
