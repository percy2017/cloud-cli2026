# Provider documentation

CloudCLI integrates several AI coding agents as providers — each provider exposes a common
set of *facets* (auth, models, mcp, skills, sessions, sessionSynchronizer) so the rest of the
system can stay provider-agnostic.

For the canonical guide on **how providers are built** (facet contract, registration, types,
adding a new one) see [`server/modules/providers/README.md`](../../server/modules/providers/README.md).
This directory documents **how each individual provider behaves** from CloudCLI's point of view.

## Provider catalog

| Provider | What it is | Status | Doc |
|---|---|---|---|
| `claude` | Anthropic Claude Code SDK (in-process) | Production | [claude.md](./claude.md) |
| `codex` | OpenAI Codex CLI (subprocess + `@openai/codex-sdk`) | Production | [codex.md](./codex.md) |
| `cursor` | Cursor CLI (subprocess + content-addressed SQLite blobs) | Production | [cursor.md](./cursor.md) |
| `gemini` | Google Gemini CLI (subprocess + stream-json) | Production | [gemini.md](./gemini.md) |
| `opencode` | OpenCode CLI (stdio JSONL subprocess, multi-model) | Production | [opencode.md](./opencode.md) |
| `qwen` | Qwen Code CLI (subprocess + `--output-format stream-json`) | **DRAFT — plan only** | [qwen.md](./qwen.md) |

## Conventions for these docs

- Markdown only, no extra tooling.
- Anchor citations with `path:line` so claims are verifiable.
- Cross-link to `server/modules/providers/README.md` for shared concepts; don't repeat it.
- Mirror the opencode doc's section list when documenting the others — easier navigation.
- Update this index when a new per-provider doc lands.

## Adding a new provider doc

1. Copy `opencode.md` and replace the per-provider sections.
2. Update the table above with a link to the new file.
3. Use Conventional Commits: `docs(providers): add <provider> integration documentation`.
   The project's commitlint auto-prefixes free-form messages with `chore:`, but for a
   doc-only commit `docs(...)` is more accurate — write the commit message explicitly.
