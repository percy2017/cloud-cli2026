import assert from 'node:assert/strict';
import test from 'node:test';

// IMPORTANT: import the service before the modules that touch the database,
// so monkey-patches below can intercept the appConfigDb construction if needed.
import { minimaxService } from '@/modules/minimax/minimax.service.js';
import { appConfigDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';

const MINIMAX_SETTINGS_KEY = 'minimax_settings';
const TEST_API_KEY = 'sk-cp-test-1234567890abcdef';
const TEST_API_HOST = 'https://api.test.minimax.io';

function setSettings(partial: Record<string, unknown>) {
  const current = appConfigDb.get(MINIMAX_SETTINGS_KEY);
  const base = current ? JSON.parse(current) : {};
  appConfigDb.set(MINIMAX_SETTINGS_KEY, JSON.stringify({ ...base, ...partial }));
}

function clearSettings() {
  appConfigDb.set(MINIMAX_SETTINGS_KEY, JSON.stringify({}));
}

test('getSettings returns defaults when nothing is persisted', async () => {
  clearSettings();
  const settings = await minimaxService.getSettings();
  assert.equal(settings.enabled, false);
  assert.equal(settings.apiKey, '');
  assert.equal(settings.apiHost, 'https://api.minimax.io');
});

test('getSettings returns the persisted shape', async () => {
  setSettings({ enabled: true, apiKey: TEST_API_KEY, apiHost: TEST_API_HOST });
  const settings = await minimaxService.getSettings();
  assert.equal(settings.enabled, true);
  assert.equal(settings.apiKey, TEST_API_KEY);
  assert.equal(settings.apiHost, TEST_API_HOST);
});

test('updateSettings enabled=true calls addMcpServerToAllProviders with the stdio payload', async () => {
  clearSettings();
  setSettings({ apiKey: TEST_API_KEY, apiHost: TEST_API_HOST });

  const original = providerMcpService.addMcpServerToAllProviders;
  let captured: any = null;
  providerMcpService.addMcpServerToAllProviders = (async (input: any) => {
    captured = input;
    return [{ provider: 'claude', created: true }];
  }) as typeof original;

  try {
    const next = await minimaxService.updateSettings({ enabled: true });
    assert.equal(next.enabled, true);
    assert.equal(next.apiKey, TEST_API_KEY);

    assert.ok(captured, 'addMcpServerToAllProviders was not called');
    assert.equal(captured.name, 'cloudcli-minimax');
    assert.equal(captured.scope, 'user');
    assert.equal(captured.transport, 'stdio');
    assert.equal(captured.command, 'uvx');
    assert.deepEqual(captured.args, ['minimax-coding-plan-mcp', '-y']);
    assert.equal(captured.env.MINIMAX_API_KEY, TEST_API_KEY);
    assert.equal(captured.env.MINIMAX_API_HOST, TEST_API_HOST);
  } finally {
    providerMcpService.addMcpServerToAllProviders = original;
    clearSettings();
  }
});

test('updateSettings enabled=true without an API key throws and does not register', async () => {
  clearSettings();

  const original = providerMcpService.addMcpServerToAllProviders;
  let calls = 0;
  providerMcpService.addMcpServerToAllProviders = (async () => {
    calls += 1;
    return [];
  }) as typeof original;

  try {
    await assert.rejects(
      () => minimaxService.updateSettings({ enabled: true }),
      /API key/,
    );
    assert.equal(calls, 0, 'dispatcher should not be called without a key');

    // Persistence must be rolled back so the toggle is not half-on.
    const after = await minimaxService.getSettings();
    assert.equal(after.enabled, false);
  } finally {
    providerMcpService.addMcpServerToAllProviders = original;
    clearSettings();
  }
});

test('updateSettings enabled=false calls removeMcpServerFromAllProviders', async () => {
  setSettings({ enabled: true, apiKey: TEST_API_KEY, apiHost: TEST_API_HOST });

  const originalRemove = providerMcpService.removeMcpServerFromAllProviders;
  let captured: any = null;
  providerMcpService.removeMcpServerFromAllProviders = (async (input: any) => {
    captured = input;
    return [{ provider: 'claude', removed: true }];
  }) as typeof originalRemove;

  try {
    const next = await minimaxService.updateSettings({ enabled: false });
    assert.equal(next.enabled, false);
    assert.ok(captured, 'removeMcpServerFromAllProviders was not called');
    assert.equal(captured.name, 'cloudcli-minimax');
    assert.equal(captured.scope, 'user');
  } finally {
    providerMcpService.removeMcpServerFromAllProviders = originalRemove;
    clearSettings();
  }
});

test('updateSettings already enabled but credentials changed re-registers', async () => {
  setSettings({ enabled: true, apiKey: 'sk-old', apiHost: TEST_API_HOST });

  const originalAdd = providerMcpService.addMcpServerToAllProviders;
  let addCalls = 0;
  providerMcpService.addMcpServerToAllProviders = (async () => {
    addCalls += 1;
    return [];
  }) as typeof originalAdd;

  try {
    await minimaxService.updateSettings({ apiKey: TEST_API_KEY });
    assert.equal(addCalls, 1, 're-registration should happen when apiKey changes');
  } finally {
    providerMcpService.addMcpServerToAllProviders = originalAdd;
    clearSettings();
  }
});

test('getStatus reflects persistence + uvx probe', async () => {
  clearSettings();
  setSettings({ apiKey: TEST_API_KEY, apiHost: TEST_API_HOST });
  // enabled stays false here

  const status = await minimaxService.getStatus();
  assert.equal(status.enabled, false);
  assert.equal(status.apiKeyConfigured, true);
  assert.equal(status.uvxAvailable, true); // uvx is on PATH in this environment
  assert.equal(status.available, false); // not enabled
  assert.match(status.message, /disabled/i);

  clearSettings();
});
