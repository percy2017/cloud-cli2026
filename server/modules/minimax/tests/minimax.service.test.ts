import assert from 'node:assert/strict';
import test from 'node:test';

// IMPORTANT: import the service before the modules that touch the database,
// so monkey-patches below can intercept the appConfigDb construction if needed.
import {
  minimaxService,
  __clearUsageCacheForTests,
  __setUsageRunnerForTests,
} from '@/modules/minimax/minimax.service.js';
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

/**
 * Default mock runner: only `mmx config show` is wired (returns the test
 * key/host). All other mmx commands (quota, speech, auth) get an empty
 * stdout so callers that didn't expect to hit them still get a clean error
 * path. Tests that need a different mock swap in their own runner via
 * __setUsageRunnerForTests.
 */
function defaultMmxRunner(cmd: string, args: string[]) {
  if (cmd === 'mmx' && args[0] === 'config' && args[1] === 'show') {
    return {
      status: 0,
      stdout: JSON.stringify({ api_key: TEST_API_KEY, base_url: TEST_API_HOST }),
      stderr: '',
    };
  }
  return { status: 0, stdout: '', stderr: '' };
}

test('getSettings returns defaults when nothing is persisted', async () => {
  clearSettings();
  __setUsageRunnerForTests(defaultMmxRunner);
  try {
    const settings = await minimaxService.getSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.apiKey, TEST_API_KEY, 'apiKey is read from mmx');
    assert.equal(settings.apiHost, TEST_API_HOST, 'apiHost is read from mmx');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getSettings does NOT persist apiKey/apiHost in the DB', async () => {
  clearSettings();
  setSettings({ enabled: true });
  __setUsageRunnerForTests(defaultMmxRunner);
  try {
    const before = appConfigDb.get(MINIMAX_SETTINGS_KEY);
    await minimaxService.getSettings();
    const after = appConfigDb.get(MINIMAX_SETTINGS_KEY);
    assert.equal(before, after, 'getSettings must be read-only');
    const parsed = JSON.parse(after!);
    assert.equal(parsed.apiKey, undefined, 'apiKey must not be stored in DB');
    assert.equal(parsed.apiHost, undefined, 'apiHost must not be stored in DB');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('updateSettings enabled=true calls addMcpServerToAllProviders with the stdio payload', async () => {
  clearSettings();
  __setUsageRunnerForTests(defaultMmxRunner);

  const original = providerMcpService.addMcpServerToAllProviders;
  let captured: any = null;
  providerMcpService.addMcpServerToAllProviders = (async (input: any) => {
    captured = input;
    return [{ provider: 'claude', created: true }];
  }) as typeof original;

  try {
    const next = await minimaxService.updateSettings({ enabled: true });
    assert.equal(next.enabled, true);

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
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('updateSettings enabled=true without mmx auth throws and does not register', async () => {
  clearSettings();
  // mmx exists but emits no api_key (i.e. not authenticated).
  __setUsageRunnerForTests((cmd, args) =>
    cmd === 'mmx' && args[0] === 'config'
      ? { status: 0, stdout: JSON.stringify({ api_key: '', base_url: TEST_API_HOST }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
  );

  const original = providerMcpService.addMcpServerToAllProviders;
  let calls = 0;
  providerMcpService.addMcpServerToAllProviders = (async () => {
    calls += 1;
    return [];
  }) as typeof original;

  try {
    await assert.rejects(
      () => minimaxService.updateSettings({ enabled: true }),
      /mmx auth login/,
    );
    assert.equal(calls, 0, 'dispatcher should not be called without an mmx key');

    // Persistence must be rolled back so the toggle is not half-on.
    const after = await minimaxService.getSettings();
    assert.equal(after.enabled, false);
  } finally {
    providerMcpService.addMcpServerToAllProviders = original;
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('updateSettings enabled=false calls removeMcpServerFromAllProviders', async () => {
  setSettings({ enabled: true });
  __setUsageRunnerForTests(defaultMmxRunner);

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
  } finally {
    providerMcpService.removeMcpServerFromAllProviders = originalRemove;
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getStatus reports mmx-installed + mmx-authenticated flags', async () => {
  clearSettings();
  __setUsageRunnerForTests(defaultMmxRunner);
  try {
    const status = await minimaxService.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.apiKeyConfigured, true);
    assert.equal(status.uvxAvailable, true); // uvx is on PATH in this environment
    assert.equal(status.mmxInstalled, true);
    assert.equal(status.mmxAuthenticated, true);
    assert.equal(status.available, false); // not enabled
    assert.match(status.message, /disabled/i);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getMmxCredentials returns installed+authenticated when mmx config has api_key', async () => {
  clearSettings();
  __setUsageRunnerForTests(defaultMmxRunner);
  try {
    const creds = await minimaxService.getMmxCredentials();
    assert.equal(creds.installed, true);
    assert.equal(creds.authenticated, true);
    assert.equal(creds.apiKey, TEST_API_KEY);
    assert.equal(creds.apiHost, TEST_API_HOST);
    assert.equal(creds.method, 'api-key');
    assert.match(creds.maskedKey, /^sk-[a-z0-9].+[a-z0-9]$/);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getMmxCredentials returns not-authenticated when mmx config has empty api_key', async () => {
  clearSettings();
  __setUsageRunnerForTests((cmd, args) =>
    cmd === 'mmx' && args[0] === 'config'
      ? { status: 0, stdout: JSON.stringify({ api_key: '', base_url: TEST_API_HOST }), stderr: '' }
      : { status: 0, stdout: '', stderr: '' },
  );
  try {
    const creds = await minimaxService.getMmxCredentials();
    assert.equal(creds.installed, true);
    assert.equal(creds.authenticated, false);
    assert.equal(creds.apiKey, '');
    assert.match(creds.message, /mmx auth login/);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getMmxCredentials bypasses cache when force:true', async () => {
  clearSettings();
  let calls = 0;
  __setUsageRunnerForTests((cmd, args) => {
    if (cmd === 'mmx' && args[0] === 'config') {
      calls += 1;
      return { status: 0, stdout: JSON.stringify({ api_key: TEST_API_KEY, base_url: TEST_API_HOST }), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });
  try {
    await minimaxService.getMmxCredentials();
    assert.equal(calls, 1);
    await minimaxService.getMmxCredentials({ force: true });
    assert.equal(calls, 2, 'force:true must bypass the in-process creds cache');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

// ---------------------------------------------------------------------------
// getUsage — `mmx quota show` wrapper with 60s cache
// ---------------------------------------------------------------------------

const CANNED_GENERAL = {
  model_name: 'general',
  start_time: 1783540800000,
  end_time: 1783555200000,
  remains_time: 13_708_826,
  current_interval_total_count: 0,
  current_interval_usage_count: 0,
  current_interval_remaining_percent: 94,
  current_interval_status: 1,
  current_weekly_total_count: 0,
  current_weekly_usage_count: 0,
  weekly_start_time: 1783296000000,
  weekly_end_time: 1783900800000,
  weekly_remains_time: 359_334_692,
  current_weekly_remaining_percent: 50,
  current_weekly_status: 1,
};

test('getUsage returns parsed model_remains when mmx emits valid JSON', async () => {
  __clearUsageCacheForTests();
  __setUsageRunnerForTests(() => ({
    status: 0,
    stdout: JSON.stringify({ model_remains: [CANNED_GENERAL] }),
    stderr: '',
  }));

  try {
    const result = await minimaxService.getUsage();
    assert.equal(result.available, true);
    assert.equal(result.source, 'mmx');
    assert.equal(result.model_remains.length, 1);
    assert.equal(result.model_remains[0].model_name, 'general');
    assert.equal(result.model_remains[0].current_interval_remaining_percent, 94);
    assert.equal(result.model_remains[0].current_weekly_remaining_percent, 50);
    assert.equal(typeof result.fetchedAt, 'number');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
  }
});

test('getUsage returns unavailable when mmx is missing from PATH', async () => {
  __clearUsageCacheForTests();
  // Mirror spawnSync's behavior when the binary is absent.
  const enoent = Object.assign(new Error('spawnSync mmx ENOENT'), { code: 'ENOENT' });
  __setUsageRunnerForTests(() => ({ status: null, stdout: '', stderr: '', error: enoent }));

  try {
    const result = await minimaxService.getUsage();
    assert.equal(result.available, false);
    assert.equal(result.source, 'unavailable');
    assert.deepEqual(result.model_remains, []);
    assert.equal(result.reason, 'cli-error');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
  }
});

test('getUsage caches the result within 60s', async () => {
  __clearUsageCacheForTests();
  let calls = 0;
  __setUsageRunnerForTests(() => {
    calls += 1;
    return { status: 0, stdout: JSON.stringify({ model_remains: [CANNED_GENERAL] }), stderr: '' };
  });

  try {
    await minimaxService.getUsage();
    await minimaxService.getUsage();
    await minimaxService.getUsage();
    assert.equal(calls, 1, 'subsequent calls within TTL must not re-spawn mmx');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
  }
});

test('getUsage re-spawns when force:true bypasses the cache', async () => {
  __clearUsageCacheForTests();
  let calls = 0;
  __setUsageRunnerForTests(() => {
    calls += 1;
    return { status: 0, stdout: JSON.stringify({ model_remains: [CANNED_GENERAL] }), stderr: '' };
  });

  try {
    await minimaxService.getUsage();
    assert.equal(calls, 1);
    await minimaxService.getUsage({ force: true });
    assert.equal(calls, 2, 'force:true must bypass the in-process cache');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
  }
});
