import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';

import { appConfigDb, projectsDb } from '@/modules/database/index.js';
import { providerMcpService } from '@/modules/providers/index.js';
import { getModuleDir } from '@/utils/runtime-paths.js';
import { WS_OPEN_STATE, connectedClients } from '@/modules/websocket/index.js';

const __dirname = getModuleDir(import.meta.url);

/**
 * Persistent keys (kept in `app_config` for parity with the previous layout
 * and to avoid a SQLite migration). Task bodies themselves live in YAML
 * files under `<projectPath>/.cloudcli/tasks/<id>.yml` — one file per task,
 * guarded by a per-file flock for safe agent + operator concurrent writes.
 *
 * Quarantined tasks live in the same directory tree, under a `quarantine/`
 * subfolder; the file path encodes the quarantine flag, so a single
 * readTaskFile helper can derive it.
 */
const TASKS_SETTINGS_KEY = 'tasks_settings';
const TASKS_MCP_TOKEN_KEY = 'tasks_mcp_token';
const TASKS_SIDECAR_FILE = path.join(
  process.env.HOME || os.homedir(),
  '.cloudcli',
  'tasks',
  'current-chat-run.json',
);
const QUARANTINE_DIR_NAME = 'quarantine';

/**
 * In-memory timestamp (epoch ms) of the last successful call into the
 * tasks-mcp HTTP bridge. Updated by `markMcpActivity()` from
 * `tasks-mcp.routes.ts` after the bearer token check passes — every tool
 * call (list/get/create/update_status/approve/cancel/quarantine/restore/
 * delete) bumps it. Surfaced via `getMcpActivity()` to the UI's task-queue
 * health chip so a stale or never-started MCP doesn't masquerade as "live".
 *
 * Resets to null on process restart; not persisted.
 */
let lastMcpActivityAt: number | null = null;

export type TaskStatus =
  | 'submitted'
  | 'pending'
  | 'approved'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskType =
  | 'build'
  | 'deploy'
  | 'fix'
  | 'research'
  | 'review'
  | 'audit'
  | 'notify'
  | 'other';

export type RiskLevel = 'low' | 'medium' | 'high';
export type Priority = 'normal' | 'high' | 'urgent';

