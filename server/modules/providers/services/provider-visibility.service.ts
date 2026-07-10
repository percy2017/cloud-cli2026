import { ENABLED_PROVIDER_ORDER } from '@/modules/providers/config.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/**
 * Single seam through which every provider-visibility decision flows.
 *
 * The service reads from the env-backed `ENABLED_PROVIDER_ORDER` constant
 * (cached at module load) and exposes three operations:
 *
 * - `listEnabledIds()` — the canonical, operator-ordered id list.
 * - `assertEnabled(id)` — throws `AppError { code: 'PROVIDER_DISABLED', 403 }`
 *   so disabled providers fail fast at route boundaries.
 * - `listProviders(registry?)` — filters the full provider registry by
 *   `listEnabledIds()`, preserving configured order.
 *
 * The registry still owns all six concrete provider classes even when they
 * are disabled; existing sessions for disabled providers stay reachable via
 * direct API calls (`/api/providers/cursor/capabilities` returns 403, but
 * `/api/projects/...` reads/writes that already reference an old
 * `provider: 'cursor'` session continue to work because they never go
 * through this seam).
 */
class ProviderVisibilityService {
  private readonly enabledIds: ReadonlyArray<LLMProvider>;
  private readonly enabledIdSet: ReadonlySet<LLMProvider>;

  constructor(order: ReadonlyArray<LLMProvider> = ENABLED_PROVIDER_ORDER) {
    this.enabledIds = [...order];
    this.enabledIdSet = new Set(this.enabledIds);
  }

  /**
   * Returns the operator-configured provider list in operator-defined order.
   *
   * The returned array is a fresh copy so callers may sort or splice without
   * mutating the cached module-level state.
   */
  listEnabledIds(): LLMProvider[] {
    return [...this.enabledIds];
  }

  /**
   * Returns true when the provider id appears in the configured order.
   *
   * Use this for soft UI hints (e.g. hiding a tab) and for the
   * `enable-on-session-start` heuristic. For hard HTTP/API rejection at
   * route boundaries prefer `assertEnabled`.
   */
  isEnabled(provider: LLMProvider): boolean {
    return this.enabledIdSet.has(provider);
  }

  /**
   * Throws when `provider` is not in the configured enabled list.
   *
   * Routes call this immediately after `parseProvider()` so disabled
   * providers fail with a stable, machine-readable `403 PROVIDER_DISABLED`
   * instead of an opaque 404 or 500.
   */
  assertEnabled(provider: LLMProvider): void {
    if (!this.isEnabled(provider)) {
      throw new AppError(
        `Provider "${provider}" is not enabled by PROVIDER_ENABLED_ORDER.`,
        {
          code: 'PROVIDER_DISABLED',
          statusCode: 403,
        },
      );
    }
  }

  /**
   * Filters the registry to the enabled providers in operator order.
   *
   * Defaults to the singleton `providerRegistry` so the common call site
   * stays a one-liner, while tests can inject a custom registry (or none)
   * to assert filter behaviour without instantiating all six provider
   * classes.
   */
  listProviders(registry?: { listProviders(): IProvider[] }): IProvider[] {
    const source = registry ?? providerRegistry;
    const enabledSet = new Set(this.enabledIds);

    const filtered = source
      .listProviders()
      .filter((provider) => enabledSet.has(provider.id));

    const orderIndex = new Map<LLMProvider, number>();
    this.enabledIds.forEach((id, index) => {
      orderIndex.set(id, index);
    });

    return filtered.sort(
      (left, right) =>
        (orderIndex.get(left.id as LLMProvider) ?? Number.MAX_SAFE_INTEGER)
        - (orderIndex.get(right.id as LLMProvider) ?? Number.MAX_SAFE_INTEGER),
    );
  }
}

export const providerVisibilityService = new ProviderVisibilityService();

/**
 * Factory used by tests to instantiate a service against an arbitrary
 * `process.env.PROVIDER_ENABLED_ORDER` snapshot. Production code uses the
 * `providerVisibilityService` singleton — re-creating the service at runtime
 * would diverge from the cached module-level config.
 */
export function createProviderVisibilityServiceForTests(
  order: ReadonlyArray<LLMProvider>,
): ProviderVisibilityService {
  return new ProviderVisibilityService(order);
}

export type { ProviderVisibilityService };
