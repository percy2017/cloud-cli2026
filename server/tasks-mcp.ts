#!/usr/bin/env node
import './load-env.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { LLMProvider } from './shared/types.js';

const ALLOWED_PROVIDERS: ReadonlySet<LLMProvider> = new Set([
  'claude',
  'codex',
  'gemini',
  'cursor',
  'opencode',
]);

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
};

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const textResponse = (text: string) => ({
  content: [{ type: 'text', text }],
});

const jsonResponse = (value: unknown) => textResponse(JSON.stringify(value, null, 2));

const readString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
};

const readOptionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const readStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) out.push(entry.trim());
  }
  return out;
};

const apiUrl = (process.env.CLOUDCLI_TASKS_API_URL || 'http://127.0.0.1:3001/api/tasks-mcp').replace(/\/$/, '');
const apiToken = process.env.CLOUDCLI_TASKS_MCP_TOKEN || '';
const API_TIMEOUT_MS = Number.parseInt(process.env.CLOUDCLI_TASKS_API_TIMEOUT_MS || '30000', 10);

// Sidecar file written by chat-run-registry on every chat run start. The stdio
// MCP server reads it (1-second TTL cache) to inject chatRunId into every tool
// call so the HTTP bridge can correlate mutations with the active chat run.
const SIDECAR_FILE = path.join(process.env.HOME || os.homedir(), '.cloudcli', 'tasks', 'current-chat-run.json');
const SIDECAR_CACHE_MS = 1000;
let sidecarCache: { value: string | null; readAt: number } = { value: null, readAt: 0 };

type SidecarSnapshot = {
  chatRunId: string | null;
  projectId: string | null;
  provider: LLMProvider | null;
};

let sidecarSnapshot: SidecarSnapshot = { chatRunId: null, projectId: null, provider: null };

async function readCurrentChatRunSidecar(): Promise<SidecarSnapshot> {
  const now = Date.now();
  if (now - sidecarCache.readAt < SIDECAR_CACHE_MS) {
    return sidecarSnapshot;
  }
  try {
    const raw = await fsp.readFile(SIDECAR_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { chatRunId?: unknown; projectId?: unknown; provider?: unknown };
    const providerValue = typeof parsed.provider === 'string' ? parsed.provider : null;
    sidecarSnapshot = {
      chatRunId: typeof parsed.chatRunId === 'string' ? parsed.chatRunId : null,
      projectId: typeof parsed.projectId === 'string' ? parsed.projectId : null,
      provider: providerValue && ALLOWED_PROVIDERS.has(providerValue as LLMProvider)
        ? (providerValue as LLMProvider)
        : null,
    };
    sidecarCache = { value: sidecarSnapshot.chatRunId, readAt: now };
  } catch {
    sidecarSnapshot = { chatRunId: null, projectId: null, provider: null };
    sidecarCache = { value: null, readAt: now };
  }
  return sidecarSnapshot;
}

async function readCurrentChatRunId(): Promise<string | null> {
  return (await readCurrentChatRunSidecar()).chatRunId;
}

async function withChatRunId(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const snapshot = await readCurrentChatRunSidecar();
  const enriched: Record<string, unknown> = { ...args };
  if (snapshot.chatRunId) enriched.chatRunId = snapshot.chatRunId;
  if (snapshot.projectId && !enriched.projectId) enriched.projectId = snapshot.projectId;
  if (snapshot.provider) enriched.provider = snapshot.provider;
  return enriched;
}

async function callTasksApi(toolName: string, input: Record<string, unknown>) {
  if (!apiToken) {
    throw new Error('CLOUDCLI_TASKS_MCP_TOKEN is not configured.');
  }

  const enrichedInput = await withChatRunId(input);
  const response = await fetch(`${apiUrl}/tools/${encodeURIComponent(toolName)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(enrichedInput),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const data = await response.json() as { success?: boolean; data?: unknown; error?: string };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Tasks API request failed (${response.status})`);
  }
  return data.data;
}

