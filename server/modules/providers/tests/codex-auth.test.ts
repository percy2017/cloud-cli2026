import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CodexProviderAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';

type HomePatchHandle = { restore: () => void };

const patchHomeDir = (nextHomeDir: string): HomePatchHandle => {
  const original = os.homedir;
  (os as { homedir: unknown }).homedir = () => nextHomeDir;
  return {
    restore: () => {
      (os as { homedir: unknown }).homedir = original;
    },
  };
};

const patchEnv = (nextEnv: Record<string, string | undefined>): HomePatchHandle => {
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

const FAKE_ID_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InRlc3RAZXhhbXBsZS5jb20ifQ.signature';

const setupHomeDir = async (): Promise<{ tempDir: string; restoreHome: () => void }> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-auth-test-'));
  const homePatch = patchHomeDir(tempDir);
  await mkdir(path.join(tempDir, '.codex'), { recursive: true });
  return {
    tempDir,
    restoreHome: homePatch.restore,
  };
};

const teardown = async (tempDir: string): Promise<void> => {
  await rm(tempDir, { recursive: true, force: true });
};

test('checkCredentials returns authenticated=true when auth.json has an id_token', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'auth.json'),
      JSON.stringify({ tokens: { id_token: FAKE_ID_TOKEN } }),
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.provider, 'codex');
    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'credentials_file');
    assert.equal(status.email, 'test@example.com');
    assert.equal(status.error, undefined);
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns authenticated=true when auth.json has an OPENAI_API_KEY', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'auth.json'),
      JSON.stringify({ OPENAI_API_KEY: 'sk-from-auth-json' }),
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'api_key');
    assert.equal(status.email, 'API Key Auth');
    assert.equal(status.error, undefined);
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials falls back to config.toml when auth.json is missing', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      'OPENAI_API_KEY = "sk-from-config"\nmodel_provider = "openai"\n',
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'config_toml');
    assert.equal(status.email, 'API Key Auth (config.toml)');
    assert.equal(status.error, undefined);
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials recognises [providers.*] entries in config.toml', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      [
        '[providers.openai]',
        'name = "OpenAI"',
        'baseURL = "https://api.openai.com/v1"',
        'apiKey = "sk-from-providers"',
        '',
      ].join('\n'),
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'config_toml');
    assert.equal(status.email, 'API Key Auth (config.toml)');
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials falls back to process.env.OPENAI_API_KEY', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = patchEnv({ OPENAI_API_KEY: 'sk-from-env' });
  try {
    // No auth.json or config.toml — empty config dir on purpose.
    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'env_var');
    assert.equal(status.email, 'API Key Auth (env)');
    assert.equal(status.error, undefined);
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials emits "Codex not configured" only when nothing is present', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = patchEnv({ OPENAI_API_KEY: undefined, OPENAI_KEY: undefined, CODEX_API_KEY: undefined });
  try {
    // Empty .codex directory.
    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.equal(status.email, null);
    assert.equal(status.error, 'Codex not configured');
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns null for empty auth.json and falls through to config.toml', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(path.join(tempDir, '.codex', 'auth.json'), '{}');
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      'OPENAI_API_KEY = "sk-fallback"\n',
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'config_toml');
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials recognises [model_providers.*] with experimental_bearer_token (custom provider)', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      [
        'model_provider = "minimax"',
        '',
        '[model_providers.minimax]',
        'name = "MiniMax"',
        'base_url = "https://api.minimax.io/v1"',
        'experimental_bearer_token = "sk-cp-fake-token"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'config_toml');
    assert.equal(status.email, 'API Key Auth (config.toml)');
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials recognises top-level experimental_bearer_token', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      'experimental_bearer_token = "sk-cp-top-level"\nmodel_provider = "custom"\n',
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, true);
    assert.equal(status.method, 'config_toml');
  } finally {
    restoreHome();
    await teardown(tempDir);
  }
});

test('checkCredentials returns "Codex not configured" when config.toml has no credential field', async () => {
  const { tempDir, restoreHome } = await setupHomeDir();
  const envPatch = patchEnv({
    OPENAI_API_KEY: undefined,
    OPENAI_KEY: undefined,
    CODEX_API_KEY: undefined,
  });
  try {
    await writeFile(
      path.join(tempDir, '.codex', 'config.toml'),
      [
        'model_provider = "minimax"',
        '',
        '[model_providers.minimax]',
        'name = "MiniMax"',
        'base_url = "https://api.minimax.io/v1"',
        'wire_api = "responses"',
        '',
      ].join('\n'),
    );

    const auth = new CodexProviderAuth();
    const status = await auth.getStatus();

    assert.equal(status.authenticated, false);
    assert.equal(status.method, null);
    assert.equal(status.error, 'Codex not configured');
  } finally {
    envPatch.restore();
    restoreHome();
    await teardown(tempDir);
  }
});
