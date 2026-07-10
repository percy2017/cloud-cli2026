import type { LLMProvider } from '@/shared/types.js';

/**
 * Operator-controlled provider visibility & order.
 *
 * Reads `PROVIDER_ENABLED_ORDER` from the environment (CSV of `LLMProvider`
 * ids, lowercased, whitespace tolerated). The result is cached at module
 * load time and exposed as `ENABLED_PROVIDER_ORDER`. Ids not in `LLMProvider`
 * are ignored with a `console.warn` so a typo never breaks startup. An
 * empty/unset variable falls back to a curated default that hides
 * in-development providers (`cursor`, `gemini`) so operators must opt in
 * explicitly to expose them.
 *
 * The loader assumes `process.env` has already been populated by
 * `server/load-env.js` — `server/index.js` imports that module as its very
 * first statement before any provider imports run.
 */
const VALID_PROVIDER_IDS: ReadonlySet<LLMProvider> = new Set([
  'claude',
  'codex',
  'cursor',
  'gemini',
  'opencode',
  'qwen',
]);

const DEFAULT_PROVIDER_ORDER: readonly LLMProvider[] = [
  'claude',
  'codex',
  'opencode',
  'qwen',
];

function parseEnabledOrder(): LLMProvider[] {
  const raw = process.env.PROVIDER_ENABLED_ORDER;

  if (raw == null) {
    return [...DEFAULT_PROVIDER_ORDER];
  }

  if (raw.trim() === '') {
    console.warn(
      '[provider-visibility] PROVIDER_ENABLED_ORDER is empty — falling back to the default order. ' +
        'Set it in .env to override which providers the UI exposes.',
    );
    return [...DEFAULT_PROVIDER_ORDER];
  }

  const parsed: LLMProvider[] = [];
  const seen = new Set<LLMProvider>();
  for (const token of raw.split(',')) {
    const id = token.trim().toLowerCase() as LLMProvider;
    if (!id) {
      continue;
    }

    if (!VALID_PROVIDER_IDS.has(id)) {
      console.warn(
        `[provider-visibility] ignoring unknown provider id "${token}" in PROVIDER_ENABLED_ORDER.`,
      );
      continue;
    }

    if (seen.has(id)) {
      continue;
    }

    seen.add(id);
    parsed.push(id);
  }

  if (parsed.length === 0) {
    console.warn(
      '[provider-visibility] PROVIDER_ENABLED_ORDER produced an empty list (all entries were ' +
        'rejected as unknown ids) — falling back to the default order.',
    );
    return [...DEFAULT_PROVIDER_ORDER];
  }

  return parsed;
}

/**
 * Resolved list of enabled providers in operator-configured order.
 *
 * Re-evaluation requires a server restart; the value is captured once at
 * module load time because `process.env` does not change between requests in
 * a long-running Node process and re-parsing on every call would mask
 * malformed configuration with a stale fallback.
 */
export const ENABLED_PROVIDER_ORDER: ReadonlyArray<LLMProvider> = parseEnabledOrder();

/**
 * Public re-parse hook for tests that need to swap `process.env` between
 * runs. Production callers should not invoke this — `ENABLED_PROVIDER_ORDER`
 * is the single source of truth at runtime.
 */
export function parseProviderEnabledOrderForTests(
  rawValue: string | undefined,
): LLMProvider[] {
  const previous = process.env.PROVIDER_ENABLED_ORDER;
  if (rawValue === undefined) {
    delete process.env.PROVIDER_ENABLED_ORDER;
  } else {
    process.env.PROVIDER_ENABLED_ORDER = rawValue;
  }

  try {
    return parseEnabledOrder();
  } finally {
    if (previous === undefined) {
      delete process.env.PROVIDER_ENABLED_ORDER;
    } else {
      process.env.PROVIDER_ENABLED_ORDER = previous;
    }
  }
}
