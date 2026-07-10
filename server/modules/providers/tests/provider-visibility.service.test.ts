import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderVisibilityServiceForTests,
  providerVisibilityService,
} from '@/modules/providers/services/provider-visibility.service.js';
import { AppError } from '@/shared/utils.js';
import type { IProvider } from '@/shared/interfaces.js';
import type { LLMProvider } from '@/shared/types.js';

const makeProvider = (id: LLMProvider): IProvider =>
  ({
    id,
    models: {} as IProvider['models'],
    mcp: {} as IProvider['mcp'],
    auth: {} as IProvider['auth'],
    skills: {} as IProvider['skills'],
    sessions: {} as IProvider['sessions'],
    sessionSynchronizer: {} as IProvider['sessionSynchronizer'],
  });

const fakeRegistry = (ids: LLMProvider[]) => ({
  listProviders: () => ids.map(makeProvider),
});

test('default singleton exposes the configured default order', () => {
  assert.deepEqual(providerVisibilityService.listEnabledIds(), [
    'claude',
    'codex',
    'opencode',
    'qwen',
  ]);
});

test('listEnabledIds returns a fresh copy so callers can mutate safely', () => {
  const service = createProviderVisibilityServiceForTests(['claude', 'qwen']);
  const first = service.listEnabledIds();
  first.push('cursor');
  const second = service.listEnabledIds();
  assert.deepEqual(second, ['claude', 'qwen']);
  assert.equal(first.length, 3);
  assert.equal(second.length, 2);
});

test('isEnabled reports membership against the configured order', () => {
  const service = createProviderVisibilityServiceForTests([
    'claude',
    'codex',
    'opencode',
    'qwen',
  ]);
  assert.equal(service.isEnabled('claude'), true);
  assert.equal(service.isEnabled('codex'), true);
  assert.equal(service.isEnabled('opencode'), true);
  assert.equal(service.isEnabled('qwen'), true);
  assert.equal(service.isEnabled('cursor'), false);
  assert.equal(service.isEnabled('gemini'), false);
});

test('assertEnabled passes silently for enabled providers', () => {
  const service = createProviderVisibilityServiceForTests(['claude']);
  assert.doesNotThrow(() => service.assertEnabled('claude'));
});

test('assertEnabled throws AppError 403 PROVIDER_DISABLED for hidden providers', () => {
  const service = createProviderVisibilityServiceForTests([
    'claude',
    'codex',
    'opencode',
    'qwen',
  ]);
  try {
    service.assertEnabled('cursor');
    assert.fail('expected assertEnabled to throw');
  } catch (caught) {
    assert.ok(caught instanceof AppError);
    assert.equal((caught as AppError).statusCode, 403);
    assert.equal((caught as AppError).code, 'PROVIDER_DISABLED');
    assert.match((caught as AppError).message, /cursor/);
  }
});

test('listProviders filters out disabled ids', () => {
  const service = createProviderVisibilityServiceForTests([
    'claude',
    'codex',
    'opencode',
    'qwen',
  ]);
  const allIds: LLMProvider[] = [
    'claude',
    'codex',
    'cursor',
    'gemini',
    'opencode',
    'qwen',
  ];
  const result = service.listProviders(fakeRegistry(allIds));
  assert.deepEqual(
    result.map((p) => p.id),
    ['claude', 'codex', 'opencode', 'qwen'],
  );
});

test('listProviders preserves operator-configured order, ignoring registry order', () => {
  const service = createProviderVisibilityServiceForTests([
    'qwen',
    'claude',
    'opencode',
    'codex',
  ]);
  const registryIds: LLMProvider[] = [
    'claude',
    'codex',
    'cursor',
    'gemini',
    'opencode',
    'qwen',
  ];
  const result = service.listProviders(fakeRegistry(registryIds));
  assert.deepEqual(
    result.map((p) => p.id),
    ['qwen', 'claude', 'opencode', 'codex'],
  );
});

test('listProviders handles an empty registry by returning an empty list', () => {
  const service = createProviderVisibilityServiceForTests(['claude', 'qwen']);
  const result = service.listProviders(fakeRegistry([]));
  assert.deepEqual(result, []);
});
