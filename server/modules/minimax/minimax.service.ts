/**
 * MiniMax managed MCP service.
 *
 * Registers / unregisters the `cloudcli-minimax` MCP server across all
 * providers via the cross-provider dispatcher. Mirrors the
 * `cloudcli-browser` pattern codified by `server/modules/browser-use/`,
 * but without the HTTP bridge (MiniMax talks to its own public API).
 *
 * Storage: `app_config` row `minimax_settings` (JSON). Plaintext API key —
 * matches the `browser_use_mcp_token` trust level.
 */

import { spawnSync } from 'node:child_process';

import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';

const MINIMAX_SETTINGS_KEY = 'minimax_settings';
const MCP_SERVER_NAME = 'cloudcli-minimax';
const MCP_COMMAND = 'uvx';
const MCP_ARGS = ['minimax-coding-plan-mcp', '-y'];
const DEFAULT_API_HOST = 'https://api.minimax.io';
const UVX_PROBE_TIMEOUT_MS = 5000;
const USAGE_CACHE_TTL_MS = 60_000;
// `mmx speech synthesize --stream` is a synchronous API round-trip. Worst-case
// latency observed locally with the 10k-character cap is ~60 s + audio
// streaming. We allow up to 5 min so a full ~10 min of audio can finish over
// a slow connection; the voice proxy surfaces timeouts as 502 to the client.
const MMX_TIMEOUT_MS = 300_000;
const MMX_PROBE_TIMEOUT_MS = 5_000;
const MMX_BIN = 'mmx';
const MMX_QUOTA_ARGS = ['quota', 'show', '--output', 'json', '--non-interactive'];
// Credentials are read from the mmx CLI (the user manages them with
// `mmx auth login` / `mmx config set`). The MiniMax tab in the UI no
// longer stores the API key. We shell out to `mmx config show` and
// parse api_key + base_url. Cached for the same TTL as quota reads
// because config changes are user-initiated and rare.
const MMX_CONFIG_ARGS = ['config', 'show', '--output', 'json', '--non-interactive'];
const MMX_AUTH_STATUS_ARGS = ['auth', 'status', '--output', 'json', '--non-interactive'];
const MMX_CREDS_CACHE_TTL_MS = 60_000;

// Quota data returned by `mmx quota show --output json`. Field names match the
// CLI verbatim so frontend diffs are easy. See `mmx quota show --help`.
type ModelRemain = {
  model_name: string;
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  current_interval_remaining_percent: number;
  current_interval_status: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  weekly_start_time: number;
  weekly_end_time: number;
  weekly_remains_time: number;
  current_weekly_remaining_percent: number;
  current_weekly_status: number;
};

type UsageUnavailableReason = 'missing-cli' | 'cli-error';

type UsageResult =
  | { available: true; source: 'mmx'; fetchedAt: number; model_remains: ModelRemain[] }
  | {
      available: false;
      source: 'unavailable';
      fetchedAt: number;
      model_remains: [];
      reason: UsageUnavailableReason;
    };

// In-process cache slot. Single entry is enough — quota is not chat-frequency
// sensitive and one user is the only consumer.
let usageCache: { result: UsageResult; expiresAt: number } | null = null;

