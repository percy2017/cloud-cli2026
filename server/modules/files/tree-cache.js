/**
 * In-memory cache for project file-tree responses.
 *
 * The Files tab's tree endpoint (`GET /api/projects/:projectId/files`) walks
 * the directory tree from disk on every request. For projects with thousands
 * of files (e.g. this repo: ~1,148 files / 250 folders without `node_modules`)
 * that adds seconds of latency to every tab open. Since most re-opens of the
 * tab happen within seconds of the previous open, a short-TTL cache makes
 * those requests effectively free.
 *
 * Key shape: `${projectId}::${depth}::${showHidden}`.
 * - `projectId` so per-project isolation is free.
 * - `depth` / `showHidden` are part of the request — different shapes cache
 *   separately so we never return the wrong tree shape.
 *
 * Invalidation:
 * - Explicit `invalidate(projectId)` from any handler that mutates the
 *   project's filesystem (create / rename / delete / upload).
 * - TTL (default 30s) so any mutation the server doesn't catch (external
 *   editors, git pull, etc.) self-heals quickly.
 *
 * Stays in process memory intentionally — restarting the server rebuilds the
 * tree on first request, which is fine because the cache is just an
 * optimization, not a correctness requirement.
 */

const DEFAULT_TTL_MS = 30_000;

export class FileTreeCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, { value: unknown, expiresAt: number }>} */
    this.entries = new Map();
    /** Aggregate counters for log lines and verification. */
    this.stats = { hits: 0, misses: 0, invalidations: 0, expired: 0 };
  }

  _key(projectId, depth, showHidden) {
    return `${projectId}::${depth}::${showHidden ? 'h' : '-'}`;
  }

  /**
   * @returns {unknown | undefined} the cached value if present and not expired.
   */
  get(projectId, depth, showHidden) {
    const key = this._key(projectId, depth, showHidden);
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      this.stats.expired += 1;
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    return entry.value;
  }

  /**
   * Store `value` for the given (projectId, depth, showHidden) shape,
   * overwriting any previous entry.
   */
  set(projectId, depth, showHidden, value) {
    const key = this._key(projectId, depth, showHidden);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * Drop every cached entry for `projectId`. Called by mutation handlers
   * (create / rename / delete / upload) so the next tree fetch reflects the
   * change instead of returning stale data.
   */
  invalidate(projectId) {
    if (!projectId) return;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${projectId}::`)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      this.stats.invalidations += removed;
    }
  }

  /**
   * Drop everything. Useful in tests; not wired into any request path.
   */
  clear() {
    this.entries.clear();
  }
}

// Singleton — one process, one cache. Exported as `treeCache` for routes to
// import. Tests can construct their own instance via the class export.
export const treeCache = new FileTreeCache();
