/**
 * Environment Flag: Is Platform
 * Indicates if the app is running in Platform mode (hosted) or OSS mode (self-hosted)
 */
export const IS_PLATFORM = import.meta.env.VITE_IS_PLATFORM === 'true';

/**
 * Context window reported in the Token Usage modal.
 *
 * Reads `VITE_CONTEXT_WINDOW` from `.env` so the operator controls the value
 * the UI shows regardless of what the backend process happens to inherit.
 * Falls back to `200_000` (the real Claude Sonnet/Opus/Haiku window) when
 * the Vite build did not expose the variable — same default the backend
 * uses (`server/shared/context-window.ts#DEFAULT_CLAUDE_CONTEXT_WINDOW`).
 */
const VITE_CONTEXT_WINDOW_RAW = import.meta.env.VITE_CONTEXT_WINDOW;
const PARSED_CONTEXT_WINDOW = Number.parseInt(VITE_CONTEXT_WINDOW_RAW ?? '', 10);
export const CONTEXT_WINDOW = Number.isFinite(PARSED_CONTEXT_WINDOW) && PARSED_CONTEXT_WINDOW > 0
  ? PARSED_CONTEXT_WINDOW
  : 200_000;

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
export const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};