// Injectable runner — production default shells out via spawnSync. Tests swap
// this out to inject canned results without monkey-patching `node:child_process`.
//
// `stdout` is intentionally typed as `string` to keep the seam simple, but
// `synthesizeText` reads it back with `Buffer.from(r.stdout, 'binary')` so
// binary payloads (mp3/wav/etc.) survive the round-trip regardless of the
// encoding option passed to spawnSync.
//
// `maxBuffer` defaults to ~1 MB on Linux. `mmx speech synthesize --stream`
// can emit tens of MB of raw audio for the 10k-character cap:
//   mp3 128 kbps × ~10 min ≈ 96 MB
//   wav / pcm 32 kHz mono 16-bit × ~10 min ≈ 38 MB
// We set the buffer to 128 MB to cover both formats without truncating the
// child mid-stream (which surfaces as the cryptic `spawnSync mmx ENOBUFS`).
const MMX_STDOUT_MAX_BUFFER_BYTES = 128 * 1024 * 1024;
type SpawnResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type SpawnRunner = (cmd: string, args: string[]) => SpawnResult;
const defaultRunner: SpawnRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    timeout: MMX_TIMEOUT_MS,
    maxBuffer: MMX_STDOUT_MAX_BUFFER_BYTES,
  });
  // Default to binary buffer; coerce to latin1 string so the type stays `string`
  // for quota/config commands (which are JSON text).
  const stdout = r.stdout ? r.stdout.toString('binary') : '';
  const stderr = r.stderr ? r.stderr.toString('utf8') : '';
  return {
    status: r.status,
    stdout,
    stderr,
    error: r.error ?? undefined,
  };
};
let runner: SpawnRunner = defaultRunner;

type MiniMaxTtsSettings = {
  enabled: boolean;
  model: string;
  voice: string;
  format: string;
};

const DEFAULT_TTS_SETTINGS: MiniMaxTtsSettings = {
  enabled: false,
  model: 'speech-2.8-turbo',
  voice: 'English_expressive_narrator',
  format: 'mp3',
};

// Persisted shape. `apiKey` / `apiHost` are NOT stored in the DB — they
// come from the `mmx` CLI at read time (see `readMmxCredentials()` below).
// We keep the fields on the in-memory type so the legacy "put /api/minimax/
// settings { apiKey, apiHost }" endpoint keeps accepting the payload without
// erroring, but they're ignored on write and never serialised back.
type MiniMaxSettings = {
  enabled: boolean;
  apiKey: string;
  apiHost: string;
  tts: MiniMaxTtsSettings;
};

const DEFAULT_SETTINGS: MiniMaxSettings = {
  enabled: false,
  apiKey: '',
  apiHost: DEFAULT_API_HOST,
  tts: { ...DEFAULT_TTS_SETTINGS },
};

// What the persisted DB row actually contains. `tts.*` and `enabled` are
// user-driven settings; the credentials are intentionally absent.
type PersistedMiniMaxSettings = {
  enabled: boolean;
  tts: MiniMaxTtsSettings;
};

function normalizeTtsSettings(input: Partial<MiniMaxTtsSettings> | undefined): MiniMaxTtsSettings {
  const src = input ?? {};
  return {
    enabled: src.enabled === true,
    model:
      typeof src.model === 'string' && src.model.length > 0
        ? src.model
        : DEFAULT_TTS_SETTINGS.model,
    voice:
      typeof src.voice === 'string' && src.voice.length > 0
        ? src.voice
        : DEFAULT_TTS_SETTINGS.voice,
    format:
      typeof src.format === 'string' && src.format.length > 0
        ? src.format
        : DEFAULT_TTS_SETTINGS.format,
  };
}

function readSettings(): MiniMaxSettings {
  try {
    const raw = appConfigDb.get(MINIMAX_SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_TTS_SETTINGS } };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedMiniMaxSettings> & {
      tts?: Partial<MiniMaxTtsSettings>;
      // Tolerate legacy rows that still have these — we drop them on read.
      apiKey?: unknown;
      apiHost?: unknown;
    };
    return {
      enabled: parsed.enabled === true,
      // apiKey / apiHost are derived from `mmx` at request time, not stored.
      // Empty strings here mean "use whatever the mmx CLI says".
      apiKey: '',
      apiHost: DEFAULT_API_HOST,
      tts: normalizeTtsSettings(parsed.tts),
    };
  } catch (error) {
    console.warn('[MiniMax] Failed to read settings:', error instanceof Error ? error.message : error);
    return { ...DEFAULT_SETTINGS, tts: { ...DEFAULT_TTS_SETTINGS } };
  }
}

