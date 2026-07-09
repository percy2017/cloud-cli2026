import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QwenProviderModels, QWEN_FALLBACK_MODELS } from '@/modules/providers/list/qwen/qwen-models.provider.js';

const REAL_QWEN_DIR = path.join(process.env.HOME || '/root', '.qwen');
const REAL_SETTINGS = path.join(REAL_QWEN_DIR, 'settings.json');

const setupCleanQwenDir = (t: { after: (fn: () => void) => void }) => {
  const stashDir = mkdtempSync(path.join(tmpdir(), 'qwen-models-test-'));
  const stashedSettings = existsSync(REAL_SETTINGS)
    ? (renameSync(REAL_SETTINGS, path.join(stashDir, 'settings.json')), path.join(stashDir, 'settings.json'))
    : null;
  mkdirSync(REAL_QWEN_DIR, { recursive: true });
  t.after(() => {
    rmSync(REAL_SETTINGS, { force: true });
    if (stashedSettings) renameSync(stashedSettings, REAL_SETTINGS);
    rmSync(stashDir, { recursive: true, force: true });
  });
};

test('QwenProviderModels.getSupportedModels falls back to QWEN_FALLBACK_MODELS when settings.json is missing', async (t) => {
  setupCleanQwenDir(t);
  const models = new QwenProviderModels();
  const def = await models.getSupportedModels();
  assert.deepEqual(def, QWEN_FALLBACK_MODELS);
});

test('QwenProviderModels.getSupportedModels promotes settings.json#model.name to DEFAULT (custom modelProvider)', async (t) => {
  setupCleanQwenDir(t);
  writeFileSync(
    REAL_SETTINGS,
    JSON.stringify({
      modelProviders: { anthropic: [{ id: 'MiniMax-M3', name: 'MiniMax-M3', baseUrl: 'https://api.minimax.io/anthropic' }] },
      security: { auth: { selectedType: 'anthropic' } },
      model: { name: 'MiniMax-M3', baseUrl: 'https://api.minimax.io/anthropic' },
    }),
  );

  const models = new QwenProviderModels();
  const def = await models.getSupportedModels();
  assert.equal(def.DEFAULT, 'MiniMax-M3', 'configured model should be the DEFAULT');
  assert.equal(def.OPTIONS[0]?.value, 'MiniMax-M3', 'configured model should be the first option');
  // Fallback list preserved underneath for users who want to experiment.
  assert.ok(def.OPTIONS.some((o) => o.value === 'qwen3-coder-plus'),
    'fallback OPTIONS must still be present');
});

test('QwenProviderModels.getSupportedModels does not duplicate when settings.json#model.name is already in the fallback list', async (t) => {
  setupCleanQwenDir(t);
  writeFileSync(
    REAL_SETTINGS,
    JSON.stringify({ model: { name: 'qwen3-max', baseUrl: 'https://example.com' } }),
  );

  const models = new QwenProviderModels();
  const def = await models.getSupportedModels();
  assert.equal(def.DEFAULT, 'qwen3-max');
  const occurrences = def.OPTIONS.filter((o) => o.value === 'qwen3-max').length;
  assert.equal(occurrences, 1, 'configured model must not appear twice in OPTIONS');
});
