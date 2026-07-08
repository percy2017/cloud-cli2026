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
const MMX_TIMEOUT_MS = 8_000;
const MMX_PROBE_TIMEOUT_MS = 5_000;
const MMX_BIN = 'mmx';
const MMX_QUOTA_ARGS = ['quota', 'show', '--output', 'json', '--non-interactive'];

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
type SpawnResult = { status: number | null; stdout: string; error?: Error };
type SpawnRunner = (cmd: string, args: string[]) => SpawnResult;
const defaultRunner: SpawnRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { timeout: MMX_TIMEOUT_MS, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', error: r.error ?? undefined };
};
let runner: SpawnRunner = defaultRunner;

type MiniMaxSettings = {
  enabled: boolean;
  apiKey: string;
  apiHost: string;
};

const DEFAULT_SETTINGS: MiniMaxSettings = {
  enabled: false,
  apiKey: '',
  apiHost: DEFAULT_API_HOST,
};

function readSettings(): MiniMaxSettings {
  try {
    const raw = appConfigDb.get(MINIMAX_SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<MiniMaxSettings>;
    return {
      enabled: parsed.enabled === true,
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      apiHost:
        typeof parsed.apiHost === 'string' && parsed.apiHost.length > 0
          ? parsed.apiHost
          : DEFAULT_API_HOST,
    };
  } catch (error) {
    console.warn('[MiniMax] Failed to read settings:', error instanceof Error ? error.message : error);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: MiniMaxSettings): MiniMaxSettings {
  const normalized: MiniMaxSettings = {
    enabled: settings.enabled === true,
    apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : '',
    apiHost:
      typeof settings.apiHost === 'string' && settings.apiHost.length > 0
        ? settings.apiHost
        : DEFAULT_API_HOST,
  };
  appConfigDb.set(MINIMAX_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
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

function hasUsableCredentials(settings: MiniMaxSettings): boolean {
  return settings.apiKey.length > 0;
}

export const minimaxService = {
  async getSettings(): Promise<MiniMaxSettings> {
    return readSettings();
  },

  async updateSettings(input: Partial<MiniMaxSettings>): Promise<MiniMaxSettings> {
    const current = readSettings();
    const next: MiniMaxSettings = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      apiKey: typeof input.apiKey === 'string' ? input.apiKey : current.apiKey,
      apiHost:
        typeof input.apiHost === 'string' && input.apiHost.length > 0
          ? input.apiHost
          : current.apiHost,
    };

    const persisted = writeSettings(next);

    if (persisted.enabled && !current.enabled) {
      if (!hasUsableCredentials(persisted)) {
        // Roll back the persistence so the toggle cannot be left in a half-on state.
        writeSettings({ ...persisted, enabled: false });
        throw new Error(
          'MiniMax cannot be enabled without an API key. Set the API key before toggling the feature on.',
        );
      }
      await this.registerAgentMcp();
    } else if (!persisted.enabled && current.enabled) {
      await this.unregisterAgentMcp();
    } else if (persisted.enabled && current.enabled) {
      // Already enabled; if the credentials changed, re-register so the new
      // env is propagated to every provider's MCP config.
      if (input.apiKey !== undefined || input.apiHost !== undefined) {
        await this.registerAgentMcp();
      }
    }

    return persisted;
  },

  async getStatus(): Promise<{
    enabled: boolean;
    uvxAvailable: boolean;
    apiKeyConfigured: boolean;
    available: boolean;
    message: string;
  }> {
    const settings = readSettings();
    const uvxAvailable = probeUvx();
    const apiKeyConfigured = hasUsableCredentials(settings);
    const available = settings.enabled && uvxAvailable && apiKeyConfigured;

    let message: string;
    if (!settings.enabled) {
      message = 'MiniMax is disabled in settings.';
    } else if (!uvxAvailable) {
      message = '`uvx` is not on PATH. Install uv (https://docs.astral.sh/uv/) and restart the server.';
    } else if (!apiKeyConfigured) {
      message = 'MiniMax API key is not configured.';
    } else {
      message = 'MiniMax MCP is registered and ready.';
    }

    return { enabled: settings.enabled, uvxAvailable, apiKeyConfigured, available, message };
  },

  async registerAgentMcp(): Promise<{
    name: string;
    command: string;
    args: string[];
    results: Array<{ provider: string; created: boolean; error?: string }>;
  }> {
    const settings = readSettings();
    if (!hasUsableCredentials(settings)) {
      throw new Error('MiniMax API key is not configured.');
    }
    const results = await providerMcpService.addMcpServerToAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
      transport: 'stdio',
      command: MCP_COMMAND,
      args: [...MCP_ARGS],
      env: {
        MINIMAX_API_KEY: settings.apiKey,
        MINIMAX_API_HOST: settings.apiHost,
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
};

// Test seams. Underscore-prefixed names signal "do not import from production
// code". `__clearUsageCacheForTests` resets the cache slot; `__setUsageRunnerForTests`
// swaps the spawn runner so tests can inject canned stdout without touching
// `node:child_process`.
export function __clearUsageCacheForTests(): void {
  usageCache = null;
}

export function __setUsageRunnerForTests(fn: SpawnRunner | null): void {
  runner = fn ?? defaultRunner;
}
