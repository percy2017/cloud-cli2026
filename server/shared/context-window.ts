/**
 * Single source of truth for the Claude context window reported to the UI.
 *
 * `claude-sdk.js` (WS-emitted `token_budget`) and `server/index.js` (the
 * `/cost` handler) used to hardcode a fallback of `160000` — a literal that
 * does not correspond to any current Anthropic model. Sonnet, Opus, and
 * Haiku all ship a 200k context window. This helper centralizes the lookup:
 *
 * - Reads `process.env.CONTEXT_WINDOW` (set in `.env`, e.g. `1000000`).
 * - Falls back to `DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000` when the env var
 *   is missing, unparseable, or non-positive.
 *
 * Providers other than Claude (gemini, opencode, cursor, qwen) intentionally
 * do NOT call this helper — they either omit `total` from their token-usage
 * response or report `{ unsupported: true }` because they do not surface a
 * real window value.
 */

export const DEFAULT_CLAUDE_CONTEXT_WINDOW = 200_000;

export function resolveContextWindow(): number {
  const raw = process.env.CONTEXT_WINDOW;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return DEFAULT_CLAUDE_CONTEXT_WINDOW;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CLAUDE_CONTEXT_WINDOW;
}