function writeSettings(settings: MiniMaxSettings): MiniMaxSettings {
  // Persist ONLY `enabled` + `tts`. apiKey/apiHost are intentionally
  // dropped because the user manages them in the mmx CLI, not the UI.
  const persisted: PersistedMiniMaxSettings = {
    enabled: settings.enabled === true,
    tts: normalizeTtsSettings(settings.tts),
  };
  appConfigDb.set(MINIMAX_SETTINGS_KEY, JSON.stringify(persisted));
  return {
    enabled: persisted.enabled,
    apiKey: settings.apiKey,
    apiHost: settings.apiHost,
    tts: persisted.tts,
  };
}

function probeUvx(): boolean {
  try {
    const result = spawnSync('which', ['uvx'], { timeout: UVX_PROBE_TIMEOUT_MS });
    return result.status === 0 && Boolean(result.stdout?.toString().trim());
  } catch {
    return false;
  }
}

function probeMmx(): boolean {
  try {
    const result = spawnSync('which', [MMX_BIN], { timeout: MMX_PROBE_TIMEOUT_MS });
    return result.status === 0 && Boolean(result.stdout?.toString().trim());
  } catch {
    return false;
  }
}

type MmxCredentials = {
  apiKey: string;
  apiHost: string;
  method: 'api-key' | 'oauth' | 'unknown';
  /** Masked key for UI display (e.g. `sk-c...C5g0`). */
  maskedKey: string;
};

let mmxCredsCache: { value: MmxCredentials | null; expiresAt: number } | null = null;

function readMmxCredentials(): MmxCredentials | null {
  const now = Date.now();
  if (mmxCredsCache && mmxCredsCache.expiresAt > now) {
    return mmxCredsCache.value;
  }
  if (!probeMmx()) {
    mmxCredsCache = { value: null, expiresAt: now + MMX_CREDS_CACHE_TTL_MS };
    return null;
  }
  const r = runner(MMX_BIN, MMX_CONFIG_ARGS);
  if (r.error || r.status !== 0 || !r.stdout) {
    mmxCredsCache = { value: null, expiresAt: now + MMX_CREDS_CACHE_TTL_MS };
    return null;
  }
  try {
    const parsed = JSON.parse(r.stdout) as {
      api_key?: unknown;
      base_url?: unknown;
    };
    const apiKey = typeof parsed.api_key === 'string' ? parsed.api_key : '';
    const apiHost =
      typeof parsed.base_url === 'string' && parsed.base_url.length > 0
        ? parsed.base_url
        : DEFAULT_API_HOST;
    if (apiKey.length === 0) {
      mmxCredsCache = { value: null, expiresAt: now + MMX_CREDS_CACHE_TTL_MS };
      return null;
    }
    const maskedKey = apiKey.length > 8
      ? `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`
      : '••••';
    const value: MmxCredentials = {
      apiKey,
      apiHost,
      method: apiKey.startsWith('sk-') ? 'api-key' : 'oauth',
      maskedKey,
    };
    mmxCredsCache = { value, expiresAt: now + MMX_CREDS_CACHE_TTL_MS };
    return value;
  } catch {
    mmxCredsCache = { value: null, expiresAt: now + MMX_CREDS_CACHE_TTL_MS };
    return null;
  }
}

function maskApiKey(value: string): string {
  if (value.length <= 8) {
    return '••••';
  }
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}

function parseUsageJson(stdout: string): ModelRemain[] | null {
  try {
    const parsed = JSON.parse(stdout) as { model_remains?: unknown };
    if (!parsed || !Array.isArray(parsed.model_remains)) {
      return null;
    }
    return parsed.model_remains.filter(isModelRemain);
  } catch {
    return null;
  }
}

function isModelRemain(value: unknown): value is ModelRemain {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return typeof entry.model_name === 'string';
}

function hasUsableCredentials(): boolean {
  // Credentials live in the `mmx` CLI, not the DB. `readMmxCredentials()`
  // returns null if mmx is missing, not authenticated, or its config is
  // unreadable.
  return readMmxCredentials() !== null;
}

