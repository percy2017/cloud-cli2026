# Provider / Agent documentation

CloudCLI integrates several AI coding agents as **providers** (a.k.a. *agents*) — each
provider exposes a common set of *facets* (auth, models, mcp, skills, sessions,
sessionSynchronizer) so the rest of the system can stay provider-agnostic.

For the canonical guide on **how providers are built** (facet contract, registration,
types, adding a new one) see [`server/modules/providers/README.md`](../../server/modules/providers/README.md).
This file documents **how each individual provider behaves** from CloudCLI's point of
view and gives you the at-a-glance comparison between them.

## Provider catalog

| Provider | What it is | Status | Doc |
|---|---|---|---|
| `claude` | Anthropic Claude Code SDK (in-process) | Production | [claude.md](./claude.md) |
| `codex` | OpenAI Codex CLI (subprocess + `@openai/codex-sdk`) | Production | [codex.md](./codex.md) |
| `cursor` | Cursor CLI (subprocess + content-addressed SQLite blobs) | Production | [cursor.md](./cursor.md) |
| `gemini` | Google Gemini CLI (subprocess + stream-json) | Production | [gemini.md](./gemini.md) |
| `opencode` | OpenCode CLI (stdio JSONL subprocess, multi-model) | Production | [opencode.md](./opencode.md) |
| `qwen` | Qwen Code CLI (subprocess + `--output-format stream-json`, NDJSON) | **Phase-0 ready (v0.19.7 probed)** — implementation TBD | [qwen.md](./qwen.md) |

## Capabilities & UI support matrix

This is the single source of truth for "what does each provider support and how does
the UI render it". Update this table whenever a capability flag flips, a new
permission mode lands, or a tool renderer is added.

| Provider | Login command | Permission modes | `supportsPermissionRequests` | Interactive UI | `tool_use` renderer | Custom providers | Status |
|---|---|---|---|---|---|---|---|
| `claude` | `claude login` | `default` \| `acceptEdits` \| `bypassPermissions` \| `plan` | **`true`** | **Yes** — `AskUserQuestionPanel` + `<Confirmation>` default + `PlanDisplay`. Driven by `canUseTool` callback in `server/claude-sdk.js:581` (TOOLS_REQUIRING_INTERACTION = `{AskUserQuestion, ExitPlanMode}`) | Rich (`QuestionAnswerContent` for AskUserQuestion, `ToolDiffViewer` for Edit/Write, `BashCommandDisplay` for Bash) | No (Anthropic API key) | Production |
| `codex` | `codex login` (or `codex login --device-auth` on SaaS) | `default` \| `acceptEdits` \| `bypassPermissions` | `false` | **No** — capability flag is off; the composer passes `permissionMode` at spawn as `--sandbox`/`--approval-policy` and the CLI handles decisions internally | Rich (same `tool_use` renderers as Claude — `BashCommandDisplay`, `ToolDiffViewer`, etc.) | **Yes** — `[model_providers.*]` with `experimental_bearer_token` in `~/.codex/config.toml` (e.g. `MiniMax-M3` against `https://api.minimax.io/v1`) | Production |
| `cursor` | `cursor auth login` | `default` \| `acceptEdits` \| `bypassPermissions` (mapped to `-f` / `--allow-command` / `--deny-command`) | `false` | **No** — CLI does not surface interactive prompts; all decisions go through the `-f` flag at runtime | Rich (same `tool_use` renderers) | No | Production |
| `gemini` | `gemini auth login` | `default` \| `autoEdit` \| `yolo` \| `plan` (mapped to `--approval-mode`) | `false` | **No** — "unlike Claude it has no interactive permission flow — the CLI runs in `--yolo` or auto-edit mode by default" (`docs/providers/gemini.md`) | Rich (same `tool_use` renderers) | No | Production |
| `opencode` | `opencode auth login` | `['default']` only | `false` | **No** — `supportsPermissionRequests: false`; the CLI never emits a `permission_request` frame | **Partial** — emits `toolName: 'question'` but `TOOL_CONFIGS` only registers `AskUserQuestion`, so it falls back to `Default` collapsible with raw JSON (`docs/providers/opencode.md`) | **Yes** — multi-model catalog via `opencode models`; per-workspace `~/.local/share/opencode/opencode.db` (shared SQLite, queried read-only) | Production |
| `qwen` | **None** (`qwen auth (removed)` in v0.19.7) — auth = edit `~/.qwen/settings.json` or export env vars | `default` \| `acceptEdits` \| `bypassPermissions` (mirror Codex; qwen's 5 CLI modes — `plan`, `default`, `auto-edit`, `auto`, `yolo` — deferred) | **`false`** | **No** — first iteration mirrors Codex pattern; `ask_user_question`/`exit_plan_mode` are registered in `system.init.tools[]` but blocked in `-p` mode by the CLI itself. `qwen serve --http-bridge` (Stage 1) would be required for real interactivity | **Rich** (same `tool_use` renderers — qwen forked Claude's tool surface: `read_file`, `grep_search`, `web_fetch`, etc.) | **Yes** — multi-model via `settings.json#modelProviders.<type>[]` with custom `baseUrl` (verified on this host: `anthropic → api.minimax.io`) | **Phase-0 ready** |

