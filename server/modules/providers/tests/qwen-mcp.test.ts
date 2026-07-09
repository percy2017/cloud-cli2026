import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QwenMcpProvider } from '@/modules/providers/list/qwen/qwen-mcp.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as { homedir: unknown }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: unknown }).homedir = original;
  };
};

const readJson = async (filePath: string): Promise<Record<string, unknown>> => {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content) as Record<string, unknown>;
};

const setupHomeDir = async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-mcp-qwen-'));
  const workspacePath = path.join(tempRoot, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(tempRoot);
  return { tempRoot, workspacePath, restoreHomeDir };
};

const teardown = async (tempRoot: string, restoreHomeDir: () => void) => {
  restoreHomeDir();
  await fs.rm(tempRoot, { recursive: true, force: true });
};

test('QwenMcpProvider supports stdio transport at user scope writing to ~/.qwen/settings.json', { concurrency: false }, async () => {
  const { tempRoot, restoreHomeDir } = await setupHomeDir();
  try {
    const provider = new QwenMcpProvider();
    await provider.upsertServer({
      name: 'qwen-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: '$TOKEN' },
      cwd: './server',
    });

    const grouped = await provider.listServers();
    const userServers = grouped.user;
    const server = userServers.find((s) => s.name === 'qwen-stdio');
    assert.ok(server, 'qwen-stdio server should exist');
    assert.equal(server?.command, 'node');
    assert.deepEqual(server?.args, ['server.js']);
    assert.equal(server?.transport, 'stdio');

    const userConfig = await readJson(path.join(tempRoot, '.qwen', 'settings.json'));
    const mcpServers = userConfig.mcpServers as Record<string, unknown>;
    const writtenServer = mcpServers['qwen-stdio'] as Record<string, unknown>;
    assert.equal(writtenServer.command, 'node');
    assert.deepEqual(writtenServer.args, ['server.js']);
    assert.deepEqual(writtenServer.env, { TOKEN: '$TOKEN' });
    assert.equal(writtenServer.cwd, './server');
  } finally {
    await teardown(tempRoot, restoreHomeDir);
  }
});

test('QwenMcpProvider supports http transport at project scope writing to <workspace>/.qwen/settings.json', { concurrency: false }, async () => {
  const { workspacePath, restoreHomeDir, tempRoot } = await setupHomeDir();
  try {
    const provider = new QwenMcpProvider();
    await provider.upsertServer({
      name: 'qwen-http',
      scope: 'project',
      transport: 'http',
      url: 'https://qwen.example.com/mcp',
      headers: { Authorization: 'Bearer token' },
      workspacePath,
    });

    const grouped = await provider.listServers({ workspacePath });
    const projectServers = grouped.project;
    const server = projectServers.find((s) => s.name === 'qwen-http');
    assert.ok(server, 'qwen-http server should exist');
    assert.equal(server?.url, 'https://qwen.example.com/mcp');
    assert.equal(server?.transport, 'http');

    const projectConfig = await readJson(path.join(workspacePath, '.qwen', 'settings.json'));
    const mcpServers = projectConfig.mcpServers as Record<string, unknown>;
    const writtenServer = mcpServers['qwen-http'] as Record<string, unknown>;
    assert.equal(writtenServer.url, 'https://qwen.example.com/mcp');
    assert.deepEqual(writtenServer.headers, { Authorization: 'Bearer token' });
  } finally {
    await teardown(tempRoot, restoreHomeDir);
  }
});

test('QwenMcpProvider does not expose the local scope (qwen only supports user + project)', { concurrency: false }, async () => {
  const { restoreHomeDir, tempRoot } = await setupHomeDir();
  try {
    const provider = new QwenMcpProvider();
    const grouped = await provider.listServers();
    assert.deepEqual(grouped.local, [], 'local scope should always return []');
    assert.ok(grouped.user.length >= 0);
    assert.ok(grouped.project.length >= 0);
  } finally {
    await teardown(tempRoot, restoreHomeDir);
  }
});

test('QwenMcpProvider preserves unrelated settings keys when upserting an MCP server', { concurrency: false }, async () => {
  const { tempRoot, restoreHomeDir } = await setupHomeDir();
  try {
    const qwenDir = path.join(tempRoot, '.qwen');
    await fs.mkdir(qwenDir, { recursive: true });
    await fs.writeFile(
      path.join(qwenDir, 'settings.json'),
      JSON.stringify({ apiKey: 'sk-keep-me', theme: 'dark' }),
    );

    const provider = new QwenMcpProvider();
    await provider.upsertServer({
      name: 'qwen-stdio',
      scope: 'user',
      transport: 'stdio',
      command: 'node',
    });

    const written = await readJson(path.join(qwenDir, 'settings.json'));
    assert.equal(written.apiKey, 'sk-keep-me', 'apiKey should be preserved');
    assert.equal(written.theme, 'dark', 'theme should be preserved');
    assert.ok(written.mcpServers, 'mcpServers should now exist');
  } finally {
    await teardown(tempRoot, restoreHomeDir);
  }
});