export const minimaxService = {
  async getSettings(): Promise<MiniMaxSettings> {
    // Augment the persisted settings with whatever the mmx CLI reports
    // (apiKey + apiHost). The PUT endpoint also accepts these, but the
    // canonical source is the CLI — see `readMmxCredentials()`.
    const persisted = readSettings();
    const creds = readMmxCredentials();
    return {
      ...persisted,
      apiKey: creds?.apiKey ?? '',
      apiHost: creds?.apiHost ?? persisted.apiHost,
    };
  },

  async updateSettings(input: Partial<MiniMaxSettings>): Promise<MiniMaxSettings> {
    const current = readSettings();
    const next: MiniMaxSettings = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      // apiKey / apiHost come from the mmx CLI. We accept the payload in
      // the PUT body for backward compatibility with the legacy form, but
      // we do NOT persist them — the user manages the key in mmx.
      apiKey: typeof input.apiKey === 'string' ? input.apiKey : current.apiKey,
      apiHost:
        typeof input.apiHost === 'string' && input.apiHost.length > 0
          ? input.apiHost
          : current.apiHost,
      tts: normalizeTtsSettings({
        ...current.tts,
        ...(input.tts && typeof input.tts === 'object' ? input.tts : {}),
      }),
    };

    const persisted = writeSettings(next);

    if (persisted.enabled && !current.enabled) {
      if (!hasUsableCredentials()) {
        // Roll back the persistence so the toggle cannot be left in a half-on state.
        writeSettings({ ...persisted, enabled: false });
        throw new Error(
          'MiniMax cannot be enabled without an authenticated mmx CLI. Run `mmx auth login` (or `mmx auth login --api-key <key>`) on the server, then try again.',
        );
      }
      await this.registerAgentMcp();
    } else if (!persisted.enabled && current.enabled) {
      await this.unregisterAgentMcp();
    } else if (persisted.enabled && current.enabled) {
      // Already enabled; the credentials live in the mmx CLI, so re-register
      // whenever the user explicitly re-toggles or we can't tell. The MCP
      // env block is small enough that a redundant write is harmless.
      await this.registerAgentMcp();
    }

    return persisted;
  },

  async getStatus(): Promise<{
    enabled: boolean;
    uvxAvailable: boolean;
    mmxInstalled: boolean;
    mmxAuthenticated: boolean;
    apiKeyConfigured: boolean;
    available: boolean;
    message: string;
  }> {
    const settings = readSettings();
    const uvxAvailable = probeUvx();
    const mmxInstalled = probeMmx();
    const creds = readMmxCredentials();
    const mmxAuthenticated = creds !== null;
    const apiKeyConfigured = mmxAuthenticated;
    const available = settings.enabled && uvxAvailable && mmxInstalled && mmxAuthenticated;

    let message: string;
    if (!settings.enabled) {
      message = 'MiniMax is disabled in settings.';
    } else if (!mmxInstalled) {
      message = 'The `mmx` CLI is not on PATH. Install it (https://mmx.ai/install) and restart the server.';
    } else if (!mmxAuthenticated) {
      message = '`mmx` is installed but not authenticated. Run `mmx auth login` on the server.';
    } else if (!uvxAvailable) {
      message = '`uvx` is not on PATH. Install uv (https://docs.astral.sh/uv/) and restart the server.';
    } else {
      message = 'MiniMax MCP is registered and ready.';
    }

    return {
      enabled: settings.enabled,
      uvxAvailable,
      mmxInstalled,
      mmxAuthenticated,
      apiKeyConfigured,
      available,
      message,
    };
  },

  /**
   * Returns the credentials the server should use to talk to the MiniMax
   * API. Source of truth is the `mmx` CLI (typically `~/.mmx/config.json`).
   * Returns `null` when the CLI is missing or not authenticated.
   *
   * Cached for `MMX_CREDS_CACHE_TTL_MS` (60s) per process; pass
   * `{ force: true }` to bypass (used by the manual Refresh button).
   */
  async getMmxCredentials(opts: { force?: boolean } = {}): Promise<{
    installed: boolean;
    authenticated: boolean;
    apiKey: string;
    maskedKey: string;
    apiHost: string;
    method: 'api-key' | 'oauth' | 'unknown';
    message: string;
  }> {
    if (opts.force) {
      mmxCredsCache = null;
    }
    const installed = probeMmx();
    const creds = installed ? readMmxCredentials() : null;
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        apiKey: '',
        maskedKey: '',
        apiHost: DEFAULT_API_HOST,
        method: 'unknown',
        message: '`mmx` is not on PATH. Install it (https://mmx.ai/install) on the server.',
      };
    }
    if (!creds) {
      return {
        installed: true,
        authenticated: false,
        apiKey: '',
        maskedKey: '',
        apiHost: DEFAULT_API_HOST,
        method: 'unknown',
        message: '`mmx` is installed but not authenticated. Run `mmx auth login` on the server.',
      };
    }
    return {
      installed: true,
      authenticated: true,
      apiKey: creds.apiKey,
      maskedKey: creds.maskedKey,
      apiHost: creds.apiHost,
      method: creds.method,
      message: 'mmx is authenticated and ready.',
    };
  },

  async registerAgentMcp(): Promise<{
    name: string;
    command: string;
    args: string[];
    results: Array<{ provider: string; created: boolean; error?: string }>;
  }> {
    const creds = readMmxCredentials();
    if (!creds) {
      throw new Error(
        'mmx is not authenticated. Run `mmx auth login` on the server before enabling MiniMax.',
      );
    }
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command: MCP_COMMAND,
      args: [...MCP_ARGS],
      env: {
        MINIMAX_API_KEY: creds.apiKey,
        MINIMAX_API_HOST: creds.apiHost,
      },
    });
    return { name: MCP_SERVER_NAME, command: MCP_COMMAND, args: [...MCP_ARGS], results };
  },

  async unregisterAgentMcp(): Promise<{
    name: string;
    results: Array<{ provider: string; removed: boolean; error?: string }>;
  }> {
    const results = await providerMcpService.removeMcpServerFromAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
    });
    return { name: MCP_SERVER_NAME, results };
  },

  /**
   * Read the Token Plan quota snapshot from the `mmx` CLI.
   *
   * Returns a discriminated union: `available: true` carries parsed
   * `model_remains[]`; `available: false` carries a `reason` so the UI can
   * pick between "install mmx" and "run `mmx auth login`" copy.
   *
   * Cached for `USAGE_CACHE_TTL_MS` (60s) per process. Pass `{ force: true }`
   * to bypass (used by the manual Refresh button and by tests).
   */
  async getUsage(opts: { force?: boolean } = {}): Promise<UsageResult> {
    const now = Date.now();
    if (!opts.force && usageCache && usageCache.expiresAt > now) {
      return usageCache.result;
    }

    let result: UsageResult;
    if (!probeMmx()) {
      result = {
        available: false,
        source: 'unavailable',
        fetchedAt: now,
        model_remains: [],
        reason: 'missing-cli',
      };
    } else {
      const r = runner(MMX_BIN, MMX_QUOTA_ARGS);
      if (r.error || r.status !== 0 || !r.stdout) {
        result = {
          available: false,
          source: 'unavailable',
          fetchedAt: now,
          model_remains: [],
          reason: 'cli-error',
        };
      } else {
        const parsed = parseUsageJson(r.stdout);
        if (parsed === null) {
          result = {
            available: false,
            source: 'unavailable',
            fetchedAt: now,
            model_remains: [],
            reason: 'cli-error',
          };
        } else {
          result = { available: true, source: 'mmx', fetchedAt: now, model_remains: parsed };
        }
      }
    }

    usageCache = { result, expiresAt: now + USAGE_CACHE_TTL_MS };
    return result;
  },

  /**
   * Resolve the TTS sub-config the voice proxy should use.
   *
   * Returns `null` when TTS is disabled at the feature level OR when the
   * `mmx` CLI is not authenticated (i.e. there is nothing to call against).
   * The voice proxy interprets `null` as "fall back to the OpenAI-compatible
   * backend".
   *
   * Credentials always come from the mmx CLI — never from `app_config`.
   */
  async getTtsConfig(): Promise<{
    enabled: boolean;
    apiKey: string;
    apiHost: string;
    model: string;
    voice: string;
    format: string;
  } | null> {
    const s = readSettings();
    if (!s.tts.enabled) {
      return null;
    }
    const creds = readMmxCredentials();
    if (!creds) {
      return null;
    }
    return {
      enabled: true,
      apiKey: creds.apiKey,
      apiHost: creds.apiHost,
      model: s.tts.model,
      voice: s.tts.voice,
      format: s.tts.format,
    };
  },

  /**
   * Synthesise `text` to audio bytes via `mmx speech synthesize`. Used by
   * the voice proxy as an alternate backend when the user enables MiniMax
   * for TTS. Shells `mmx` directly so we don't pay the round-trip through
   * a long-poll HTTP client; `mmx` itself talks to the MiniMax TTS API.
   *
   * Returns `{ audio, format }` where `audio` is the raw bytes (mp3/pcm/
   * flac/wav/opus) and `format` is the format string the proxy should use
   * to set `Content-Type`. Throws on spawn failure or non-zero status; the
   * proxy maps the error to 502.
   */
  async synthesizeText(input: {
    text: string;
    voice?: string;
    model?: string;
    format?: string;
  }): Promise<{ audio: Buffer; format: string }> {
    const cfg = readSettings();
    if (!cfg.tts.enabled) {
      throw new Error('MiniMax TTS is not enabled in settings.');
    }
    if (!readMmxCredentials()) {
      throw new Error('mmx is not authenticated. Run `mmx auth login` on the server.');
    }
    const text = String(input.text || '').trim();
    if (!text) {
      throw new Error('MiniMax TTS received an empty text payload.');
    }
    if (text.length > 10_000) {
      // `mmx speech synthesize` caps synchronous input at 10k chars. Caller
      // should chunk first; we throw so the proxy can return 413.
      throw new Error(
        `MiniMax TTS input exceeds the 10000 character limit (got ${text.length}).`,
      );
    }
    const format = String(input.format ?? cfg.tts.format).trim() || 'mp3';
    const voice = String(input.voice ?? cfg.tts.voice).trim();
    const model = String(input.model ?? cfg.tts.model).trim();

    const args = [
      'speech',
      'synthesize',
      '--non-interactive',
      // `--stream` makes `mmx` emit raw audio bytes to stdout. Without it the
      // CLI saves the file to disk and prints a JSON manifest with the saved
      // path + size — useless for an HTTP streaming proxy.
      '--stream',
      '--text',
      text,
      '--voice',
      voice,
      '--model',
      model,
      '--format',
      format,
    ];

    const r = runner(MMX_BIN, args);
    if (r.error || r.status !== 0 || !r.stdout) {
      // Prefer stderr — `mmx speech synthesize` prints structured JSON like
      // `{"error":{"code":1,"message":"API error: voice id not exist"}}` there
      // when the API rejects the request. Fall back to the spawn error if
      // stderr is empty (CLI never launched at all).
      const stderrSnippet = r.stderr?.trim()
        || r.error?.message
        || 'mmx exited non-zero without further diagnostics';
      throw new Error(`MiniMax TTS failed: ${stderrSnippet}`);
    }
    return { audio: Buffer.from(r.stdout, 'binary'), format };
  },
};

// Test seams. Underscore-prefixed names signal "do not import from production
// code". __clearUsageCacheForTests resets BOTH the quota cache and the
// mmx-credentials cache; __setUsageRunnerForTests swaps the spawn runner
// so tests can inject canned stdout (used by quota, mmx config show, and
// mmx speech synthesize) without touching node:child_process.
export function __clearUsageCacheForTests(): void {
  usageCache = null;
  mmxCredsCache = null;
}

export function __setUsageRunnerForTests(fn: SpawnRunner | null): void {
  runner = fn ?? defaultRunner;
}
