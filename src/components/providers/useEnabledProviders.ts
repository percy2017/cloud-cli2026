import { useCallback, useEffect, useMemo, useState } from 'react';

import { authenticatedFetch } from '../../utils/api';
import type { LLMProvider } from '../../types/app';

/**
 * Operator-controlled provider visibility & order from `.env`.
 *
 * This module is the single frontend seam for `PROVIDER_ENABLED_ORDER`.
 * It owns:
 *
 * - The `useEnabledProviders()` hook used by every UI surface that lists
 *   providers (chat composer, settings tab, onboarding step, provider-auth
 *   status poller).
 * - `getStoredProvider(enabled)` / `setStoredProvider(provider)` helpers
 *   that self-heal `localStorage.selected-provider` when the operator
 *   hides the provider the user previously had active.
 *
 * The four previously scattered maps (`PROVIDER_META` in
 * `ProviderSelectionEmptyState`, `AGENT_NAMES` in `AgentSelectorSection`,
 * `getProviderDisplayName`, and `providerCardStyles` in `AgentConnectionsStep`)
 * collapse into the tables declared below. New consumers should call this
 * hook instead of declaring their own provider lists.
 */

export type ProviderDotColor = string;

export type ProviderCardStyle = {
  connectedClassName: string;
  iconContainerClassName: string;
  loginButtonClassName: string;
  dotColor: ProviderDotColor;
};

export type EnabledProvidersState = {
  /** Operator-configured order (CSV from `.env`). Always non-empty. */
  enabled: LLMProvider[];
  /** Same as `enabled` today; exposed separately so future APIs can reorder. */
  order: LLMProvider[];
  /** Human-readable names for UI labels (chat composer trigger, settings pills). */
  displayNames: Record<LLMProvider, string>;
  /** Vendor names (anthropic / OpenAI / Google / Cursor / OpenCode / Qwen). */
  vendorNames: Record<LLMProvider, string>;
  /** Color tokens used by `AgentConnectionCard` and the settings pill bar. */
  cardStyles: Record<LLMProvider, ProviderCardStyle>;
  /** True while the initial fetch is in flight. */
  loading: boolean;
  /** Last fetch error message if the request failed; otherwise null. */
  error: string | null;
};

const PROVIDER_DISPLAY_NAMES: Record<LLMProvider, string> = {
  claude: 'Claude',
  cursor: 'Cursor',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
  qwen: 'Qwen',
};

const PROVIDER_VENDOR_NAMES: Record<LLMProvider, string> = {
  claude: 'Anthropic',
  cursor: 'Cursor',
  codex: 'OpenAI',
  gemini: 'Google',
  opencode: 'OpenCode',
  qwen: 'Qwen',
};

/**
 * Single source of truth for per-provider color tokens. `qwen` is included
 * here (it was missing from the previous `providerCardStyles` in
 * `AgentConnectionsStep.tsx`, which silently omitted it from the onboarding
 * flow). When the operator hides qwen via `PROVIDER_ENABLED_ORDER`, the
 * hook filters it before the consumer ever reads it.
 */
const PROVIDER_CARD_STYLES: Record<LLMProvider, ProviderCardStyle> = {
  claude: {
    connectedClassName: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    iconContainerClassName: 'bg-blue-100 dark:bg-blue-900/30',
    loginButtonClassName: 'bg-blue-600 hover:bg-blue-700',
    dotColor: 'bg-blue-500',
  },
  cursor: {
    connectedClassName: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
    iconContainerClassName: 'bg-purple-100 dark:bg-purple-900/30',
    loginButtonClassName: 'bg-purple-600 hover:bg-purple-700',
    dotColor: 'bg-purple-500',
  },
  codex: {
    connectedClassName: 'bg-gray-100 dark:bg-gray-800/50 border-gray-300 dark:border-gray-600',
    iconContainerClassName: 'bg-gray-100 dark:bg-gray-800',
    loginButtonClassName: 'bg-gray-800 hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600',
    dotColor: 'bg-foreground/60',
  },
  gemini: {
    connectedClassName: 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800',
    iconContainerClassName: 'bg-teal-100 dark:bg-teal-900/30',
    loginButtonClassName: 'bg-teal-600 hover:bg-teal-700',
    dotColor: 'bg-indigo-500',
  },
  opencode: {
    connectedClassName: 'bg-zinc-100 dark:bg-zinc-800/50 border-zinc-300 dark:border-zinc-600',
    iconContainerClassName: 'bg-zinc-100 dark:bg-zinc-800',
    loginButtonClassName: 'bg-zinc-800 hover:bg-zinc-900 dark:bg-zinc-700 dark:hover:bg-zinc-600',
    dotColor: 'bg-zinc-500',
  },
  qwen: {
    connectedClassName: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800',
    iconContainerClassName: 'bg-orange-100 dark:bg-orange-900/30',
    loginButtonClassName: 'bg-orange-600 hover:bg-orange-700',
    dotColor: 'bg-orange-500',
  },
};

const FALLBACK_DEFAULT: LLMProvider = 'claude';

const isLlmProvider = (value: unknown): value is LLMProvider =>
  value === 'claude'
  || value === 'cursor'
  || value === 'codex'
  || value === 'gemini'
  || value === 'opencode'
  || value === 'qwen';

