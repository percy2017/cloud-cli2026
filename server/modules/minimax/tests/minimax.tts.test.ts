import assert from 'node:assert/strict';
import test from 'node:test';

import {
  minimaxService,
  __setUsageRunnerForTests,
  __clearUsageCacheForTests,
} from '@/modules/minimax/minimax.service.js';
import { appConfigDb } from '@/modules/database/index.js';

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
 * Mock runner that handles both `mmx config show` (returns the test key)
 * and `mmx speech synthesize` (returns a canned mp3). Any other mmx
 * sub-command gets an empty stdout so callers that didn't expect to
 * hit them still get a clean error path.
 */
function makeMmxRunner(opts: {
  configKey?: string;
  configHost?: string;
  speechBytes?: string;
}) {
  return (cmd: string, args: string[]) => {
    if (cmd === 'mmx' && args[0] === 'config' && args[1] === 'show') {
      return {
        status: 0,
        stdout: JSON.stringify({
          api_key: opts.configKey ?? TEST_API_KEY,
          base_url: opts.configHost ?? TEST_API_HOST,
        }),
        stderr: '',
      };
    }
    if (cmd === 'mmx' && args[0] === 'speech') {
      return { status: 0, stdout: opts.speechBytes ?? 'ID3\x04\x00\x00\x00\x00\x00\x00FAKE-MP3', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('getTtsConfig returns null when tts.enabled is false (default)', async () => {
  clearSettings();
  __setUsageRunnerForTests(makeMmxRunner({}));
  try {
    const cfg = await minimaxService.getTtsConfig();
    assert.equal(cfg, null);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getTtsConfig returns null when mmx is not authenticated even if tts.enabled=true', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-hd', voice: 'English_expressive_narrator', format: 'mp3' } });
  __setUsageRunnerForTests(makeMmxRunner({ configKey: '' }));

  try {
    const cfg = await minimaxService.getTtsConfig();
    assert.equal(cfg, null);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('getTtsConfig returns the full TTS sub-config when tts.enabled=true and mmx is authenticated', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.6-turbo', voice: 'Spanish_narrator', format: 'wav' } });
  __setUsageRunnerForTests(makeMmxRunner({}));

  try {
    const cfg = await minimaxService.getTtsConfig();
    assert.ok(cfg, 'getTtsConfig should not return null');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.apiKey, TEST_API_KEY, 'apiKey comes from mmx, not the DB');
    assert.equal(cfg.apiHost, TEST_API_HOST, 'apiHost comes from mmx, not the DB');
    assert.equal(cfg.model, 'speech-2.6-turbo');
    assert.equal(cfg.voice, 'Spanish_narrator');
    assert.equal(cfg.format, 'wav');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText throws when TTS is disabled', async () => {
  clearSettings();
  setSettings({ enabled: true });
  __setUsageRunnerForTests(makeMmxRunner({}));

  try {
    await assert.rejects(
      () => minimaxService.synthesizeText({ text: 'hello' }),
      /not enabled/,
    );
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText throws when mmx is not authenticated', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  __setUsageRunnerForTests(makeMmxRunner({ configKey: '' }));

  try {
    await assert.rejects(
      () => minimaxService.synthesizeText({ text: 'hi' }),
      /mmx is not authenticated/,
    );
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText throws on empty text', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  __setUsageRunnerForTests(makeMmxRunner({}));

  try {
    await assert.rejects(() => minimaxService.synthesizeText({ text: '   ' }), /empty text/);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText rejects inputs over the 10k character cap with a 413-friendly error', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  __setUsageRunnerForTests(makeMmxRunner({}));

  try {
    const big = 'a'.repeat(10_001);
    await assert.rejects(() => minimaxService.synthesizeText({ text: big }), /10000 character limit/);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText shells out to mmx speech synthesize with the expected arg shape', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  const fakeMp3 = Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00FAKE-MP3-BYTES');
  let captured: { cmd: string; args: string[] } | null = null;
  __setUsageRunnerForTests((cmd, args) => {
    if (cmd === 'mmx' && args[0] === 'config') {
      return { status: 0, stdout: JSON.stringify({ api_key: TEST_API_KEY, base_url: TEST_API_HOST }), stderr: '' };
    }
    if (cmd === 'mmx' && args[0] === 'speech') {
      captured = { cmd, args };
      return { status: 0, stdout: fakeMp3.toString('binary'), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    const result = await minimaxService.synthesizeText({ text: 'Hola mundo' });
    assert.ok(captured, 'mmx speech runner was not invoked');
    const call = captured as { cmd: string; args: string[] };
    assert.equal(call.cmd, 'mmx');
    assert.deepEqual(call.args, [
      'speech',
      'synthesize',
      '--non-interactive',
      // `--stream` makes `mmx` emit raw audio bytes to stdout; without it the
      // CLI saves the file to disk and prints a JSON manifest. The voice
      // proxy streams the stdout directly back to the browser.
      '--stream',
      '--text',
      'Hola mundo',
      '--voice',
      'English_expressive_narrator',
      '--model',
      'speech-2.8-turbo',
      '--format',
      'mp3',
    ]);
    assert.equal(result.format, 'mp3');
    assert.ok(result.audio.equals(fakeMp3), 'returned buffer must match the mmx stdout');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText accepts per-call voice/model/format overrides', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  let captured: { cmd: string; args: string[] } | null = null;
  __setUsageRunnerForTests((cmd, args) => {
    if (cmd === 'mmx' && args[0] === 'config') {
      return { status: 0, stdout: JSON.stringify({ api_key: TEST_API_KEY, base_url: TEST_API_HOST }), stderr: '' };
    }
    if (cmd === 'mmx' && args[0] === 'speech') {
      captured = { cmd, args };
      return { status: 0, stdout: 'xx', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  });

  try {
    await minimaxService.synthesizeText({
      text: 'override test',
      voice: 'Spanish_narrator',
      model: 'speech-02-hd',
      format: 'wav',
    });
    assert.ok(captured);
    const call = captured as { cmd: string; args: string[] };
    assert.deepEqual(call.args, [
      'speech',
      'synthesize',
      '--non-interactive',
      // Mirror the production default — see comment in the first arg-shape test.
      '--stream',
      '--text',
      'override test',
      '--voice',
      'Spanish_narrator',
      '--model',
      'speech-02-hd',
      '--format',
      'wav',
    ]);
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('synthesizeText surfaces mmx spawn errors as a clear English message', async () => {
  clearSettings();
  setSettings({ tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' } });
  __setUsageRunnerForTests((cmd, args) => {
    if (cmd === 'mmx' && args[0] === 'config') {
      return { status: 0, stdout: JSON.stringify({ api_key: TEST_API_KEY, base_url: TEST_API_HOST }), stderr: '' };
    }
    // speech path: simulate ENOENT.
    return {
      status: 1,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('spawnSync mmx ENOENT'), { code: 'ENOENT' }),
    };
  });

  try {
    await assert.rejects(
      () => minimaxService.synthesizeText({ text: 'hi' }),
      /MiniMax TTS failed: spawnSync mmx ENOENT/,
    );
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});

test('updateSettings persists tts sub-config and drops apiKey/apiHost from the DB', async () => {
  clearSettings();
  __setUsageRunnerForTests(makeMmxRunner({}));

  try {
    // Note: we deliberately do NOT set `enabled: true` here — testing only
    // that the tts sub-config survives and that credentials are dropped.
    // Setting `enabled: true` would also trigger `registerAgentMcp` which
    // requires an extra monkey-patch on the dispatcher and would couple
    // this test to that side effect.
    await minimaxService.updateSettings({
      tts: { enabled: true, model: 'speech-2.8-turbo', voice: 'English_expressive_narrator', format: 'mp3' },
    });

    const stored = JSON.parse(appConfigDb.get(MINIMAX_SETTINGS_KEY) || '{}');
    assert.equal(stored.tts.enabled, true);
    assert.equal(stored.tts.model, 'speech-2.8-turbo');
    assert.equal(stored.tts.voice, 'English_expressive_narrator');
    assert.equal(stored.tts.format, 'mp3');
    assert.equal(stored.apiKey, undefined, 'apiKey must NOT be persisted in the DB');
    assert.equal(stored.apiHost, undefined, 'apiHost must NOT be persisted in the DB');
  } finally {
    __setUsageRunnerForTests(null);
    __clearUsageCacheForTests();
    clearSettings();
  }
});
