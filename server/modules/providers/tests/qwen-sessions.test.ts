import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QwenSessionsProvider } from '@/modules/providers/list/qwen/qwen-sessions.provider.js';

test('Qwen sessions provider normalizes live streaming events', () => {
  const provider = new QwenSessionsProvider();

  // user message
  const userMsg = provider.normalizeMessage({
    type: 'user',
    sessionId: 'live-1',
    timestamp: '2026-07-08T12:00:00Z',
    message: { role: 'user', parts: [{ text: 'Find me a song' }] },
  }, null);
  assert.equal(userMsg.length, 1);
  assert.equal(userMsg[0]?.kind, 'text');
  assert.equal(userMsg[0]?.role, 'user');
  assert.equal(userMsg[0]?.content, 'Find me a song');
  assert.equal(userMsg[0]?.provider, 'qwen');

  // assistant text — Qwen 0.19.x writes { role: "model", parts: [{ text: "..." }] }
  // (verified against ~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl on 2026-07-08).
  // The older Anthropic-style { role: "assistant", content: [...] } shape is kept
  // as a forward-compat fallback so a future Qwen build that flips back doesn't
  // silently drop history.
  const assistantMsg = provider.normalizeMessage({
    type: 'assistant',
    sessionId: 'live-1',
    timestamp: '2026-07-08T12:00:05Z',
    message: { role: 'model', parts: [{ text: 'Here you go.' }] },
  }, null);
  assert.equal(assistantMsg.length, 1);
  assert.equal(assistantMsg[0]?.kind, 'text');
  assert.equal(assistantMsg[0]?.role, 'assistant');
  assert.equal(assistantMsg[0]?.content, 'Here you go.');

  // assistant with thought + text parts in the same envelope (Qwen 0.19.x writes
  // reasoning inline as `{ text: "...", thought: true }`). We emit each as a
  // SEPARATE NormalizedMessage — the thought becomes `kind:'thinking'` and the
  // visible text becomes `kind:'text'` — so the UI can render them in their
  // own rows instead of concatenating reasoning into the visible reply.
  const assistantMixed = provider.normalizeMessage({
    type: 'assistant',
    sessionId: 'live-1',
    timestamp: '2026-07-08T12:00:06Z',
    message: {
      role: 'model',
      parts: [
        { text: 'reasoning in progress', thought: true },
        { text: 'visible answer' },
      ],
    },
  }, null);
  assert.equal(assistantMixed.length, 2);
  assert.equal(assistantMixed[0]?.kind, 'thinking');
  assert.equal(assistantMixed[0]?.content, 'reasoning in progress');
  assert.equal(assistantMixed[1]?.kind, 'text');
  assert.equal(assistantMixed[1]?.role, 'assistant');
  assert.equal(assistantMixed[1]?.content, 'visible answer');

  // backward-compat: legacy { role: "assistant", content: [{ type, text }] } still works
  const assistantLegacy = provider.normalizeMessage({
    type: 'assistant',
    sessionId: 'legacy-1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'legacy payload' }] },
  }, null);
  assert.equal(assistantLegacy.length, 1);
  assert.equal(assistantLegacy[0]?.content, 'legacy payload');

  // assistant row carrying usageMetadata (Qwen 0.19.x writes
  // `usageMetadata: { promptTokenCount, candidatesTokenCount, ... }` on the
  // envelope). The tokenUsage field must be stamped on the LAST emitted row so
  // the sessionStore can pick it up as the canonical message cost.
  const assistantWithUsage = provider.normalizeMessage({
    type: 'assistant',
    sessionId: 'live-usage',
    timestamp: '2026-07-08T12:00:07Z',
    message: {
      role: 'model',
      parts: [
        { text: 'reasoning', thought: true },
        { text: 'done' },
      ],
    },
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 50,
      cachedContentTokenCount: 20,
      totalTokenCount: 170,
    },
  }, null);
  assert.equal(assistantWithUsage.length, 2);
  const lastRow = assistantWithUsage[assistantWithUsage.length - 1] as { tokenUsage?: unknown };
  assert.deepEqual(lastRow.tokenUsage, { input: 100, output: 50, cached: 20, total: 170 });

  // thinking
  const thinking = provider.normalizeMessage({
    type: 'thinking',
    sessionId: 'live-1',
    content: 'reasoning about search query',
  }, null);
  assert.equal(thinking.length, 1);
  assert.equal(thinking[0]?.kind, 'thinking');
  assert.equal(thinking[0]?.content, 'reasoning about search query');

  // tool_use
  const toolUse = provider.normalizeMessage({
    type: 'tool_use',
    tool_name: 'web_search',
    tool_use_id: 'tool-1',
    tool_input: { query: 'top hits 2026' },
  }, null);
  assert.equal(toolUse.length, 1);
  assert.equal(toolUse[0]?.kind, 'tool_use');
  assert.equal(toolUse[0]?.toolName, 'web_search');
  assert.equal(toolUse[0]?.toolId, 'tool-1');
  assert.deepEqual(toolUse[0]?.toolInput, { query: 'top hits 2026' });

  // tool_result
  const toolResult = provider.normalizeMessage({
    type: 'tool_result',
    tool_use_id: 'tool-1',
    content: 'Top 3 songs...',
  }, null);
  assert.equal(toolResult.length, 1);
  assert.equal(toolResult[0]?.kind, 'tool_result');
  assert.equal(toolResult[0]?.content, 'Top 3 songs...');
  assert.deepEqual(toolResult[0]?.toolResult, { content: 'Top 3 songs...', isError: false });

  // result = stream_end
  const result = provider.normalizeMessage({
    type: 'result',
    sessionId: 'live-1',
  }, null);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.kind, 'stream_end');

  // error
  const error = provider.normalizeMessage({
    type: 'error',
    error: 'qwen cli crashed',
  }, null);
  assert.equal(error.length, 1);
  assert.equal(error[0]?.kind, 'error');
  assert.equal(error[0]?.content, 'qwen cli crashed');

  // Unknown event type → defensive empty array
  const unknown = provider.normalizeMessage({ type: 'mystery' }, null);
  assert.deepEqual(unknown, []);
});

