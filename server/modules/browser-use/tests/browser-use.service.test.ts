import assert from 'node:assert/strict';
import test from 'node:test';

import { browserUseService } from '@/modules/browser-use/browser-use.service.js';
import { appConfigDb } from '@/modules/database/index.js';

const BROWSER_USE_SETTINGS_KEY = 'browser_use_settings';

function enableBrowser() {
  appConfigDb.set(BROWSER_USE_SETTINGS_KEY, JSON.stringify({ enabled: true }));
}

test('browser monitor list starts empty without agent sessions', async () => {
  const sessions = await browserUseService.listSessions();

  assert.deepEqual(sessions, []);
});

test('getOrCreateSessionForChatRun returns the same session on subsequent calls', async () => {
  enableBrowser();
  const first = await browserUseService.getOrCreateSessionForChatRun({
    chatRunId: 'chat-run-test-1',
    userId: null,
  });
  const second = await browserUseService.getOrCreateSessionForChatRun({
    chatRunId: 'chat-run-test-1',
    userId: null,
  });

  assert.equal(first.id, second.id);
  assert.equal(second.chatRunId, 'chat-run-test-1');

  // Cleanup so the test does not leak sessions into subsequent runs.
  await browserUseService.closeSessionsByChatRunId('chat-run-test-1');
});

test('closeSessionsByChatRunId removes the session and returns closed count', async () => {
  enableBrowser();
  const created = await browserUseService.getOrCreateSessionForChatRun({
    chatRunId: 'chat-run-test-2',
    userId: null,
  });

  const result = await browserUseService.closeSessionsByChatRunId('chat-run-test-2');
  assert.equal(result.closed, 1);

  const after = await browserUseService.getSessionByChatRunId('chat-run-test-2');
  assert.equal(after, null);

  // Calling close again on an unknown run is a safe no-op.
  const second = await browserUseService.closeSessionsByChatRunId('chat-run-test-2');
  assert.equal(second.closed, 0);

  assert.ok(created.id);
});