export const TASK_STATUSES: readonly TaskStatus[] = [
  'submitted',
  'pending',
  'approved',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const;

export const NON_TERMINAL_STATUSES: readonly TaskStatus[] = [
  'submitted',
  'pending',
  'approved',
  'in_progress',
] as const;

export const TASK_TYPES: readonly TaskType[] = [
  'build',
  'deploy',
  'fix',
  'research',
  'review',
  'audit',
  'notify',
  'other',
] as const;

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high'] as const;
export const PRIORITIES: readonly Priority[] = ['normal', 'high', 'urgent'] as const;

/** Lifecycle role recorded in history entries. */
export type TaskActorRole = 'agent' | 'operator';

export type TaskHistoryEntry = {
  at: string;
  actor: string;
  role: TaskActorRole;
  action:
    | 'created'
    | 'status_changed'
    | 'approved'
    | 'cancelled'
    | 'quarantined'
    | 'restored'
    | 'note';
  status?: TaskStatus;
  fromStatus?: TaskStatus;
  note?: string;
};

export type Task = {
  id: string;
  /** DB-assigned project id (from `projects.project_id`). Tasks are scoped
   *  per-project — this is never null on a persisted task. */
  projectId: string;
  /** Free-form agent role (`sysadmin`, `developer`, ...) populated by the
   *  MCP bridge from the sidecar or the create call. */
  agent: string;
  title: string;
  description: string;
  prompt: string;
  taskType: TaskType;
  riskLevel: RiskLevel;
  priority: Priority;
  /** File paths the agent should consult before/during the run. */
  contextRefs: string[];
  history: TaskHistoryEntry[];
  status: TaskStatus;
  /** Mirrors whether the file lives under `quarantine/`. */
  quarantined: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  createdBy: string | null;
};

export type TasksSettings = {
  enabled: boolean;
};

export type ListTasksFilter = {
  projectId: string;
  status?: TaskStatus;
  taskType?: TaskType;
  priority?: Priority;
  agent?: string;
  includeQuarantined?: boolean;
  limit?: number;
};

export type ActorContext = {
  actor: string;
  role: TaskActorRole;
  note?: string;
};

const DEFAULT_SETTINGS: TasksSettings = {
  enabled: false,
};

const MCP_SERVER_NAME = 'cloudcli-tasks';
const LEGACY_MCP_SERVER_NAMES: string[] = [];

const LOCK_OPTIONS = {
  retries: { retries: 8, minTimeout: 25, maxTimeout: 250 },
  stale: 5000,
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

function readSettings(): TasksSettings {
  try {
    const raw = appConfigDb.get(TASKS_SETTINGS_KEY);
    if (!raw) {
      return { ...DEFAULT_SETTINGS };
    }
    const parsed = JSON.parse(raw) as Partial<TasksSettings>;
    return {
      enabled: parsed.enabled === true,
    };
  } catch (error: any) {
    console.warn('[Tasks] Failed to read settings:', error?.message || error);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings: TasksSettings): TasksSettings {
  const normalized: TasksSettings = {
    enabled: settings.enabled === true,
  };
  appConfigDb.set(TASKS_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}

function getOrCreateMcpToken(): string {
  const existing = appConfigDb.get(TASKS_MCP_TOKEN_KEY);
  if (existing) {
    return existing;
  }
  const token = randomBytes(32).toString('hex');
  appConfigDb.set(TASKS_MCP_TOKEN_KEY, token);
  return token;
}

/**
 * Resolve the on-disk tasks directory for a project. The path comes from the
 * DB (authoritative) rather than the caller to avoid path-traversal tricks.
 * Returns `null` when the projectId is unknown or the resolved path is empty.
 */
function resolveTasksDir(projectId: string): string | null {
  if (!projectId || !/^[A-Za-z0-9._:-]+$/.test(projectId)) {
    return null;
  }
  const projectPath = projectsDb.getProjectPathById(projectId);
  if (!projectPath) {
    return null;
  }
  return path.join(projectPath, '.cloudcli', 'tasks');
}

function ensureDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (error: any) {
    if (error?.code !== 'EEXIST') {
      throw error;
    }
  }
}

function activeDirFor(tasksDir: string, quarantined: boolean): string {
  return quarantined ? path.join(tasksDir, QUARANTINE_DIR_NAME) : tasksDir;
}

function taskFilePath(tasksDir: string, id: string, quarantined: boolean): string {
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new Error(`Invalid task id "${id}".`);
  }
  return path.join(activeDirFor(tasksDir, quarantined), `${id}.yml`);
}

function normalizeStatus(value: unknown): TaskStatus {
  if (typeof value === 'string' && (TASK_STATUSES as readonly string[]).includes(value)) {
    return value as TaskStatus;
  }
  return 'submitted';
}

function normalizeTaskType(value: unknown): TaskType {
  if (typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value)) {
    return value as TaskType;
  }
  return 'other';
}

function normalizeRiskLevel(value: unknown): RiskLevel {
  if (typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)) {
    return value as RiskLevel;
  }
  return 'low';
}

function normalizePriority(value: unknown): Priority {
  if (typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value)) {
    return value as Priority;
  }
  return 'normal';
}

function normalizeContextRefs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => (entry as string).trim());
}

function normalizeHistory(value: unknown): TaskHistoryEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: TaskHistoryEntry[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.at !== 'string') continue;
    const action = record.action;
    if (
      action !== 'created'
      && action !== 'status_changed'
      && action !== 'approved'
      && action !== 'cancelled'
      && action !== 'quarantined'
      && action !== 'restored'
      && action !== 'note'
    ) {
      continue;
    }
    const role: TaskActorRole = record.role === 'operator' ? 'operator' : 'agent';
    const normalized: TaskHistoryEntry = {
      at: record.at,
      actor: typeof record.actor === 'string' ? record.actor : 'unknown',
      role,
      action,
    };
    if (typeof record.note === 'string' && record.note.length > 0) {
      normalized.note = record.note;
    }
    if (typeof record.status === 'string') {
      normalized.status = normalizeStatus(record.status);
    }
    if (typeof record.fromStatus === 'string') {
      normalized.fromStatus = normalizeStatus(record.fromStatus);
    }
    out.push(normalized);
  }
  return out;
}

function isValidTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.status === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.projectId === 'string'
  );
}