const TASK_TYPES = ['build', 'deploy', 'fix', 'research', 'review', 'audit', 'notify', 'other'];
const RISK_LEVELS = ['low', 'medium', 'high'];
const PRIORITIES = ['normal', 'high', 'urgent'];
const TASK_STATUSES = [
  'submitted',
  'pending',
  'approved',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

// Module-level instructions returned in `initialize` per MCP 2025-03-26.
// Claude Code, Cursor, and Gemini all forward this string to the LLM as the
// server's high-level overview, so it is the right place to teach the
// orchestrator pattern + decision heuristics. Per-tool descriptions below
// stay compact and cross-reference this block.
const INSTRUCTIONS = `cloudcli-tasks is a per-project task orchestrator and audit log, provider-independent: it works the same whether you are running inside Claude Code's Task tool, Cursor agent mode, Google Gemini delegation, or executing inline. Every tool call is automatically tagged with the active chat-run, project, and provider via a sidecar cache, so you usually do not need to pass \`projectId\` yourself.

You have two usage patterns to choose between:

1. **Orchestrator pattern (auto-approve, default).** Call \`tasks_create\` to file a task, do the work yourself or delegate it (e.g. spawn a sub-agent), then call \`tasks_complete\` with a short result summary or \`tasks_fail\` with the error. The HTTP bridge skips the manual approval gate on MCP-created tasks and lands them directly at \`in_progress\`, so the create → complete pair is the canonical happy path. This pattern is correct whenever *you* (or a sub-agent you delegate to) will perform the work in this turn or a follow-up turn.

2. **Operator queue pattern (manual approval).** Call \`tasks_create\` and then stop. The task lands in the queue as \`submitted\` / \`pending\` and a human operator must call \`tasks_approve\` (or \`tasks_cancel\` / \`tasks_quarantine\`) from the cloud-cli UI or REST API before any agent picks it up. Use this when a human must sign off before the work runs — production deploys, destructive fixes, anything where you want a paper trail before side effects.

Decision heuristics — choose the orchestrator pattern unless one of these holds:
- The user explicitly asked to "queue this for later" or "let me approve it first."
- The action is destructive (prod deploy, data migration, infra change) and policy requires operator sign-off.
- You are filing work for a different agent role that runs asynchronously and you do not want to block this turn — pair \`tasks_create\` with \`tasks_wait\` to long-poll until it reaches a terminal state.

Do not use this MCP for trivial synchronous work that fits in a single tool call (reading a file, running a unit test, formatting a paragraph). The task system is for work you want recorded, queued, delegated, or audited.

\`tasks_list\` and \`tasks_get\` are read-only and safe to call any time. \`tasks_update_status\` is a low-level escape hatch — prefer the dedicated terminal tools so the bridge encodes the correct actor role and idempotency rules.`;

const tools: ToolDefinition[] = [
  {
    name: 'tasks_list',
    description:
      'List tasks for the active project with optional filters. Returns `{ tasks: Task[], stats }` where `stats` summarises counts by status for the project. `projectId` is auto-filled from the chat-run sidecar when omitted; pass it explicitly only when querying a different project than the active one.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project id. Auto-filled from the chat-run sidecar if omitted.',
        },
        status: {
          type: 'string',
          enum: TASK_STATUSES,
          description: 'Filter by task status.',
        },
        taskType: {
          type: 'string',
          enum: TASK_TYPES,
          description: 'Filter by semantic task type.',
        },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: 'Filter by task priority.',
        },
        agent: {
          type: 'string',
          description: 'Filter by agent role (e.g. "sysadmin", "developer").',
        },
        limit: { type: 'number', description: 'Maximum number of tasks to return.' },
      },
    },
  },
  {
    name: 'tasks_get',
    description:
      'Fetch a single task by id, including its full status, prompt, result, error, contextRefs, and audit trail. Returns `{ task }`. Use this when you need the current state of a task you previously filed or were handed — for example before deciding to call `tasks_complete`, `tasks_cancel`, or `tasks_update_status`.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_create',
    description:
      'File a new task in the active project\'s queue; returns `{ task }`. The HTTP bridge auto-approves MCP-created tasks and sets `status: \'in_progress\'` with `startedAt`, so after this call you are expected to either do the work and call `tasks_complete`, fail with `tasks_fail`, or hand the task to a sub-agent and optionally long-poll with `tasks_wait`. Required: `title` and `prompt`. Optional but recommended: `taskType` (one of the eight semantic kinds), `riskLevel` (`low`/`medium`/`high`), `priority` (`normal`/`high`/`urgent`), and `contextRefs` (file paths the executor should consult first).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Project id. Auto-filled from the chat-run sidecar if omitted.',
        },
        agent: {
          type: 'string',
          description: 'Optional agent role ("sysadmin", "developer", ...). Defaults to "agent".',
        },
        title: { type: 'string', description: 'Short task title.' },
        description: { type: 'string', description: 'Optional longer description.' },
        prompt: { type: 'string', description: 'The prompt to send to the agent.' },
        taskType: {
          type: 'string',
          enum: TASK_TYPES,
          description: 'Semantic task type. Defaults to "other".',
        },
        riskLevel: {
          type: 'string',
          enum: RISK_LEVELS,
          description: 'Risk surface of the operation. Defaults to "low".',
        },
        priority: {
          type: 'string',
          enum: PRIORITIES,
          description: 'Operator-set urgency. Defaults to "normal".',
        },
        contextRefs: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file paths the agent should consult before/during the run.',
        },
      },
      required: ['title', 'prompt'],
    },
  },
  {
    name: 'tasks_update_status',
    description:
      'Low-level mutation that moves a task to a new status, optionally recording `result`, `error`, or a `note`. Use this for non-terminal progress notes or to manually transition to `in_progress` after a manual review — for terminal transitions (`completed` / `failed` / `cancelled`) prefer `tasks_complete`, `tasks_fail`, and `tasks_cancel` respectively so the bridge records the correct actor role and applies the idempotency guards. `status` must be one of the seven enum values.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
        status: {
          type: 'string',
          enum: TASK_STATUSES,
          description: 'New task status.',
        },
        result: { type: 'string', description: 'Optional result text.' },
        error: { type: 'string', description: 'Optional error text.' },
        note: { type: 'string', description: 'Optional human note describing the transition.' },
      },
      required: ['id', 'status'],
    },
  },
  {
    name: 'tasks_approve',
    description:
      'Operator action: approve a `submitted` or `pending` task so it becomes eligible for an agent to pick up. Use this when YOU are the human-in-the-loop reviewing a task filed by a sub-agent or queued by a previous turn; the orchestrator pattern (where you do the work yourself) does not need approval because `tasks_create` already auto-approves. Returns `{ task }`.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
        note: { type: 'string', description: 'Optional human note.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_cancel',
    description:
      'Operator action: cancel a non-terminal task. The record stays in the project history as `cancelled` and is visible via `tasks_list`. Use this to abandon work you no longer intend to run (e.g. after a re-plan), or to halt an in-flight orchestrator task you filed earlier in this session. Terminal tasks are already immutable and will return 404.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
        note: { type: 'string', description: 'Optional cancellation reason.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_quarantine',
    description:
      'Operator action: move the task out of the active queue into a quarantine folder. The task is hidden from `tasks_list` until restored. Use this for tasks you want to suspend without deleting — e.g. spam, malformed inputs, or work that is blocked on a decision you are not ready to make.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
        note: { type: 'string', description: 'Optional reason for quarantining.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_restore',
    description:
      'Operator action: bring a quarantined task back into the active queue at its prior status. Pair with `tasks_quarantine` — call `tasks_get` first if you need to confirm the task id and current state before restoring.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
        note: { type: 'string', description: 'Optional note.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_delete',
    description:
      'Hard-delete a task from the queue and remove its file from disk. Use sparingly — prefer `tasks_cancel` (keeps the audit trail) or `tasks_quarantine` (reversible) over deletion. Returns `{ deleted: true }`.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id.' },
        id: { type: 'string', description: 'Task id.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_complete',
    description:
      'Mark an in-progress task as successfully finished. Returns `{ task }` with `status: "completed"`, `result`, and `completedAt` set. This is the canonical happy-path counterpart to `tasks_create` in the orchestrator pattern — call it once the work you filed has finished (whether you did it inline, delegated to a sub-agent, or waited via `tasks_wait`). Idempotent: re-completing a finished task returns the existing record instead of erroring.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id. Auto-filled from the chat-run sidecar if omitted.' },
        id: { type: 'string', description: 'Task id returned by `tasks_create`.' },
        result: { type: 'string', description: 'Short text summary of what was done. Recommended; surfaces in the project audit log and UI.' },
        note: { type: 'string', description: 'Optional human note explaining how the work was performed.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_fail',
    description:
      'Mark an in-progress task as failed. Returns `{ task }` with `status: "failed"`, `error`, and `completedAt` set. Call this when work you filed via `tasks_create` could not be completed — exceptions, missing preconditions, validation failures, or unrecoverable sub-agent errors. Idempotent: re-failing a finished task returns the existing record. Prefer this over `tasks_update_status(status="failed")` so the bridge records the correct agent actor.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id. Auto-filled from the chat-run sidecar if omitted.' },
        id: { type: 'string', description: 'Task id returned by `tasks_create`.' },
        error: { type: 'string', description: 'Short error message or stack-trace excerpt explaining the failure. Recommended; surfaces in the audit log and UI.' },
        note: { type: 'string', description: 'Optional human note about retry plan or follow-up actions.' },
      },
      required: ['id'],
    },
  },
  {
    name: 'tasks_wait',
    description:
      'Long-poll a task until it reaches a terminal state (`completed`, `failed`, or `cancelled`) or the timeout elapses. Returns `{ task, timedOut }`. Use this when you filed a task and want to block this turn until a delegated worker finishes — e.g. you spawned a sub-agent, kicked off a long-running build, or queued work for an external orchestrator. Defaults: timeout 60s (max 10min), poll interval 500ms. If `timedOut` is true the task is still non-terminal — call `tasks_wait` again or check progress with `tasks_get`.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project id. Auto-filled from the chat-run sidecar if omitted.' },
        id: { type: 'string', description: 'Task id returned by `tasks_create`.' },
        timeoutMs: { type: 'number', description: 'Maximum time to block in milliseconds. Defaults to 60000; capped at 600000 (10 min) by the bridge.' },
        pollIntervalMs: { type: 'number', description: 'Polling cadence in milliseconds. Defaults to 500; capped at 5000 by the bridge.' },
      },
      required: ['id'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>) {
  switch (name) {
    case 'tasks_list':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        status: readOptionalString(args.status),
        taskType: readOptionalString(args.taskType),
        priority: readOptionalString(args.priority),
        agent: readOptionalString(args.agent),
        limit: readNumber(args.limit),
      }));
    case 'tasks_get':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
      }));
    case 'tasks_create':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        agent: readOptionalString(args.agent),
        title: readString(args.title, 'title'),
        description: readOptionalString(args.description),
        prompt: readString(args.prompt, 'prompt'),
        taskType: readOptionalString(args.taskType),
        riskLevel: readOptionalString(args.riskLevel),
        priority: readOptionalString(args.priority),
        contextRefs: readStringArray(args.contextRefs),
      }));
    case 'tasks_update_status':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        status: readString(args.status, 'status'),
        result: readOptionalString(args.result),
        error: readOptionalString(args.error),
        note: readOptionalString(args.note),
      }));
    case 'tasks_approve':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        note: readOptionalString(args.note),
      }));
    case 'tasks_cancel':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        note: readOptionalString(args.note),
      }));
    case 'tasks_quarantine':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        note: readOptionalString(args.note),
      }));
    case 'tasks_restore':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        note: readOptionalString(args.note),
      }));
    case 'tasks_delete':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
      }));
    case 'tasks_complete':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        result: readOptionalString(args.result),
        note: readOptionalString(args.note),
      }));
    case 'tasks_fail':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        error: readOptionalString(args.error),
        note: readOptionalString(args.note),
      }));
    case 'tasks_wait':
      return jsonResponse(await callTasksApi(name, {
        projectId: readOptionalString(args.projectId),
        id: readString(args.id, 'id'),
        timeoutMs: readNumber(args.timeoutMs),
        pollIntervalMs: readNumber(args.pollIntervalMs),
      }));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function handleMessage(message: JsonRpcRequest) {
  if (message.method === 'initialize') {
    return {
      // 2025-03-26 introduces the `instructions` field on InitializeResult; the
      // previous protocol version silently dropped it.
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'cloudcli-tasks', version: '1.2.0' },
      instructions: INSTRUCTIONS,
    };
  }

  if (message.method === 'tools/list') {
    return { tools };
  }

  if (message.method === 'tools/call') {
    const params = message.params || {};
    const name = readString(params.name, 'name');
    const args = (params.arguments && typeof params.arguments === 'object'
      ? params.arguments
      : {}) as Record<string, unknown>;
    return callTool(name, args);
  }

  if (message.method.startsWith('notifications/')) {
    return undefined;
  }

  throw new Error(`Unsupported method: ${message.method}`);
}

function writeMessage(message: Record<string, unknown>) {
  // MCP stdio transport uses newline-delimited JSON (one JSON-RPC message per line,
  // no embedded newlines). This is NOT the LSP Content-Length framing.
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: string | number | null | undefined, result: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({ jsonrpc: '2.0', id, result });
}

function sendError(id: string | number | null | undefined, error: unknown) {
  if (id === undefined) {
    return;
  }
  writeMessage({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const rawMessage = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!rawMessage) {
      continue;
    }

    void (async () => {
      let request: JsonRpcRequest;
      try {
        request = JSON.parse(rawMessage) as JsonRpcRequest;
      } catch (error) {
        sendError(null, error);
        return;
      }
      try {
        const result = await handleMessage(request);
        sendResult(request.id, result);
      } catch (error) {
        sendError(request.id, error);
      }
    })();
  }
});
