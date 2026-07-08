import { access, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';
import toml from '@iarna/toml';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type CodexCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

export class CodexProviderAuth implements IProviderAuth {
  /**
   * Checks whether Codex is available to the server runtime.
   */
  private checkInstalled(): boolean {
    try {
      spawn.sync('codex', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Returns Codex SDK availability and credential status.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'codex',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Checks Codex credentials in priority order:
   *
   *   1. `~/.codex/auth.json`        — OAuth tokens (`tokens.id_token`,
   *      `tokens.access_token`) or a top-level `OPENAI_API_KEY` fallback
   *      (`method: 'credentials_file' | 'api_key'`).
   *   2. `~/.codex/config.toml`      — TOML config; recognised when it contains
   *      an `OPENAI_API_KEY = "..."` key or a provider entry under
   *      `[providers.*]` with credentials wired up
   *      (`method: 'config_toml'`).
   *   3. `process.env.OPENAI_API_KEY` — environment-only setups
   *      (`method: 'env_var'`).
   *
   * If all three sources are empty/missing, emits `'Codex not configured'`.
   */
  private async checkCredentials(): Promise<CodexCredentialsStatus> {
    const authFile = await this.readAuthJson();
    if (authFile) return authFile;

    const configFile = await this.readConfigToml();
    if (configFile) return configFile;

    const envFile = this.readEnvCredentials();
    if (envFile) return envFile;

    return { authenticated: false, email: null, method: null, error: 'Codex not configured' };
  }

  /**
   * Reads ~/.codex/auth.json and surfaces OAuth tokens or an embedded API key.
   * Returns `null` when the file is missing or unreadable so the caller can
   * fall back to the next source.
   */
  private async readAuthJson(): Promise<CodexCredentialsStatus | null> {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    let content: string;
    try {
      content = await readFile(authPath, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return null;
    }

    const auth = readObjectRecord(parsed) ?? {};
    const tokens = readObjectRecord(auth.tokens) ?? {};
    const idToken = readOptionalString(tokens.id_token);
    const accessToken = readOptionalString(tokens.access_token);

    if (idToken || accessToken) {
      return {
        authenticated: true,
        email: idToken ? this.readEmailFromIdToken(idToken) : 'Authenticated',
        method: 'credentials_file',
      };
    }

    if (readOptionalString(auth.OPENAI_API_KEY)) {
      return { authenticated: true, email: 'API Key Auth', method: 'api_key' };
    }

    return null;
  }

  /**
   * Reads ~/.codex/config.toml and surfaces any recognisable credential:
   *
   *   - top-level `OPENAI_API_KEY` (or `openai_api_key`)
   *   - top-level `experimental_bearer_token` (used by Codex CLI for custom
   *     providers)
   *   - a `[providers.*]` entry with `apiKey` / `OPENAI_API_KEY`
   *   - a `[model_providers.*]` entry (the schema Codex CLI actually emits
   *     for custom endpoints like `[model_providers.minimax]`) with any of
   *     `experimental_bearer_token`, `api_key`, or `OPENAI_API_KEY`
   *
   * Returns `null` when the file is missing, unreadable, or carries none of
   * the above so the caller can fall through to the env-var source.
   */
  private async readConfigToml(): Promise<CodexCredentialsStatus | null> {
    const configPath = path.join(os.homedir(), '.codex', 'config.toml');
    if (!(await this.pathExists(configPath))) return null;

    let parsed: unknown;
    try {
      parsed = toml.parse(await readFile(configPath, 'utf8'));
    } catch {
      return null;
    }

    const root = readObjectRecord(parsed);
    if (!root) return null;

    if (hasCredentialKey(root)) {
      return { authenticated: true, email: 'API Key Auth (config.toml)', method: 'config_toml' };
    }

    const providerBlocks = [readObjectRecord(root.providers), readObjectRecord(root.model_providers)];
    for (const block of providerBlocks) {
      if (!block) continue;
      for (const [, value] of Object.entries(block)) {
        if (hasCredentialKey(readObjectRecord(value) ?? {})) {
          return { authenticated: true, email: 'API Key Auth (config.toml)', method: 'config_toml' };
        }
      }
    }

    return null;
  }

  /**
   * Returns credentials when `process.env.OPENAI_API_KEY` (or equivalent
   * OpenAI-style env wiring) is present. Pure synchronous read.
   */
  private readEnvCredentials(): CodexCredentialsStatus | null {
    const apiKey =
      process.env.OPENAI_API_KEY ??
      process.env.OPENAI_KEY ??
      process.env.CODEX_API_KEY;
    if (!apiKey) return null;

    return {
      authenticated: true,
      email: 'API Key Auth (env)',
      method: 'env_var',
    };
  }

  /**
   * Tiny `fs.access`-backed existence probe for the TOML check.
   */
  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extracts the user email from a Codex id_token when a readable JWT payload exists.
   */
  private readEmailFromIdToken(idToken: string): string {
    try {
      const parts = idToken.split('.');
      if (parts.length >= 2) {
        const payload = readObjectRecord(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
        return readOptionalString(payload?.email) ?? readOptionalString(payload?.user) ?? 'Authenticated';
      }
    } catch {
      // Fall back to a generic authenticated marker if the token payload is not readable.
    }

    return 'Authenticated';
  }
}

/**
 * Returns true when a parsed TOML fragment carries any of the credential
 * field names Codex recognises (OpenAI-style keys plus the
 * `experimental_bearer_token` slot used for custom model providers).
 */
function hasCredentialKey(fragment: Record<string, unknown>): boolean {
  if (readOptionalString(fragment.OPENAI_API_KEY)) return true;
  if (readOptionalString(fragment.openai_api_key)) return true;
  if (readOptionalString(fragment.apiKey)) return true;
  if (readOptionalString(fragment.api_key)) return true;
  if (readOptionalString(fragment.experimental_bearer_token)) return true;
  return false;
}
