/**
 * Tests for the native task queue service.
 *
 * The service depends on:
 *   - `app_config` SQLite table (via @/modules/database/index.js)
 *   - projectsDb (via @/modules/database/index.js) — resolves projectId → path
 *   - providerMcpService (via @/modules/providers/index.js)
 *   - connectedClients + WS_OPEN_STATE (via @/modules/websocket/index.js)
 *
 * All four are exercised here against a real temp-dir SQLite + two fake
 * projects, with the provider MCP service stubbed (real impl would touch every
 * CLI provider's settings file). The on-disk YAML queue lives inside each
 * project's temp dir — exactly like production — so we catch real I/O bugs.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { before, beforeEach } from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectsDb,
} from '@/modules/database/index.js';
import { connectedClients } from '@/modules/websocket/index.js';

class FakeConnection {
  readyState = 1;
  frames: Array<Record<string, unknown>> = [];
  send(data: string): void {
    this.frames.push(JSON.parse(data) as Record<string, unknown>);
  }
}

let tasksServiceRef: typeof import('../tasks.service.js').tasksService;
let tempHome: string;
let projectAId: string;
let projectBId: string;
let previousDatabasePath: string | undefined;
let previousHome: string | undefined;

function registerProject(name: string): string {
  const projectPath = path.join(tempHome, name);
  mkdirSync(projectPath);
  // Use the same insertion pattern the real app uses — projectsDb only
  // exposes lookup helpers, so we drop straight into SQLite for the test row.
  const db = getConnection();
  const id = `proj-${name}`;
  db.prepare(
    `INSERT OR REPLACE INTO projects (project_id, project_path, custom_project_name, isStarred, isArchived)
     VALUES (?, ?, NULL, 0, 0)`,
  ).run(id, projectPath);
  return id;
}

function mkdirSync(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
}

async function setup(): Promise<void> {
  previousDatabasePath = process.env.DATABASE_PATH;
  previousHome = process.env.HOME;
  tempHome = await mkdtemp(path.join(tmpdir(), 'cloudcli-tasks-test-'));
  process.env.HOME = tempHome;
  process.env.DATABASE_PATH = path.join(tempHome, 'auth.db');

  closeConnection();
  await initializeDatabase();

  projectAId = registerProject('alpha');
  projectBId = registerProject('beta');

  if (!tasksServiceRef) {
    const mod = await import('../tasks.service.js');
    tasksServiceRef = mod.tasksService;
    // Skip MCP provider registration during tests — its real implementation
    // talks to every CLI provider's settings file, which we don't want here.
    tasksServiceRef.updateSettings = (async (input: any) => {
      const enabled = input && typeof input.enabled === 'boolean' ? input.enabled : false;
      return { enabled };
    }) as typeof tasksServiceRef.updateSettings;
  }
}

async function teardown(): Promise<void> {
  connectedClients.clear();
  closeConnection();
  if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = previousDatabasePath;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (tempHome) await rm(tempHome, { recursive: true, force: true });
}

before(async () => {
  await setup();
});

beforeEach(() => {
  connectedClients.clear();
  // Wipe on-disk queues between tests; keep DB + projects.
  for (const id of [projectAId, projectBId]) {
    const projectPath = projectsDb.getProjectPathById(id);
    if (projectPath) {
      const tasksDir = path.join(projectPath, '.cloudcli', 'tasks');
      if (fs.existsSync(tasksDir)) {
        fs.rmSync(tasksDir, { recursive: true, force: true });
      }
    }
  }
});

test('createTask lands a YAML file under the active project', async () => {
  const created = await tasksServiceRef.createTask({
    projectId: projectAId,
    agent: 'sysadmin',
    title: 'Back up the database',
    description: 'urgent',
    prompt: 'pg_dump before deploy',
    taskType: 'deploy',
    riskLevel: 'medium',
    priority: 'urgent',
    contextRefs: ['/etc/postgres.conf'],
    createdBy: 'mcp:chat-run:abc',
  });
  assert.ok(created, 'createTask should return the persisted task');
  assert.equal(created.status, 'submitted');
  assert.equal(created.projectId, projectAId);
  assert.equal(created.agent, 'sysadmin');
  assert.equal(created.taskType, 'deploy');
  assert.equal(created.priority, 'urgent');
  assert.equal(created.quarantined, false);
  assert.equal(created.history.length, 1);
  assert.equal(created.history[0].action, 'created');

  const projectPath = projectsDb.getProjectPathById(projectAId);
  assert.ok(projectPath);
  const files = fs.readdirSync(path.join(projectPath!, '.cloudcli', 'tasks')).filter((n) => n.endsWith('.yml'));
  assert.equal(files.length, 1);
});

test('listTasks is scoped to the requested project — no cross-pollution', async () => {
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 'A1', prompt: '...' });
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'developer', title: 'A2', prompt: '...' });
  await tasksServiceRef.createTask({ projectId: projectBId, agent: 'sysadmin', title: 'B1', prompt: '...' });

  assert.equal(tasksServiceRef.listTasks(projectAId).length, 2);
  assert.equal(tasksServiceRef.listTasks(projectBId).length, 1);
  assert.equal(tasksServiceRef.listTasks('proj-unknown').length, 0);
});

test('approveTask moves submitted → approved and records an operator entry', async () => {
  const task = await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 't', prompt: '...' });
  assert.ok(task);
  const approved = await tasksServiceRef.approveTask(projectAId, task.id, {
    actor: 'operator:percy',
    role: 'operator',
    note: 'lgtm',
  });
  assert.ok(approved);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.history.at(-1)?.action, 'approved');
  assert.equal(approved.history.at(-1)?.actor, 'operator:percy');
  assert.equal(approved.history.at(-1)?.note, 'lgtm');
});

test('cancelTask refuses to override a completed task', async () => {
  const task = await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 't', prompt: '...' });
  assert.ok(task);
  await tasksServiceRef.updateTaskStatus(projectAId, task.id, 'in_progress');
  await tasksServiceRef.updateTaskStatus(projectAId, task.id, 'completed', {
    actor: 'agent:sysadmin',
    role: 'agent',
    result: 'ok',
  });
  const cancelled = await tasksServiceRef.cancelTask(projectAId, task.id);
  assert.equal(cancelled, null);
});

test('quarantineTask moves the file into quarantine/ and restoreTask brings it back', async () => {
  const task = await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 't', prompt: '...' });
  assert.ok(task);
  const projectPath = projectsDb.getProjectPathById(projectAId);
  assert.ok(projectPath);
  const tasksDir = path.join(projectPath!, '.cloudcli', 'tasks');
  assert.ok(fs.existsSync(path.join(tasksDir, `${task.id}.yml`)));

  const quarantined = await tasksServiceRef.quarantineTask(projectAId, task.id, {
    actor: 'operator:percy',
    role: 'operator',
    note: 'pause review',
  });
  assert.ok(quarantined);
  assert.equal(quarantined.quarantined, true);
  assert.equal(
    fs.existsSync(path.join(tasksDir, 'quarantine', `${task.id}.yml`)),
    true,
  );

  // listTasks without includeQuarantined should not see it.
  assert.equal(tasksServiceRef.listTasks(projectAId).length, 0);
  assert.equal(tasksServiceRef.listTasks(projectAId, { includeQuarantined: true }).length, 1);

  const restored = await tasksServiceRef.restoreTask(projectAId, task.id);
  assert.ok(restored);
  assert.equal(restored.quarantined, false);
  assert.equal(tasksServiceRef.listTasks(projectAId).length, 1);
});

test('filters by status, taskType, priority, agent', async () => {
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 'a', prompt: '...', taskType: 'build', priority: 'urgent' });
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'developer', title: 'b', prompt: '...', taskType: 'audit', priority: 'normal' });
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'developer', title: 'c', prompt: '...', taskType: 'build', priority: 'normal' });

  assert.equal(tasksServiceRef.listTasks(projectAId, { taskType: 'build' }).length, 2);
  assert.equal(tasksServiceRef.listTasks(projectAId, { priority: 'urgent' }).length, 1);
  assert.equal(tasksServiceRef.listTasks(projectAId, { agent: 'developer' }).length, 2);
  assert.equal(tasksServiceRef.listTasks(projectAId, { status: 'submitted' }).length, 3);
});

test('getMcpToken is stable across calls', () => {
  const first = tasksServiceRef.getMcpToken();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(tasksServiceRef.getMcpToken(), first);
});

test('WebSocket broadcast carries the active projectId and the new task list', async () => {
  const fake = new FakeConnection();
  connectedClients.add(fake as unknown as import('ws').WebSocket);
  await tasksServiceRef.createTask({ projectId: projectAId, agent: 'sysadmin', title: 'live', prompt: '...' });
  assert.ok(fake.frames.length >= 1);
  const last = fake.frames[fake.frames.length - 1];
  assert.equal(last.kind, 'tasks_queue_updated');
  assert.equal(last.projectId, projectAId);
  assert.ok(Array.isArray(last.tasks));
  assert.ok(last.tasks.some((t: any) => t.title === 'live'));
  connectedClients.clear();
});

test('createTask refuses an unknown projectId without throwing', async () => {
  const out = await tasksServiceRef.createTask({ projectId: 'proj-bogus', agent: 'sysadmin', title: 'orphan', prompt: '...' });
  assert.equal(out, null);
});

test.after(async () => {
  await teardown();
});