function parseTaskFile(raw: string): Task | null {
  let doc: unknown;
  try {
    doc = yaml.load(raw);
  } catch (error: any) {
    console.warn('[Tasks] Skipping malformed YAML:', error?.message || error);
    return null;
  }
  if (!isValidTask(doc)) return null;
  return {
    id: doc.id,
    projectId: doc.projectId,
    agent: typeof doc.agent === 'string' ? doc.agent : 'unknown',
    title: doc.title,
    description: typeof doc.description === 'string' ? doc.description : '',
    prompt: typeof doc.prompt === 'string' ? doc.prompt : '',
    taskType: normalizeTaskType(doc.taskType),
    riskLevel: normalizeRiskLevel(doc.riskLevel),
    priority: normalizePriority(doc.priority),
    contextRefs: normalizeContextRefs(doc.contextRefs),
    history: normalizeHistory(doc.history),
    status: normalizeStatus(doc.status),
    quarantined: doc.quarantined === true,
    createdAt: doc.createdAt,
    updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : doc.createdAt,
    startedAt: typeof doc.startedAt === 'string' ? doc.startedAt : null,
    completedAt: typeof doc.completedAt === 'string' ? doc.completedAt : null,
    result: typeof doc.result === 'string' ? doc.result : null,
    error: typeof doc.error === 'string' ? doc.error : null,
    createdBy: typeof doc.createdBy === 'string' && doc.createdBy ? doc.createdBy : null,
  };
}

function writeTaskAtomic(filePath: string, task: Task): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  const payload = yaml.dump(task, { noRefs: true, lineWidth: 120, sortKeys: false });
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readTaskFile(filePath: string): Task | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseTaskFile(raw);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    console.warn(`[Tasks] Failed to read ${filePath}:`, error?.message || error);
    return null;
  }
}

function findTaskOnDisk(
  tasksDir: string,
  id: string,
): { task: Task; filePath: string } | null {
  const activeFile = taskFilePath(tasksDir, id, false);
  const quarantinedFile = taskFilePath(tasksDir, id, true);
  const activeTask = readTaskFile(activeFile);
  if (activeTask) return { task: activeTask, filePath: activeFile };
  const quarantinedTask = readTaskFile(quarantinedFile);
  if (quarantinedTask) return { task: quarantinedTask, filePath: quarantinedFile };
  return null;
}

async function withTaskLock<T>(
  filePath: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  ensureDir(path.dirname(filePath));
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8');
  }
  const release = await lockfile.lock(filePath, LOCK_OPTIONS);
  try {
    return await fn();
  } finally {
    await release();
  }
}

function listTasksFromDisk(tasksDir: string, includeQuarantined: boolean): Task[] {
  ensureDir(tasksDir);
  const out: Task[] = [];
  const visited = new Set<string>();
  for (const entry of fs.readdirSync(tasksDir)) {
    if (!entry.endsWith('.yml')) continue;
    const filePath = path.join(tasksDir, entry);
    const task = readTaskFile(filePath);
    if (task && !visited.has(task.id)) {
      visited.add(task.id);
      out.push(task);
    }
  }
  if (includeQuarantined) {
    const quarantineDir = path.join(tasksDir, QUARANTINE_DIR_NAME);
    if (fs.existsSync(quarantineDir)) {
      for (const entry of fs.readdirSync(quarantineDir)) {
        if (!entry.endsWith('.yml')) continue;
        const filePath = path.join(quarantineDir, entry);
        const task = readTaskFile(filePath);
        if (task && !visited.has(task.id)) {
          visited.add(task.id);
          out.push(task);
        }
      }
    }
  }
  return out;
}

function broadcastQueueUpdated(projectId?: string): void {
  let tasks: Task[] = [];
  if (projectId) {
    const tasksDir = resolveTasksDir(projectId);
    if (tasksDir) tasks = listTasksFromDisk(tasksDir, true);
  }
  const payload = JSON.stringify({
    kind: 'tasks_queue_updated',
    projectId: projectId ?? null,
    tasks,
    timestamp: nowIso(),
  });
  connectedClients.forEach((client) => {
    if (client.readyState === WS_OPEN_STATE) {
      client.send(payload);
    }
  });
}

