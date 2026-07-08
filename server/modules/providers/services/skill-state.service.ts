/**
 * Per-provider skill enable/disable state.
 *
 * Persists a small JSON blob in `app_config` keyed by `disabled_skills`. The
 * blob maps `LLMProvider` → `sourcePath` → `true`. The blob is the source of
 * truth for which provider skills the user has toggled off; the provider facets
 * apply it during `listSkills` to mark entries with `enabled: false`.
 *
 * Mirrors the `MiniMax` JSON-blob pattern (see `modules/minimax/minimax.service.ts`).
 */

import { appConfigDb } from '@/modules/database/index.js';
import type { LLMProvider, ProviderSkill } from '@/shared/types.js';

const DISABLED_SKILLS_KEY = 'disabled_skills';

type DisabledSkillsBlob = Partial<Record<LLMProvider, Record<string, true>>>;

function readBlob(): DisabledSkillsBlob {
  const raw = appConfigDb.get(DISABLED_SKILLS_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    const result: DisabledSkillsBlob = {};
    for (const [provider, byKey] of Object.entries(parsed)) {
      if (!byKey || typeof byKey !== 'object') {
        continue;
      }

      const normalized: Record<string, true> = {};
      for (const [key, value] of Object.entries(byKey as Record<string, unknown>)) {
        if (typeof key === 'string' && key.length > 0 && value === true) {
          normalized[key] = true;
        }
      }

      if (Object.keys(normalized).length > 0) {
        result[provider as LLMProvider] = normalized;
      }
    }

    return result;
  } catch {
    return {};
  }
}

function writeBlob(blob: DisabledSkillsBlob): void {
  // Strip empty inner maps so the blob stays compact.
  const cleaned: DisabledSkillsBlob = {};
  for (const [provider, byKey] of Object.entries(blob)) {
    if (byKey && Object.keys(byKey).length > 0) {
      cleaned[provider as LLMProvider] = byKey;
    }
  }
  appConfigDb.set(DISABLED_SKILLS_KEY, JSON.stringify(cleaned));
}

export const skillStateService = {
  /** Returns the set of disabled `sourcePath` keys for a provider. */
  readDisabledSet(provider: LLMProvider): Set<string> {
    const blob = readBlob();
    return new Set(Object.keys(blob[provider] ?? {}));
  },

  /** Returns the full disabled-keys array for a provider (useful for tests / bulk UI). */
  listDisabledKeys(provider: LLMProvider): string[] {
    return Array.from(this.readDisabledSet(provider));
  },

  /**
   * Adds or removes a single skill from the disabled set.
   *
   * `enabled: false` adds the key; `enabled: true` removes it. Idempotent in both
   * directions. The `sourcePath` is the canonical key — callers must pass exactly
   * what came back from `listSkills` to avoid drift.
   */
  setSkillEnabled(provider: LLMProvider, sourcePath: string, enabled: boolean): void {
    if (!sourcePath || typeof sourcePath !== 'string') {
      return;
    }

    const blob = readBlob();
    const current = blob[provider] ?? {};

    if (enabled) {
      delete current[sourcePath];
    } else {
      current[sourcePath] = true;
    }

    blob[provider] = current;
    writeBlob(blob);
  },

  /**
   * Bulk on/off for every skill in the supplied list. Calculates the current set
   * from disk, then either empties it (`enabled: true`) or adds every supplied
   * key (`enabled: false`). Skills not present in `skills` are untouched when
   * enabling, and removed when disabling.
   */
  setAllSkillsEnabled(provider: LLMProvider, skills: ProviderSkill[], enabled: boolean): void {
    const blob = readBlob();
    const current = { ...(blob[provider] ?? {}) };

    if (enabled) {
      // Enable: remove every key currently listed (user said "all visible on").
      // We only act on keys that match currently-listed skills so we don't leave
      // stale entries in the blob.
      for (const skill of skills) {
        delete current[skill.sourcePath];
      }
    } else {
      // Disable: add every currently-listed skill.
      for (const skill of skills) {
        current[skill.sourcePath] = true;
      }
    }

    blob[provider] = current;
    writeBlob(blob);
  },

  /** Test-only helper. Clears all disabled state for every provider. */
  resetForTests(): void {
    appConfigDb.set(DISABLED_SKILLS_KEY, JSON.stringify({}));
  },
};