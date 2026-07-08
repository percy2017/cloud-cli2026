# MiniMax managed MCP

CloudCLI ships a built-in **managed MCP** feature for the
[`minimax-coding-plan-mcp`](https://platform.minimax.io/docs/token-plan/mcp-guide)
PyPI package — the same `web_search` + `understand_image` tools MiniMax
publishes for Claude Code, Cursor, Codex, and OpenCode. CloudCLI registers
the server as `cloudcli-minimax` so it shows up under every provider's
MCP Servers list with a "Managed" lock badge.

This doc covers the CloudCLI-specific wiring: where the feature lives, how
the toggle persists, and how the per-provider MCP entry is written. For the
upstream package itself, see the
[MiniMax MCP guide](https://platform.minimax.io/docs/token-plan/mcp-guide).

## Architecture at a glance

```
                 ┌────────────────────────────┐
                 │  User toggles Enable       │
                 │  MiniMax in Settings tab   │
                 └──────────────┬─────────────┘
                                │
                                ▼
        ┌──────────────────────────────────────┐
        │ Frontend                             │
        │  src/components/settings/view/tabs/ │
        │   minimax-settings/                  │
        │    MiniMaxSettingsTab.tsx            │
        │  PUT /api/minimax/settings           │
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │ REST routes                          │
        │  server/modules/minimax/             │
        │    minimax.routes.ts                 │
        │  GET  /status                        │
        │  GET  /settings                      │
        │  PUT  /settings                      │
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │ Service                              │
        │  server/modules/minimax/             │
        │    minimax.service.ts                │
        │  Reads/writes appConfigDb.           │
        │  Calls providerMcpService to upsert  │
        │  cloudcli-minimax in every provider. │
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │ Cross-provider dispatcher            │
        │  server/modules/providers/services/  │
        │    mcp.service.ts                    │
        │  addMcpServerToAllProviders({...})   │
        │  iterates claude/codex/cursor/       │
        │  gemini/opencode, writes each one.   │
        └──────────────────────────────────────┘
```

The MCP itself (`uvx minimax-coding-plan-mcp -y`) is launched on demand
by each provider CLI when its on-disk config lists `cloudcli-minimax`.
CloudCLI is **not** an intermediary — the stdio server talks directly to
`https://api.minimax.io` using the user's `MINIMAX_API_KEY`.

## Backend module layout

| File | Purpose |
|---|---|
| `server/modules/minimax/index.ts` | Barrel: `export { minimaxService }` |
| `server/modules/minimax/minimax.service.ts` | `getSettings`, `updateSettings`, `getStatus`, `registerAgentMcp`, `unregisterAgentMcp`. Reads/writes `app_config` row `minimax_settings`. |
| `server/modules/minimax/minimax.routes.ts` | Express router exposing `GET/PUT /api/minimax/settings` and `GET /api/minimax/status`. Mounted under `authenticateToken` in `server/index.js`. |
| `server/modules/minimax/tests/minimax.service.test.ts` | 7 colocalos: defaults, persisted shape, register payload, no-key guard, remove, re-register on credential change, status probe. |

### Storage: `app_config` row `minimax_settings`

JSON shape:
```json
{
  "enabled": true,
  "apiKey": "sk-cp-...",
  "apiHost": "https://api.minimax.io"
}
```

The API key is stored **plaintext**, same trust level as
`browser_use_mcp_token` (which gates the local `cloudcli-browser` stdio
bridge). Future enhancement: encrypt at rest using a key derived from
`JWT_SECRET`.

### Settings flow

`updateSettings({ enabled })` (in `minimax.service.ts`):

1. Merge the new partial with the persisted settings.
2. If enabling **without** an API key, throw and roll back persistence
   (so the toggle can't be left in a half-on state).
3. On the **off→on** transition, call `registerAgentMcp`, which delegates
   to `providerMcpService.addMcpServerToAllProviders` with:
   ```ts
   {
     name: 'cloudcli-minimax',
     scope: 'user',
     transport: 'stdio',
     command: 'uvx',
     args: ['minimax-coding-plan-mcp', '-y'],
     env: {
       MINIMAX_API_KEY: settings.apiKey,
       MINIMAX_API_HOST: settings.apiHost,
     },
   }
   ```
4. On the **on→off** transition, call `unregisterAgentMcp` → `removeMcpServerFromAllProviders`.
5. On the **on→on** transition with new credentials, re-register so the
   new env is propagated to every provider's MCP config.

### Status probe

`getStatus()` runs `which uvx` (5-second timeout) and reports:
- `uvxAvailable` — whether the runner is on PATH.
- `apiKeyConfigured` — whether the key is non-empty.
- `available` — the AND of all three (enabled + uvx + key).
- `message` — a human-readable explanation of the current state.

## Per-provider MCP shape

The dispatcher writes the canonical `cloudcli-minimax` entry to each
provider's user-scope config. Because the entry uses `transport: 'stdio'`,
each provider's `*McpProvider` adapter serializes it according to the
provider's own file format:

| Provider | File | Entry shape |
|---|---|---|
| Claude | `~/.claude.json` | `mcpServers.cloudcli-minimax = { type, command, args, env }` |
| Codex | `~/.codex/config.toml` | `[mcp_servers.cloudcli-minimax] command=... args=[...] env={...}` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.cloudcli-minimax = { command, args, env }` |
| Gemini | `~/.gemini/settings.json` | `mcpServers.cloudcli-minimax = { type, command, args, env }` |
| OpenCode | `~/.config/opencode/opencode.jsonc` | `mcp.cloudcli-minimax = { type: "local", command: [array], environment, enabled: true }` |

The exact key name (`mcpServers` vs `mcp_servers` vs `mcp`) and the field
naming (`env` vs `environment` vs `env_vars`) is enforced by the
provider's `*McpProvider` class — see the
[provider docs](../providers/README.md) for the full matrix.

## Frontend layout

| File | Purpose |
|---|---|
| `src/components/settings/view/tabs/minimax-settings/MiniMaxSettingsTab.tsx` | Toggle + status pills only. When the key is missing and the user tries to enable, shows a link to the **API & tokens** tab. |
| `src/components/settings/view/tabs/api-settings/sections/MiniMaxCredentialsSection.tsx` | The actual API key + host input form (lives under **API & tokens**, alongside the GitHub token section). |
| `src/components/settings/view/tabs/api-settings/CredentialsSettingsTab.tsx` | Mounts `<MiniMaxCredentialsSection />` after `<GithubCredentialsSection />`. |
| `src/components/settings/view/Settings.tsx` (line 14, 200) | Renders `<MiniMaxSettingsTab onNavigateToCredentials={setActiveTab} />` when `activeTab === 'minimax'`. |
| `src/components/settings/view/SettingsSidebar.tsx` | Adds `{ id: 'minimax', labelKey: 'mainTabs.minimax', icon: Sparkles }` to `NAV_ITEMS`. |
| `src/components/settings/types/types.ts` line 6 | Adds `'minimax'` to the `SettingsMainTab` union. |
| `src/components/settings/hooks/useSettingsController.ts` line 57 | Adds `'minimax'` to `KNOWN_MAIN_TABS` (allow-list). |
| `src/i18n/locales/{11 locales}/settings.json` | Adds `settings.mainTabs.minimax` per locale. |
| `src/i18n/locales/{en,es}/settings.json` | Adds `settings.api.minimax.*` keys (12 per locale) for the credentials form labels, hints, and toast. |

### UI composition

**MiniMax tab** (Settings → MiniMax): one `SettingsCard` with:

1. **Toggle row** — `SettingsToggle` bound to `settings.enabled` via
   `PUT /api/minimax/settings`. When the user toggles on without a key,
   the service throws and the frontend shows the error inline.
2. **Status pills** — `uvx: available/missing`, `API key: configured/missing`,
   `Status: ready/setup required/disabled`. Driven by `GET /api/minimax/status`.
3. **Missing-key CTA** — When `enabled && !apiKeyConfigured`, the tab
   shows an amber banner with an "Open API & tokens" button that calls
   `onNavigateToCredentials('api')` to switch tabs.

**API & tokens tab** (Settings → API & tokens): the new
`MiniMaxCredentialsSection` is mounted after `<GithubCredentialsSection />`:
h3 heading, description, two `Input` fields (API key with eye toggle +
masked default, API host), and a Save button. Reads/writes
`apiKey` + `apiHost` via the existing `GET/PUT /api/minimax/settings`
endpoints (the `enabled` field is intentionally untouched by the
credentials form).

## Security

- The `cloudcli-minimax` name prefix matches the existing
  `isManagedServer` heuristic in `McpServers.tsx:58` (`name.startsWith('cloudli-')`),
  so the row appears in every provider's MCP Servers list with the
  "Managed" lock badge and no Edit/Delete affordance. Users cannot
  accidentally delete the entry out of sync with the toggle.
- The API key is stored plaintext in `app_config`. The local file system
  permissions on the SQLite DB default to the user's umask; if you share
  the host, `chmod 600 ~/.cloudcli/auth.db` (the same DB that holds
  `app_config`).
- `providerMcpService.addMcpServerToAllProviders` is fail-isolated: a
  failing provider does not abort the others. The status endpoint
  surfaces partial-failure info via the `available: false` + `message`
  fields, but the per-provider results array is currently discarded (a
  follow-up improvement, tracked separately).

## What is NOT in scope

- **Encrypted credential storage** — same plaintext trust level as
  `browser_use_mcp_token`. Future enhancement: encrypt at rest.
- **HTTP bridge** — MiniMax talks to its own public API; CloudCLI is not
  an intermediary. There is no `cloudli-minimax-mcp.js` stdio server
  bundled with the project.
- **Token rotation** — the API key is set once and stays until the user
  replaces it via the credentials form.
- **Custom MCP server names** — the entry is always `cloudcli-minimax`.
  Users who want a custom name can still add a separate MCP manually via
  "Add Global MCP Server" or the per-provider "Add … MCP Server" button.
- **Per-tool enable/disable** — the underlying `qwen mcp add` (and the
  MCP itself) supports `--include-tools` / `--exclude-tools`. The UI
  does not surface this; both tools (`web_search` + `understand_image`)
  are always exposed when the feature is on.
- **OAuth flow** — the user pastes a Token Plan key. There is no
  browser-based OAuth handshake.

## Verification

After editing settings → Save credentials → Enable MiniMax:

```bash
# 1. The entry exists in every provider config
for f in /root/.claude.json /root/.codex/config.toml /root/.cursor/mcp.json \
         /root/.gemini/settings.json /root/.config/opencode/opencode.jsonc; do
  grep -A2 "cloudcli-minimax" "$f" 2>&1 | head -8
done

# 2. Per-provider smoke
claude mcp list 2>&1 | head -5
codex mcp list 2>&1 | head -5
opencode mcp list 2>&1 | head -5

# 3. Functional test (open a chat in any provider)
#    "Usa web_search para buscar la documentación oficial del MCP"
#    → should invoke the MCP, return real search results

# 4. Disable + cleanup
#    Settings → MiniMax → toggle off
# 5. Re-enable to confirm idempotency
```

## Sources

- `server/modules/minimax/` (this feature)
- `server/modules/browser-use/` (canonical pattern)
- `server/modules/providers/services/mcp.service.ts:55-108` (cross-provider dispatcher)
- `src/components/settings/view/tabs/browser-use-settings/BrowserUseSettingsTab.tsx` (UI mirror)
- `src/components/mcp/view/McpServers.tsx:55-58` (isManagedServer gate — reused as-is)
- `docs/providers/` (per-provider MCP shape documentation)
- `CLAUDE.md` lines 347-360 (managed-MCP pattern documentation)
- [MiniMax MCP guide](https://platform.minimax.io/docs/token-plan/mcp-guide) (upstream package)
