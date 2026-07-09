import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import spawn from 'cross-spawn';

import type { IProviderAuth } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderAuthStatus } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

type QwenCredentialsStatus = {
  authenticated: boolean;
  email: string | null;
  method: string | null;
  error?: string;
};

// Qwen Code 0.19.7 removed `qwen auth`. Auth via env vars or direct edit
// of ~/.qwen/settings.json (apiKey + baseUrl).
const QWEN_ENV_CREDENTIAL_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
];

export class QwenProviderAuth implements IProviderAuth {
  /**
   * Checks whether the Qwen CLI is available to the server process.
   */
  private checkInstalled(): boolean {
    try {
      const result = spawn.sync('qwen', ['--version'], { stdio: 'ignore', timeout: 5000 });
      return !result.error && result.status === 0;
    } catch {
      return false;
    }
  }

  /**
   * Returns Qwen CLI installation and credential status.
   *
   * Qwen 0.19.7 has no `auth login` command — credentials come from either
   * ~/.qwen/settings.json (top-level apiKey / model providers) or env vars.
   */
  async getStatus(): Promise<ProviderAuthStatus> {
    const installed = this.checkInstalled();
    const credentials = await this.checkCredentials();

    return {
      installed,
      provider: 'qwen',
      authenticated: credentials.authenticated,
      email: credentials.email,
      method: credentials.method,
      error: credentials.authenticated ? undefined : credentials.error || 'Not authenticated',
    };
  }

  /**
   * Reads Qwen's settings.json for embedded credentials, or falls back to env vars.
   */
  private async checkCredentials(): Promise<QwenCredentialsStatus> {
    try {
      const settingsPath = path.join(os.homedir(), '.qwen', 'settings.json');
      const content = await readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(content);
      const settings = readObjectRecord(parsed) ?? {};

      // Top-level apiKey (used by Qwen's default model provider).
      const topLevelApiKey = readOptionalString(settings.apiKey)
        ?? readOptionalString(settings.api_key);
      if (topLevelApiKey) {
        return {
          authenticated: true,
          email: 'qwen-api-key',
          method: 'settings_file',
        };
      }

      // Nested modelProviders map. Qwen 0.19.x has TWO shapes:
      //   (a) legacy:    { modelProviders: { openai: { apiKey: "..." } } }   (object inline)
      //   (b) current:   { modelProviders: { anthropic: [{ envKey: "QWEN_CUSTOM_API_KEY_...",
      //                                                   baseUrl: "..." }] },
      //                    env: { QWEN_CUSTOM_API_KEY_...: "sk-cp-..." } }
      //
      // Shape (b) is what `qwen auth` actually writes when you swap providers — the
      // real key lives in `settings.env[<envKey>]` (the array entry just points to it
      // by name). We must look in BOTH places or `qwen` shows as "not configured"
      // even though `qwen` itself runs fine.
      const modelProviders = readObjectRecord(settings.modelProviders)
        ?? readObjectRecord(settings.model_providers);
      const envMap = readObjectRecord(settings.env) ?? {};

      if (modelProviders) {
        for (const [providerName, providerConfig] of Object.entries(modelProviders)) {
          const records = this.extractProviderRecords(providerConfig);
          for (const record of records) {
            // Shape (a): inline apiKey on the object itself
            const inlineApiKey = readOptionalString(record.apiKey)
              ?? readOptionalString(record.api_key);
            if (inlineApiKey) {
              return {
                authenticated: true,
                email: `${providerName} credentials`,
                method: 'settings_file',
              };
            }
            // Shape (b): envKey pointer → settings.env[envKey]
            const envKey = readOptionalString(record.envKey)
              ?? readOptionalString(record.env_key);
            if (envKey) {
              const envValue = readOptionalString(envMap[envKey])
                ?? readOptionalString(process.env[envKey]);
              if (envValue) {
                return {
                  authenticated: true,
                  email: `${providerName} credentials`,
                  method: 'settings_file',
                };
              }
            }
          }
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        return {
          authenticated: false,
          email: null,
          method: null,
          error: error instanceof Error ? error.message : 'Failed to read Qwen settings',
        };
      }
    }

    const envCredential = QWEN_ENV_CREDENTIAL_KEYS.find((key) => process.env[key]?.trim());
    if (envCredential) {
      return {
        authenticated: true,
        email: envCredential,
        method: 'environment',
      };
    }

    return {
      authenticated: false,
      email: null,
      method: null,
      error: 'Qwen not configured',
    };
  }

  /**
   * Normalises the `modelProviders[name]` entry into an array of record-like
   * objects. Handles both shapes:
   *   - object inline: `{ apiKey: "..." }`  → `[record]`
   *   - array of configs: `[{ envKey: "..." }, ...]`  → `[records]`
   *
   * Anything else (string, null, malformed) returns `[]` so the caller just
   * moves on to the next provider.
   */
  private extractProviderRecords(providerConfig: unknown): AnyRecord[] {
    const asObject = readObjectRecord(providerConfig);
    if (asObject) {
      return [asObject];
    }
    if (Array.isArray(providerConfig)) {
      const records: AnyRecord[] = [];
      for (const entry of providerConfig) {
        const record = readObjectRecord(entry);
        if (record) records.push(record);
      }
      return records;
    }
    return [];
  }
}