function getMcpCommand(): { command: string; args: string[] } {
  // Mirror browser-use.service.ts#getMcpCommand: prefer the compiled
  // tasks-mcp.js next to this file (works for git installs, npm installs,
  // and dev `tsx` runs) and only fall back to the `cloudcli` wrapper when
  // the script isn't on disk. Using the wrapper alone is fragile because
  // some provider CLIs spawn MCPs with a stripped PATH that can't resolve
  // `/usr/local/bin/cloudcli` — leading to a silent `ENOENT` and the
  // MCP showing up as "failed" in client dialogs.
  const serverDir = path.resolve(__dirname, '..', '..');
  const mcpScriptPath = path.join(serverDir, 'tasks-mcp.js');
  if (fs.existsSync(mcpScriptPath)) {
    return {
      command: process.execPath,
      args: [mcpScriptPath],
    };
  }

  return {
    command: 'cloudcli',
    args: ['tasks-mcp'],
  };
}

function getMcpApiUrl(): string {
  const port = process.env.SERVER_PORT || process.env.PORT || '3001';
  return `http://127.0.0.1:${port}/api/tasks-mcp`;
}

async function registerMcpServer(): Promise<void> {
  const apiUrl = getMcpApiUrl();
  const token = getOrCreateMcpToken();
  const command = getMcpCommand();

  const results = await providerMcpService.addMcpServerToAllProviders({
    name: MCP_SERVER_NAME,
    scope: 'user',
    transport: 'stdio',
    command: command.command,
    args: command.args,
    env: {
      CLOUDCLI_TASKS_API_URL: apiUrl,
      CLOUDCLI_TASKS_MCP_TOKEN: token,
    },
  });

  for (const legacyName of LEGACY_MCP_SERVER_NAMES) {
    try {
      await providerMcpService.removeMcpServerFromAllProviders({
        name: legacyName,
        scope: 'user',
      });
    } catch (error: any) {
      console.warn(`[Tasks] Failed to remove legacy MCP "${legacyName}":`, error?.message || error);
    }
  }

  const failed = results.filter((result) => !result.created);
  if (failed.length > 0) {
    console.warn('[Tasks] Some providers failed to register the tasks MCP:', failed);
  }
}

async function unregisterMcpServer(): Promise<void> {
  try {
    await providerMcpService.removeMcpServerFromAllProviders({
      name: MCP_SERVER_NAME,
      scope: 'user',
    });
  } catch (error: any) {
    console.warn('[Tasks] Failed to unregister MCP:', error?.message || error);
  }
}

function generateId(): string {
  return randomUUID();
}

function appendHistoryEntry(task: Task, entry: TaskHistoryEntry, now: string): Task {
  return {
    ...task,
    history: [...task.history, entry],
    updatedAt: now,
  };
}

