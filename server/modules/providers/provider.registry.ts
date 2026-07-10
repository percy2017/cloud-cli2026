import { ClaudeProvider } from '@/modules/providers/list/claude/claude.provider.js';
import { CodexProvider } from '@/modules/providers/list/codex/codex.provider.js';
import { CursorProvider } from '@/modules/providers/list/cursor/cursor.provider.js';
import { GeminiProvider } from '@/modules/providers/list/gemini/gemini.provider.js';
import { OpenCodeProvider } from '@/modules/providers/list/opencode/opencode.provider.js';
import { QwenProvider } from '@/modules/providers/list/qwen/qwen.provider.js';
import { providerVisibilityService } from '@/modules/providers/services/provider-visibility.service.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Concrete provider instances for every supported id.
 *
 * All six are always instantiated so direct `resolveProvider(id)` lookups
 * keep working for existing sessions of providers that the operator may have
 * later hidden via `PROVIDER_ENABLED_ORDER`. Visibility filtering happens
 * at the consumer (`providerVisibilityService.listProviders`) — never by
 * mutating this record.
 */
const providers: Record<LLMProvider, IProvider> = {
  claude: new ClaudeProvider(),
  codex: new CodexProvider(),
  cursor: new CursorProvider(),
  gemini: new GeminiProvider(),
  opencode: new OpenCodeProvider(),
  qwen: new QwenProvider(),
};

/**
 * Central registry for resolving concrete provider implementations by id.
 *
 * `listProviders()` filters and orders results through the
 * `PROVIDER_ENABLED_ORDER` visibility seam so disabled providers stay out of
 * UI/API listings. `resolveProvider(id)` continues to resolve every id so
 * sessions that already reference a now-hidden provider still load.
 */
export const providerRegistry = {
  listProviders(): IProvider[] {
    return providerVisibilityService.listProviders({
      listProviders: () => Object.values(providers),
    });
  },

  resolveProvider(provider: string): IProvider {
    const key = provider as LLMProvider;
    const resolvedProvider = providers[key];
    if (!resolvedProvider) {
      throw new AppError(`Unsupported provider "${provider}".`, {
        code: 'UNSUPPORTED_PROVIDER',
        statusCode: 400,
      });
    }

    return resolvedProvider;
  },
};
