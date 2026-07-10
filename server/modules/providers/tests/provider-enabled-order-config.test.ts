import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENABLED_PROVIDER_ORDER,
  parseProviderEnabledOrderForTests,
} from '@/modules/providers/config.js';
import type { LLMProvider } from '@/shared/types.js';

const isFullDefault = (ids: readonly LLMProvider[]): boolean => {
  const defaultIds: LLMProvider[] = ['claude', 'codex', 'opencode', 'qwen'];
  if (ids.length !== defaultIds.length) {
    return false;
  }
  for (let i = 0; i < defaultIds.length; i += 1) {
    if (ids[i] !== defaultIds[i]) {
      return false;
    }
  }
  return true;
};

test('default order is claude, codex, opencode, qwen when env var is unset', () => {
  const parsed = parseProviderEnabledOrderForTests(undefined);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0], 'claude');
  assert.equal(parsed[1], 'codex');
  assert.equal(parsed[2], 'opencode');
  assert.equal(parsed[3], 'qwen');
  assert.deepEqual(parsed, [...parsed]);
  // dedupe-invariant: no duplicates
  assert.equal(new Set(parsed).size, parsed.length);
});

test('exported module-level cache matches the default when no env override is configured', () => {
  // The test runner runs against the same process the module is loaded into,
  // so an unset env translates into the default list.
  assert.equal(isFullDefault(ENABLED_PROVIDER_ORDER), true);
});

test('csv order is preserved verbatim (operators control order)', () => {
  const parsed = parseProviderEnabledOrderForTests('claude,qwen,codex,opencode');
  assert.deepEqual(parsed, ['claude', 'qwen', 'codex', 'opencode']);
});

test('cursor and gemini are honoured when explicitly enabled', () => {
  const parsed = parseProviderEnabledOrderForTests(
    'claude,codex,cursor,gemini,opencode,qwen',
  );
  assert.deepEqual(parsed, ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'qwen']);
});

test('whitespace around tokens is tolerated', () => {
  const parsed = parseProviderEnabledOrderForTests('  claude , codex ,opencode  , qwen  ');
  assert.deepEqual(parsed, ['claude', 'codex', 'opencode', 'qwen']);
});

test('uppercase ids are lowercased', () => {
  const parsed = parseProviderEnabledOrderForTests('CLAUDE,Codex,OpenCode,QWEN');
  assert.deepEqual(parsed, ['claude', 'codex', 'opencode', 'qwen']);
});

test('duplicate ids collapse to a single occurrence while preserving first-seen order', () => {
  const parsed = parseProviderEnabledOrderForTests('claude,codex,claude,opencode,codex');
  assert.deepEqual(parsed, ['claude', 'codex', 'opencode']);
});

test('unknown ids are ignored while valid neighbours stay', () => {
  const parsed = parseProviderEnabledOrderForTests('claude,foo,codex,bar,qwen');
  assert.deepEqual(parsed, ['claude', 'codex', 'qwen']);
});

test('empty string falls back to the default list', () => {
  const parsed = parseProviderEnabledOrderForTests('');
  assert.equal(isFullDefault(parsed), true);
});

test('only-separators string falls back to the default list', () => {
  const parsed = parseProviderEnabledOrderForTests(',,, ,');
  assert.equal(isFullDefault(parsed), true);
});

test('all-unknown ids fall back to the default list', () => {
  const parsed = parseProviderEnabledOrderForTests('foo,bar,baz');
  assert.equal(isFullDefault(parsed), true);
});

test('parseProviderEnabledOrderForTests restores the previous env value', () => {
  parseProviderEnabledOrderForTests('claude');
  const parsedAfter = parseProviderEnabledOrderForTests(undefined);
  assert.equal(isFullDefault(parsedAfter), true);
});