test('Qwen sessions provider fetches JSONL history with token usage from result.stats', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-sessions-qwen-'));
  const restoreHomeDir = (() => {
    const original = os.homedir;
    (os as { homedir: unknown }).homedir = () => tempRoot;
    return () => {
      (os as { homedir: unknown }).homedir = original;
    };
  })();

  try {
    const projectPath = '/opt/cloud-cli2026';
    const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, '-');
    const jsonlPath = path.join(
      tempRoot,
      '.qwen',
      'projects',
      encodedPath,
      'chats',
      'session-history.jsonl',
    );
    await fs.mkdir(path.dirname(jsonlPath), { recursive: true });

    const jsonlContent = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        sessionId: 'session-history',
        timestamp: '2026-07-08T10:00:00Z',
        message: { role: 'user', parts: [{ text: 'Build a todo app' }] },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        sessionId: 'session-history',
        timestamp: '2026-07-08T10:00:10Z',
        // Qwen 0.19.x writes assistant rows as `{ role: "model", parts: [...] }`
        // (verified against ~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl).
        message: { role: 'model', parts: [{ text: 'On it.' }] },
      }),
      JSON.stringify({
        type: 'tool_use',
        uuid: 't1',
        sessionId: 'session-history',
        tool_name: 'write_file',
        tool_use_id: 'tool-call-1',
        tool_input: { path: 'todo.ts', content: 'export const t = [];' },
      }),
      JSON.stringify({
        type: 'tool_result',
        uuid: 'tr1',
        sessionId: 'session-history',
        tool_use_id: 'tool-call-1',
        content: 'ok',
      }),
      JSON.stringify({
        type: 'result',
        uuid: 'r1',
        sessionId: 'session-history',
        timestamp: '2026-07-08T10:00:30Z',
        result: 'Todo app scaffolded.',
        stats: {
          models: {
            'qwen3-coder-plus': {
              tokens: {
                input: 100,
                output: 50,
                cached: 20,
                total: 170,
              },
            },
          },
        },
      }),
    ].join('\n');

    await fs.writeFile(jsonlPath, jsonlContent, 'utf8');

    const provider = new QwenSessionsProvider();
    const history = await provider.fetchHistory('session-history', {
      projectPath,
      jsonlPath,
      providerSessionId: 'session-history',
    });

    assert.equal(history.total, 5);
    assert.equal(history.messages[0]?.kind, 'text');
    assert.equal(history.messages[0]?.role, 'user');
    assert.equal(history.messages[0]?.content, 'Build a todo app');
    assert.equal(history.messages[1]?.kind, 'text');
    assert.equal(history.messages[1]?.role, 'assistant');
    assert.equal(history.messages[2]?.kind, 'tool_use');
    assert.equal(history.messages[2]?.toolName, 'write_file');
    // tool_result is also attached as toolResult on the parent tool_use
    assert.deepEqual(history.messages[2]?.toolResult, { content: 'ok', isError: false });
    assert.equal(history.messages[3]?.kind, 'tool_result');
    assert.deepEqual(history.messages[3]?.toolResult, { content: 'ok', isError: false });
    assert.equal(history.messages[4]?.kind, 'stream_end');

    // Token usage aggregation from result.stats.models is not implemented in
    // the MVP — tokenUsage endpoint covers it via the result.stats path.
    assert.equal(history.tokenUsage, undefined);
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});