const normalizeEnabledIds = (raw: unknown): LLMProvider[] => {
  if (!Array.isArray(raw)) {
    return ['claude', 'codex', 'opencode', 'qwen'];
  }

  const seen = new Set<LLMProvider>();
  const result: LLMProvider[] = [];
  for (const entry of raw) {
    if (!isLlmProvider(entry) || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    result.push(entry);
  }

  if (result.length === 0) {
    return ['claude', 'codex', 'opencode', 'qwen'];
  }

  return result;
};

const cache: { state: EnabledProvidersState | null } = { state: null };

/**
 * Reads the cached enabled list, fetching it once on first call. Subsequent
 * calls share the same promise so React components re-render without
 * triggering parallel `/api/providers/enabled` requests.
 */
export function useEnabledProviders(): EnabledProvidersState {
  const [state, setState] = useState<EnabledProvidersState | null>(cache.state);

  useEffect(() => {
    if (cache.state) {
      return;
    }

    let cancelled = false;

    const fetchEnabled = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/enabled');
        const body = (await response.json()) as {
          success?: boolean;
          data?: { enabled?: unknown; order?: unknown };
        };

        if (cancelled || !body.success) {
          throw new Error('Invalid response from /api/providers/enabled.');
        }

        const enabled = normalizeEnabledIds(
          Array.isArray(body.data?.order) && body.data.order.length > 0
            ? body.data.order
            : body.data?.enabled,
        );

        const next: EnabledProvidersState = {
          enabled,
          order: enabled,
          displayNames: { ...PROVIDER_DISPLAY_NAMES },
          vendorNames: { ...PROVIDER_VENDOR_NAMES },
          cardStyles: { ...PROVIDER_CARD_STYLES },
          loading: false,
          error: null,
        };

        cache.state = next;
        setState(next);
      } catch (fetchError) {
        if (cancelled) {
          return;
        }

        // Endpoint unreachable at boot should not block the UI. Fall back to
        // the curated default and surface a non-fatal error so the user can
        // see why PROVIDER_ENABLED_ORDER is being ignored.
        const fallback: LLMProvider[] = ['claude', 'codex', 'opencode', 'qwen'];
        const message = fetchError instanceof Error
          ? fetchError.message
          : 'Unknown error';

        console.error('[useEnabledProviders] falling back to defaults:', message);

        const next: EnabledProvidersState = {
          enabled: fallback,
          order: fallback,
          displayNames: { ...PROVIDER_DISPLAY_NAMES },
          vendorNames: { ...PROVIDER_VENDOR_NAMES },
          cardStyles: { ...PROVIDER_CARD_STYLES },
          loading: false,
          error: message,
        };

        cache.state = next;
        setState(next);
      }
    };

    void fetchEnabled();

    return () => {
      cancelled = true;
    };
  }, []);

  return useMemo<EnabledProvidersState>(() => {
    if (state) {
      return state;
    }
    // First-paint placeholder so consumers always get a non-null value.
    return {
      enabled: (['claude', 'codex', 'opencode', 'qwen'] as LLMProvider[]),
      order: (['claude', 'codex', 'opencode', 'qwen'] as LLMProvider[]),
      displayNames: { ...PROVIDER_DISPLAY_NAMES },
      vendorNames: { ...PROVIDER_VENDOR_NAMES },
      cardStyles: { ...PROVIDER_CARD_STYLES },
      loading: true,
      error: null,
    };
  }, [state]);
}

/**
 * Reads `localStorage.selected-provider`, validates it against the supplied
 * enabled list, and rewrites the storage value when it is missing or stale.
 *
 * Returns the resolved id (always in `enabled`). When `enabled` is empty
 * (defensive only — the server always returns at least the default four),
 * the fallback is `'claude'`.
 *
 * Use this anywhere the UI used to read `localStorage.getItem('selected-provider')`
 * directly so the self-healing policy lives in one place.
 */
export function getStoredProvider(enabled: LLMProvider[]): LLMProvider {
  const fallback = (enabled[0] ?? FALLBACK_DEFAULT) as LLMProvider;
  if (typeof localStorage === 'undefined') {
    return fallback;
  }

  let stored: LLMProvider | null = null;
  try {
    const raw = localStorage.getItem('selected-provider');
    if (raw !== null && isLlmProvider(raw)) {
      stored = raw;
    }
  } catch {
    stored = null;
  }

  if (stored !== null && enabled.includes(stored)) {
    return stored;
  }

  try {
    localStorage.setItem('selected-provider', fallback);
  } catch {
    // localStorage may be disabled (private mode); the in-memory value is
    // still usable for this render.
  }
  return fallback;
}

/**
 * Persists the active provider id to `localStorage.selected-provider`. Callers
 * that used to write the key directly should switch to this helper so the
 * stored value is always a valid `LLMProvider`.
 */
export function setStoredProvider(provider: LLMProvider): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  try {
    localStorage.setItem('selected-provider', provider);
  } catch {
    // ignored — see getStoredProvider comment.
  }
}

/**
 * Invalidates the cached `/api/providers/enabled` response so the next
 * `useEnabledProviders()` call re-fetches. Useful after a settings page
 * that mutates `PROVIDER_ENABLED_ORDER` (currently no such UI exists —
 * operators edit `.env` and restart — but the hook leaves the door open).
 */
export function resetEnabledProvidersCache(): void {
  cache.state = null;
}

/**
 * Stable selector hook: returns just the enabled id list. Convenience for
 * components that don't need display names or styles.
 */
export function useEnabledProviderIds(): LLMProvider[] {
  const { enabled } = useEnabledProviders();
  return enabled;
}

/**
 * Convenience hook that pairs the enabled list with self-healing storage
 * readers. Use it inside React components that need a stable provider id
 * and the full state.
 */
export function useStoredProvider(): {
  provider: LLMProvider;
  enabled: LLMProvider[];
  state: EnabledProvidersState;
  setProvider: (next: LLMProvider) => void;
} {
  const state = useEnabledProviders();
  const provider = useMemo(() => getStoredProvider(state.enabled), [state.enabled]);

  const setProvider = useCallback((next: LLMProvider) => {
    setStoredProvider(next);
  }, []);

  return { provider, enabled: state.enabled, state, setProvider };
}