### What the matrix hides

- **`supportsPermissionRequests: false`** doesn't mean "no permission UI" — it means
  "the SDK does not interrupt the stream to ask". For the four providers above
  (codex/cursor/gemini/opencode), the CLI handles permission decisions internally
  (CLI flags at spawn time). The user gets the binary `permissionMode` choice at
  the chat composer, the proxy forwards it as a spawn flag, and the CLI either
  auto-approves or fails the tool.
- **`tool_use` rendering is provider-agnostic.** All six providers emit
  `kind: 'tool_use'` over WebSocket and the frontend's `ToolRenderer` routes by
  `toolName` through `src/components/chat/tools/configs/toolConfigs.ts`. The only
  asymmetry is the `question` tool name (OpenCode's `question` falls through to
  the `Default` collapsible; Claude's `AskUserQuestion` has a rich
  `QuestionAnswerContent` renderer).
- **Claude is the only provider with a real-time interactive UI** because it's the
  only one that exposes a `canUseTool` callback mid-stream. The Anthropic SDK
  hands control back to CloudCLI before each tool runs; the four CLI-based
  providers are fire-and-forget subprocesses.

### Auth resolution per provider

| Provider | Primary source | Fallbacks | Custom model providers? |
|---|---|---|---|
| `claude` | `claude login` → `~/.claude/.credentials.json` | `ANTHROPIC_API_KEY` env | No |
| `codex` | `~/.codex/auth.json` (`tokens.id_token` / `tokens.access_token`) | `~/.codex/config.toml` (`OPENAI_API_KEY`, `[providers.*].apiKey`, `[model_providers.*].experimental_bearer_token`), `process.env.OPENAI_API_KEY` (or `OPENAI_KEY` / `CODEX_API_KEY`) | **Yes** |
| `cursor` | `cursor auth login` → `~/.cursor/auth.json` | `CURSOR_API_KEY` env | No |
| `gemini` | `gemini auth login` → `~/.gemini/` OAuth tokens | `GEMINI_API_KEY` / `GOOGLE_API_KEY` env | No |
| `opencode` | `opencode auth login` → `~/.local/share/opencode/auth.json` | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GEMINI_API_KEY` / `GROQ_API_KEY` / `OPENROUTER_API_KEY` env (covers all bundled providers) | **Yes** (multi-model) |
| `qwen` | `~/.qwen/settings.json` (env block + `security.auth.selectedType` + `modelProviders.<type>[]`) | `process.env.{ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, BAILIAN_CODING_PLAN_API_KEY}` + `<project>/.qwen/.env` + `~/.qwen/.env` + `~/.env` (4-source cascade) | **Yes** (custom `baseUrl` per type, verified with `api.minimax.io/anthropic` on this host) |

See [`docs/voice.md`](../voice.md) for the orthogonal voice feature (STT/TTS, not
provider-scoped).

## Conventions for these docs

- Markdown only, no extra tooling.
- Anchor citations with `path:line` so claims are verifiable.
- Cross-link to `server/modules/providers/README.md` for shared concepts; don't repeat it.
- Mirror the opencode doc's section list when documenting the others — easier navigation.
- Update this index **and the comparison matrix above** when a new per-provider doc lands.

## Adding a new provider doc

1. Copy `opencode.md` and replace the per-provider sections.
2. Update the table above (catalog + capabilities matrix) with a link to the new file.
3. Use Conventional Commits: `docs(providers): add <provider> integration documentation`.
   The project's commitlint auto-prefixes free-form messages with `chore:`, but for a
   doc-only commit `docs(...)` is more accurate — write the commit message explicitly.