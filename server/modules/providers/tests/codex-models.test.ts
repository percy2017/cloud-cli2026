import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderModels, CODEX_FALLBACK_MODELS } from '@/modules/providers/list/codex/codex-models.provider.js';

const REAL_CODEX_DIR = path.join(process.env.HOME || '/root', '.codex');
const REAL_CACHE = path.join(REAL_CODEX_DIR, 'models_cache.json');
const REAL_CONFIG = path.join(REAL_CODEX_DIR, 'config.toml');

/**
 * Each test starts with a clean `~/.codex/` (no cache, no config) and only
 * writes the files it needs. The test runner cleans up after each test via
 * the returned teardown function.
 */
const setupCleanCodexDir = (t: { after: (fn: () => void) => void }) => {
  // Stash any existing files so the test starts deterministic.
  const stashDir = mkdtempSync(path.join(tmpdir(), 'codex-models-test-'));
  const stashedCache = existsSync(REAL_CACHE) ? (renameSync(REAL_CACHE, path.join(stashDir, 'models_cache.json')), path.join(stashDir, 'models_cache.json')) : null;
  const stashedConfig = existsSync(REAL_CONFIG) ? (renameSync(REAL_CONFIG, path.join(stashDir, 'config.toml')), path.join(stashDir, 'config.toml')) : null;
  mkdirSync(REAL_CODEX_DIR, { recursive: true });
  t.after(() => {
    rmSync(REAL_CACHE, { force: true });
    rmSync(REAL_CONFIG, { force: true });
    if (stashedCache) renameSync(stashedCache, REAL_CACHE);
    if (stashedConfig) renameSync(stashedConfig, REAL_CONFIG);
    rmSync(stashDir, { recursive: true, force: true });
  });
};

test('CodexProviderModels.getSupportedModels falls back to CODEX_FALLBACK_MODELS when no cache and no config.toml model', async (t) => {
  setupCleanCodexDir(t);
  const models = new CodexProviderModels();
  const def = await models.getSupportedModels();
  assert.deepEqual(def, CODEX_FALLBACK_MODELS);
});

test('CodexProviderModels.getSupportedModels promotes config.toml#model to DEFAULT when no cache (custom model_provider)', async (t) => {
  setupCleanCodexDir(t);
  // Synthetic config: third-party proxy via `model_provider = "minimax"`,
  // so the only model the upstream recognises is `MiniMax-M3`.
  writeFileSync(REAL_CONFIG, 'model = "MiniMax-M3"\nmodel_provider = "minimax"\n');

  const models = new CodexProviderModels();
  const def = await models.getSupportedModels();
  assert.equal(def.DEFAULT, 'MiniMax-M3', 'config.toml model should be the DEFAULT');
  assert.equal(def.OPTIONS[0]?.value, 'MiniMax-M3', 'config.toml model should be the first option');
});

test('CodexProviderModels.getSupportedModels keeps the dynamic cache as the source of truth when present', async (t) => {
  setupCleanCodexDir(t);
  writeFileSync(REAL_CONFIG, 'model = "gpt-5.4"\n');
  writeFileSync(
    REAL_CACHE,
    JSON.stringify({
      models: [
        { slug: 'gpt-5', display_name: 'GPT-5', priority: 0, supported_in_api: true },
        { slug: 'o3', display_name: 'o3', priority: 1, supported_in_api: true },
      ],
    }),
  );

  const models = new CodexProviderModels();
  const def = await models.getSupportedModels();
  assert.equal(def.DEFAULT, 'gpt-5', 'cache DEFAULT is the cache[0], not config.toml');
  assert.equal(def.OPTIONS.length, 2);
});
