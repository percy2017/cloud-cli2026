import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QwenProviderAuth } from '@/modules/providers/list/qwen/qwen-auth.provider.js';

type PatchHandle = { restore: () => void };

const patchHomeDir = (nextHomeDir: string): PatchHandle => {
  const original = os.homedir;
  (os as { homedir: unknown }).homedir = () => nextHomeDir;
  return {
    restore: () => {
      (os as { homedir: unknown }).homedir = original;
    },
  };
};

const patchEnv = (nextEnv: Record<string, string | undefined>): PatchHandle => {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(nextEnv)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return {
    restore: () => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
};

const ENV_KEYS_TO_CLEAR = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GEMINI_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
];

const clearAllQwenEnvCredentials = (): PatchHandle => {
  const env: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS_TO_CLEAR) {
    env[key] = undefined;
  }
  return patchEnv(env);
};

const setupHomeDir = async (): Promise<{ tempDir: string; restoreHome: () => void }> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'qwen-auth-test-'));
  const homePatch = patchHomeDir(tempDir);
  await mkdir(path.join(tempDir, '.qwen'), { recursive: true });
  return {
    tempDir,
    restoreHome: homePatch.restore,
  };
};

const teardown = async (tempDir: string): Promise<void> => {
  await rm(tempDir, { recursive: true, force: true });
};

test('checkCredentials returns authenticated=true when settings.json has a top-level apiKey', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = clearAllQwenEnvCredentials();
  try {
    await writeFile(
      path.join(tempDir, '.qwen', 'settings.json'),
      JSON.stringify({ apiKey: 'sk-from-settings' }),
    );

    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.provider, 'qwen');
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'settings_file');
    assert.equal(status.email, 'qwen-api-key');
    assert.equal(status.error, undefined);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns authenticated=true when settings.json has nested modelProviders.<name>.apiKey', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = clearAllQwenEnvCredentials();
  try {
    await writeFile(
      path.join(tempDir, '.qwen', 'settings.json'),
      JSON.stringify({
        modelProviders: {
          openai: { apiKey: 'sk-from-openai', baseUrl: 'https://api.openai.com/v1' },
          anthropic: { apiKey: 'sk-from-anthropic' },
        },
      }),
    );

    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'settings_file');
    assert.match(status.email ?? '', /openai credentials/);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials recognises Qwen 0.19.x envKey-pointer shape: modelProviders[name]=[{envKey}] + settings.env[envKey]', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = clearAllQwenEnvCredentials();
  try {
    // This is the exact shape `qwen auth` writes when the user swaps providers
    // (reproduced from /root/.qwen/settings.json on the VPS):
    //   - modelProviders[name] is an ARRAY, not an object
    //   - the array entry has .envKey pointing to a key in settings.env
    await writeFile(
      path.join(tempDir, '.qwen', 'settings.json'),
      JSON.stringify({
        env: {
          QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO_ANTHROPIC_36C86C5DB998:
            'sk-cp-from-env-map',
        },
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M3',
              name: 'MiniMax-M3',
              baseUrl: 'https://api.minimax.io/anthropic',
              envKey:
                'QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO_ANTHROPIC_36C86C5DB998',
            },
          ],
        },
        model: { name: 'MiniMax-M3', baseUrl: 'https://api.minimax.io/anthropic' },
      }),
    );

    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'settings_file');
    assert.equal(status.error, undefined);
    assert.match(status.email ?? '', /anthropic credentials/);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials falls back to process.env when envKey is not present in settings.env', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = patchEnv({
    QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO: 'sk-from-process-env',
    OPENAI_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    QWEN_API_KEY: undefined,
    DASHSCOPE_API_KEY: undefined,
  });
  try {
    // envKey present in array entry, but neither in settings.env nor process.env —
    // provider must still match because the envKey *name* is one of the recognised
    // provider env vars. Here we test the opposite: envKey DOES exist in process.env.
    await writeFile(
      path.join(tempDir, '.qwen', 'settings.json'),
      JSON.stringify({
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M3',
              baseUrl: 'https://api.minimax.io/anthropic',
              envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC_HTTPS_API_MINIMAX_IO',
            },
          ],
        },
      }),
    );

    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'settings_file');
    assert.match(status.email ?? '', /anthropic credentials/);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns false when modelProviders is an array with envKey pointing to an empty/missing value', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = clearAllQwenEnvCredentials();
  try {
    await writeFile(
      path.join(tempDir, '.qwen', 'settings.json'),
      JSON.stringify({
        env: {
          // Empty string — should NOT count as authenticated
          QWEN_CUSTOM_API_KEY_EMPTY: '',
        },
        modelProviders: {
          anthropic: [
            {
              id: 'MiniMax-M3',
              baseUrl: 'https://api.minimax.io/anthropic',
              envKey: 'QWEN_CUSTOM_API_KEY_EMPTY',
            },
          ],
        },
      }),
    );

    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.error, 'Qwen not configured');
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials falls back to process.env.OPENAI_API_KEY when settings.json is missing', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = patchEnv({
    OPENAI_API_KEY: 'sk-from-env',
    ANTHROPIC_API_KEY: undefined,
    GOOGLE_GENERATIVE_AI_API_KEY: undefined,
    GEMINI_API_KEY: undefined,
    QWEN_API_KEY: undefined,
    DASHSCOPE_API_KEY: undefined,
  });
  try {
    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'environment');
    assert.equal(status.email, 'OPENAI_API_KEY');
    assert.equal(status.error, undefined);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns authenticated=false when no credentials are present anywhere', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = clearAllQwenEnvCredentials();
  try {
    // Empty .qwen dir, no settings.json
    const auth = new QwenProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.provider, 'qwen');
    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.equal(status.error, 'Qwen not configured');
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});