export const tasksService = {
  /**
   * Returns whether the cloudcli-tasks MCP is enabled.
   */
  isEnabled(): boolean {
    return readSettings().enabled;
  },

  /**
   * Returns the current settings.
   */
  getSettings(): TasksSettings {
    return readSettings();
  },

  /**
   * Updates settings. Enabling also registers the MCP with all providers; disabling
   * removes it. Returns the persisted settings.
   */
  async updateSettings(input: Partial<TasksSettings>): Promise<TasksSettings> {
    const previous = readSettings();
    const next: TasksSettings = {
      enabled:
        input.enabled !== undefined ? input.enabled === true : previous.enabled,
    };
    writeSettings(next);

    if (next.enabled && !previous.enabled) {
      try {
        await registerMcpServer();
      } catch (error: any) {
        console.error('[Tasks] Failed to register MCP on enable:', error?.message || error);
      }
    } else if (!next.enabled && previous.enabled) {
      try {
        await unregisterMcpServer();
      } catch (error: any) {
        console.error('[Tasks] Failed to unregister MCP on disable:', error?.message || error);
      }
    }

    return next;
  },

  /**
   * Returns the MCP bearer token. Lazy-creates and persists on first read.
   */
  getMcpToken(): string {
    return getOrCreateMcpToken();
  },

  /**
   * Lists tasks for a project. The projectId is mandatory — we never query
   * across projects. Quarantined tasks are excluded unless
   * `includeQuarantined` is set.
   */
  listTasks(projectId: string, filter: Omit<ListTasksFilter, 'projectId'> = {}): Task[] {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return [];
    let tasks = listTasksFromDisk(tasksDir, filter.includeQuarantined === true);
    if (filter.status) {
      const wanted = filter.status;
      tasks = tasks.filter((task) => task.status === wanted);
    }
    if (filter.taskType) {
      const wanted = filter.taskType;
      tasks = tasks.filter((task) => task.taskType === wanted);
    }
    if (filter.priority) {
      const wanted = filter.priority;
      tasks = tasks.filter((task) => task.priority === wanted);
    }
    if (filter.agent) {
      const wanted = filter.agent;
      tasks = tasks.filter((task) => task.agent === wanted);
    }
    tasks.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (typeof filter.limit === 'number' && filter.limit > 0) {
      tasks = tasks.slice(0, filter.limit);
    }
    return tasks;
  },

  /**
   * Returns a task by id within a project, or null if not found.
   */
  getTask(projectId: string, id: string): Task | null {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    try {
      const found = findTaskOnDisk(tasksDir, id);
      return found?.task ?? null;
    } catch (error: any) {
      console.warn('[Tasks] getTask failed:', error?.message || error);
      return null;
    }
  },

  /**
   * Aggregate counts by status for a project — handy for the UI toolbar.
   */
  getStats(projectId: string): Record<TaskStatus, number> {
    const tasksDir = resolveTasksDir(projectId);
    const stats: Record<TaskStatus, number> = {
      submitted: 0,
      pending: 0,
      approved: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    if (!tasksDir) return stats;
    for (const task of listTasksFromDisk(tasksDir, false)) {
      stats[task.status] += 1;
    }
    return stats;
  },

  /**
   * Creates a new task. Called primarily from the MCP bridge with `projectId`
   * stamped by the sidecar — the agent never sets it.
   *
   * `autoApprove` (default `false`) skips the manual approval gate: the
   * task lands in `in_progress` with `startedAt` already set. The MCP path
   * always sets this — when an LLM creates a task, it's already executing
   * (it just hasn't reported back yet). The REST path defaults to `false`
   * so operator-queued tasks still wait for approval.
   */
  async createTask(input: {
    projectId: string;
    agent?: string | null;
    title: string;
    description?: string;
    prompt: string;
    taskType?: TaskType | null;
    riskLevel?: RiskLevel | null;
    priority?: Priority | null;
    contextRefs?: string[] | null;
    createdBy?: string | null;
    autoApprove?: boolean;
  }): Promise<Task | null> {
    const tasksDir = resolveTasksDir(input.projectId);
    if (!tasksDir) {
      console.warn('[Tasks] createTask rejected: unknown projectId', input.projectId);
      return null;
    }
    const now = nowIso();
    const id = generateId();
    const createdBy = input.createdBy ? String(input.createdBy) : null;
    const agent = input.agent ? String(input.agent) : 'agent';
    const autoApprove = input.autoApprove === true;

    // Auto-approved tasks (the MCP orchestrator path) start at in_progress
    // with `startedAt` populated — the LLM is already executing the work.
    // Operator-queued tasks still go through the manual submitted → approved
    // → in_progress flow so an operator has a chance to triage.
    const initialStatus: TaskStatus = autoApprove ? 'in_progress' : 'submitted';

    const task: Task = {
      id,
      projectId: input.projectId,
      agent,
      title: String(input.title || '').trim() || 'Untitled task',
      description: String(input.description || '').trim(),
      prompt: String(input.prompt || '').trim(),
      taskType: normalizeTaskType(input.taskType),
      riskLevel: normalizeRiskLevel(input.riskLevel),
      priority: normalizePriority(input.priority),
      contextRefs: normalizeContextRefs(input.contextRefs),
      history: [
        {
          at: now,
          actor: createdBy ?? agent,
          role: 'agent',
          action: 'created',
          status: initialStatus,
        },
        ...(autoApprove
          ? [{
              at: now,
              actor: createdBy ?? agent,
              role: 'agent' as const,
              action: 'status_changed' as const,
              fromStatus: 'submitted' as TaskStatus,
              status: 'in_progress' as TaskStatus,
              note: 'Auto-approved on create (orchestrator path).',
            }]
          : []),
      ],
      status: initialStatus,
      quarantined: false,
      createdAt: now,
      updatedAt: now,
      startedAt: autoApprove ? now : null,
      completedAt: null,
      result: null,
      error: null,
      createdBy,
    };

    const filePath = taskFilePath(tasksDir, id, false);
    await withTaskLock(filePath, async () => {
      writeTaskAtomic(filePath, task);
    });
    broadcastQueueUpdated(input.projectId);
    return task;
  },

  /**
   * Agent-driven completion. Called by the orchestrator path
   * (`tasks_complete` MCP tool) when the LLM finishes the work it filed
   * via `tasks_create`. Sets `status: 'completed'`, `result`, and
   * `completedAt`. Role is forced to `'agent'` and actor is stamped from
   * the sidecar's `chatRunId` so the audit trail reflects who reported.
   *
   * Refuses to update tasks in a terminal state (idempotent: returns the
   * existing task instead of erroring) — protects against double-complete
   * from retries.
   */
  async completeTaskByAgent(
    projectId: string,
    id: string,
    input: { result?: string | null; chatRunId?: string | null; note?: string | undefined } = {},
  ): Promise<Task | null> {
    return this.updateTaskStatus(projectId, id, 'completed', {
      actor: input.chatRunId ? `mcp:chat-run:${input.chatRunId}` : 'agent',
      role: 'agent',
      result: input.result ?? null,
      error: null,
      note: input.note,
    });
  },

  /**
   * Agent-driven failure. Counterpart to `completeTaskByAgent` for the
   * unhappy path. Sets `status: 'failed'`, `error`, and `completedAt`.
   * Same terminal-state idempotency as the success path.
   */
  async failTaskByAgent(
    projectId: string,
    id: string,
    input: { error?: string | null; chatRunId?: string | null; note?: string | undefined } = {},
  ): Promise<Task | null> {
    return this.updateTaskStatus(projectId, id, 'failed', {
      actor: input.chatRunId ? `mcp:chat-run:${input.chatRunId}` : 'agent',
      role: 'agent',
      result: null,
      error: input.error ?? null,
      note: input.note,
    });
  },

  /**
   * Long-poll for task completion. Backs the `tasks_wait` MCP tool: the
   * LLM files a task, goes off to do other work, then calls
   * `tasks_wait(taskId, { timeoutMs: 60_000 })` to block until the task
   * reaches a terminal state (`completed`, `failed`, or `cancelled`).
   *
   * Implementation: simple in-process poll at 500ms. No new event bus —
   * the YAML write + `broadcastQueueUpdated` already keeps the UI fresh;
   * the LLM just wants to know "done yet?". Capped at the requested
   * `timeoutMs` (default 60s, max 10min) and at 200 iterations as a
   * belt-and-suspenders ceiling against runaway polls.
   */
  async waitForTaskCompletion(
    projectId: string,
    id: string,
    options: { timeoutMs?: number; pollIntervalMs?: number } = {},
  ): Promise<{ task: Task | null; timedOut: boolean }> {
    const timeoutMs = Math.min(
      Math.max(options.timeoutMs ?? 60_000, 1000),
      10 * 60_000,
    );
    const pollIntervalMs = Math.min(
      Math.max(options.pollIntervalMs ?? 500, 100),
      5_000,
    );
    const deadline = Date.now() + timeoutMs;
    let iterations = 0;
    while (Date.now() < deadline && iterations < 200) {
      const task = this.getTask(projectId, id);
      if (!task) return { task: null, timedOut: false };
      if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
        return { task, timedOut: false };
      }
      iterations += 1;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    const task = this.getTask(projectId, id);
    return { task, timedOut: true };
  },

  /**
   * Generic status mutation. Validates the transition is allowed for the
   * supplied actor role; refuses no-op same-status transitions silently.
   */
  async updateTaskStatus(
    projectId: string,
    id: string,
    status: TaskStatus,
    extras: ActorContext & {
      result?: string | null;
      error?: string | null;
    } = { actor: 'agent', role: 'agent' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    let updated: Task | null = null;
    let previousStatus: TaskStatus | null = null;

    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found || found.task.quarantined) {
        updated = null;
        return;
      }
      previousStatus = found.task.status;
      const nextStatus = normalizeStatus(status);
      if (nextStatus === previousStatus) {
        updated = found.task;
        return;
      }
      const now = nowIso();
      let next: Task = {
        ...found.task,
        status: nextStatus,
        updatedAt: now,
      };
      if (nextStatus === 'in_progress' && !next.startedAt) {
        next.startedAt = now;
      }
      if (
        nextStatus === 'completed'
        || nextStatus === 'failed'
        || nextStatus === 'cancelled'
      ) {
        next.completedAt = now;
      }
      if (extras.result !== undefined) next.result = extras.result;
      if (extras.error !== undefined) next.error = extras.error;

      const entry: TaskHistoryEntry = {
        at: now,
        actor: extras.actor,
        role: extras.role,
        action: 'status_changed',
        status: nextStatus,
        fromStatus: previousStatus ?? undefined,
      };
      if (extras.note && extras.note.trim()) entry.note = extras.note.trim();
      next = appendHistoryEntry(next, entry, now);

      const targetPath = taskFilePath(tasksDir, id, false);
      writeTaskAtomic(targetPath, next);
      updated = next;
    });

    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Operator action: approve a submitted/pending task. Agent callers can also
   * use this when running with self-approval rights; role is recorded in the
   * history entry.
   */
  async approveTask(
    projectId: string,
    id: string,
    actor: ActorContext = { actor: 'operator', role: 'operator' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    let updated: Task | null = null;
    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found || found.task.quarantined) {
        updated = null;
        return;
      }
      const current = found.task;
      if (current.status !== 'submitted' && current.status !== 'pending') {
        updated = null;
        return;
      }
      const now = nowIso();
      let next: Task = {
        ...current,
        status: 'approved',
        updatedAt: now,
      };
      const entry: TaskHistoryEntry = {
        at: now,
        actor: actor.actor,
        role: actor.role,
        action: 'approved',
        status: 'approved',
        fromStatus: current.status,
      };
      if (actor.note && actor.note.trim()) entry.note = actor.note.trim();
      next = appendHistoryEntry(next, entry, now);
      writeTaskAtomic(taskFilePath(tasksDir, id, false), next);
      updated = next;
    });
    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Operator action: cancel a non-terminal task with an optional note.
   * Cancelled records are kept (not deleted) for traceability.
   */
  async cancelTask(
    projectId: string,
    id: string,
    actor: ActorContext & { note?: string } = { actor: 'operator', role: 'operator' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    let updated: Task | null = null;
    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found || found.task.quarantined) {
        updated = null;
        return;
      }
      const current = found.task;
      if (current.status === 'completed' || current.status === 'cancelled') {
        updated = null;
        return;
      }
      const now = nowIso();
      let next: Task = {
        ...current,
        status: 'cancelled',
        completedAt: now,
        updatedAt: now,
      };
      const entry: TaskHistoryEntry = {
        at: now,
        actor: actor.actor,
        role: actor.role,
        action: 'cancelled',
        status: 'cancelled',
        fromStatus: current.status,
      };
      if (actor.note && actor.note.trim()) entry.note = actor.note.trim();
      next = appendHistoryEntry(next, entry, now);
      writeTaskAtomic(taskFilePath(tasksDir, id, false), next);
      updated = next;
    });
    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Operator action: move the task file into the `quarantine/` subdir. The
   * file remains readable but is excluded from `listTasks` until restored.
   */
  async quarantineTask(
    projectId: string,
    id: string,
    actor: ActorContext = { actor: 'operator', role: 'operator' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    let updated: Task | null = null;
    await withTaskLock(taskFilePath(tasksDir, id, true), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found) {
        updated = null;
        return;
      }
      if (found.task.quarantined) {
        updated = found.task;
        return;
      }
      const now = nowIso();
      let next: Task = {
        ...found.task,
        quarantined: true,
        updatedAt: now,
      };
      const entry: TaskHistoryEntry = {
        at: now,
        actor: actor.actor,
        role: actor.role,
        action: 'quarantined',
      };
      if (actor.note && actor.note.trim()) entry.note = actor.note.trim();
      next = appendHistoryEntry(next, entry, now);

      const target = taskFilePath(tasksDir, id, true);
      ensureDir(path.dirname(target));
      writeTaskAtomic(target, next);
      // Remove the source file so the two views don't drift.
      try {
        fs.unlinkSync(found.filePath);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') {
          console.warn('[Tasks] Failed to unlink quarantined source:', unlinkError?.message || unlinkError);
        }
      }
      updated = next;
    });
    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Operator action: bring a quarantined task back into the active queue.
   */
  async restoreTask(
    projectId: string,
    id: string,
    actor: ActorContext = { actor: 'operator', role: 'operator' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    let updated: Task | null = null;
    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found) {
        updated = null;
        return;
      }
      if (!found.task.quarantined) {
        updated = found.task;
        return;
      }
      const now = nowIso();
      let next: Task = {
        ...found.task,
        quarantined: false,
        updatedAt: now,
      };
      const entry: TaskHistoryEntry = {
        at: now,
        actor: actor.actor,
        role: actor.role,
        action: 'restored',
      };
      if (actor.note && actor.note.trim()) entry.note = actor.note.trim();
      next = appendHistoryEntry(next, entry, now);

      const target = taskFilePath(tasksDir, id, false);
      ensureDir(path.dirname(target));
      writeTaskAtomic(target, next);
      try {
        fs.unlinkSync(found.filePath);
      } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') {
          console.warn('[Tasks] Failed to unlink restored source:', unlinkError?.message || unlinkError);
        }
      }
      updated = next;
    });
    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Append a free-form note entry without changing status. Useful for
   * operator commentary that should remain on the audit trail.
   */
  async appendNote(
    projectId: string,
    id: string,
    note: string,
    actor: ActorContext = { actor: 'operator', role: 'operator' },
  ): Promise<Task | null> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return null;
    if (!note || !note.trim()) {
      return this.getTask(projectId, id);
    }
    let updated: Task | null = null;
    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found) {
        updated = null;
        return;
      }
      const now = nowIso();
      const entry: TaskHistoryEntry = {
        at: now,
        actor: actor.actor,
        role: actor.role,
        action: 'note',
        note: note.trim(),
      };
      const next = appendHistoryEntry(found.task, entry, now);
      writeTaskAtomic(found.filePath, next);
      updated = next;
    });
    if (updated) broadcastQueueUpdated(projectId);
    return updated;
  },

  /**
   * Removes a task file from disk. The agent UI doesn't expose this; the MCP
   * does (`tasks_delete`) for explicit operator cleanups. Quarantined files
   * are removed too.
   */
  async deleteTask(projectId: string, id: string): Promise<boolean> {
    const tasksDir = resolveTasksDir(projectId);
    if (!tasksDir) return false;
    let removed = false;
    await withTaskLock(taskFilePath(tasksDir, id, false), async () => {
      const found = findTaskOnDisk(tasksDir, id);
      if (!found) {
        removed = false;
        return;
      }
      try {
        fs.unlinkSync(found.filePath);
        removed = true;
      } catch (unlinkError: any) {
        if (unlinkError?.code !== 'ENOENT') {
          console.warn('[Tasks] deleteTask failed:', unlinkError?.message || unlinkError);
        }
        removed = false;
      }
    });
    if (removed) broadcastQueueUpdated(projectId);
    return removed;
  },

  /**
   * Read the latest sidecar snapshot. Exposed for the stdio MCP and for
   * tests; callers should not block on this in hot paths.
   */
  async readSidecar(): Promise<{ chatRunId: string | null; projectId: string | null }> {
    try {
      const raw = await fsp.readFile(TASKS_SIDECAR_FILE, 'utf8');
      const parsed = JSON.parse(raw) as { chatRunId?: unknown; projectId?: unknown };
      return {
        chatRunId: typeof parsed.chatRunId === 'string' ? parsed.chatRunId : null,
        projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      };
    } catch {
      return { chatRunId: null, projectId: null };
    }
  },

  /**
   * Sidecar helpers — exposed for tests and the chat-run-registry module.
   */
  getSidecarFile(): string {
    return TASKS_SIDECAR_FILE;
  },

  /**
   * No-op for parity with browserUseService.stopAll — tasks are pure data.
   */
  stopAll(): void {
    // Nothing to stop: tasks are persisted state, not runtime processes.
  },

  /**
   * Stamps the in-memory MCP activity timestamp. Called by the
   * tasks-mcp HTTP bridge after a successful bearer-token check so
   * that every authenticated tool call (9 tools, see tasks-mcp.routes.ts)
   * refreshes the heartbeat. Failures are not counted.
   */
  markMcpActivity(): void {
    lastMcpActivityAt = Date.now();
  },

  /**
   * Returns the in-memory MCP activity snapshot used by the UI's task-queue
   * health chip. `lastMcpActivityAt` is `null` until the first authenticated
   * MCP tool call lands — which the panel surfaces as a warning so a dead
   * cloudcli-tasks stdio process is visible without depending on logs.
   */
  getMcpActivity(): { lastMcpActivityAt: number | null } {
    return { lastMcpActivityAt };
  },
};