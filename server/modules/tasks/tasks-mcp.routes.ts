import express from 'express';

import { tasksService } from '@/modules/tasks/tasks.service.js';

const router = express.Router();

function readBearerToken(header: unknown): string | null {
  if (typeof header !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

router.use((req, res, next) => {
  const expected = tasksService.getMcpToken();
  const token = readBearerToken(req.headers.authorization)
    || String(req.headers['x-tasks-mcp-token'] || '');
  if (!token || token !== expected) {
    res.status(401).json({ success: false, error: 'Invalid Tasks MCP token.' });
    return;
  }
  // Stamp the activity heartbeat only on authenticated calls — failed
  // token checks don't count, so the UI's health chip won't be lulled
  // into "healthy" by a misconfigured client sending bad bearer tokens.
  tasksService.markMcpActivity();
  next();
});

router.post('/tools/:toolName', async (req, res) => {
  try {
    const toolName = req.params.toolName;
    const input = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    let result: unknown;

    switch (toolName) {
      case 'tasks_list': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        if (!projectId) {
          res.status(400).json({ success: false, error: 'projectId is required.' });
          return;
        }
        const status = typeof input.status === 'string' ? input.status : undefined;
        const taskType = typeof input.taskType === 'string' ? input.taskType : undefined;
        const priority = typeof input.priority === 'string' ? input.priority : undefined;
        const agent = typeof input.agent === 'string' ? input.agent : undefined;
        const limit = typeof input.limit === 'number' ? input.limit : undefined;
        result = {
          tasks: tasksService.listTasks(projectId, {
            status: status as any,
            taskType: taskType as any,
            priority: priority as any,
            agent,
            includeQuarantined: true,
            limit,
          }),
          stats: tasksService.getStats(projectId),
        };
        break;
      }
      case 'tasks_get': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const task = tasksService.getTask(projectId, id);
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_create': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const title = typeof input.title === 'string' ? input.title : '';
        const prompt = typeof input.prompt === 'string' ? input.prompt : '';
        if (!projectId || !title.trim() || !prompt.trim()) {
          res.status(400).json({
            success: false,
            error: 'projectId, title, and prompt are required.',
          });
          return;
        }
        const task = await tasksService.createTask({
          projectId,
          agent: typeof input.agent === 'string' ? input.agent : null,
          title,
          description: typeof input.description === 'string' ? input.description : '',
          prompt,
          taskType: typeof input.taskType === 'string' ? (input.taskType as any) : null,
          riskLevel: typeof input.riskLevel === 'string' ? (input.riskLevel as any) : null,
          priority: typeof input.priority === 'string' ? (input.priority as any) : null,
          contextRefs: Array.isArray(input.contextRefs)
            ? (input.contextRefs as string[])
            : null,
          // The stdio MCP server injects `chatRunId` from the sidecar cache;
          // persist it as `createdBy` so we can correlate the agent that
          // originally filed the task.
          createdBy:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.createdBy === 'string'
                ? input.createdBy
                : null,
          // MCP orchestrator path: when the LLM creates a task it has already
          // started executing — skip the manual approval gate and land at
          // `in_progress`. Operators wanting the manual flow still use the
          // REST `POST /api/tasks` which defaults to submitted.
          autoApprove: true,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Unknown projectId.' });
          return;
        }
        result = { task };
        break;
      }

      case 'tasks_complete': {
        // Agent-driven completion: the LLM finishes the work it filed via
        // `tasks_create` and reports the result back. Sets status=completed
        // + `result` + `completedAt`. Idempotent — re-completing a finished
        // task returns the existing record instead of erroring.
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({
            success: false,
            error: 'projectId and id are required.',
          });
          return;
        }
        const task = await tasksService.completeTaskByAgent(projectId, id, {
          result: typeof input.result === 'string' ? input.result : null,
          chatRunId: typeof input.chatRunId === 'string' ? input.chatRunId : null,
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task };
        break;
      }

      case 'tasks_fail': {
        // Agent-driven failure: counterpart of tasks_complete for the
        // unhappy path. Same idempotency — re-failing a finished task
        // returns the existing record.
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({
            success: false,
            error: 'projectId and id are required.',
          });
          return;
        }
        const task = await tasksService.failTaskByAgent(projectId, id, {
          error: typeof input.error === 'string' ? input.error : null,
          chatRunId: typeof input.chatRunId === 'string' ? input.chatRunId : null,
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task };
        break;
      }

      case 'tasks_wait': {
        // Long-poll: the LLM files a task, does other work, then blocks
        // here until the task reaches a terminal state (or timeoutMs
        // elapses). Backed by waitForTaskCompletion in the service.
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({
            success: false,
            error: 'projectId and id are required.',
          });
          return;
        }
        const timeoutMs = readNumber(input.timeoutMs);
        const pollIntervalMs = readNumber(input.pollIntervalMs);
        const { task, timedOut } = await tasksService.waitForTaskCompletion(projectId, id, {
          timeoutMs,
          pollIntervalMs,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task, timedOut };
        break;
      }
      case 'tasks_update_status': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        const status = typeof input.status === 'string' ? input.status : '';
        if (!projectId || !id || !status) {
          res.status(400).json({
            success: false,
            error: 'projectId, id, and status are required.',
          });
          return;
        }
        if (
          !['submitted', 'pending', 'approved', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status)
        ) {
          res.status(400).json({ success: false, error: `Invalid status "${status}".` });
          return;
        }
        const task = await tasksService.updateTaskStatus(projectId, id, status as any, {
          actor:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.actor === 'string'
                ? input.actor
                : 'agent',
          role: 'agent',
          result: typeof input.result === 'string' ? input.result : null,
          error: typeof input.error === 'string' ? input.error : null,
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_approve': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const task = await tasksService.approveTask(projectId, id, {
          actor:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.actor === 'string'
                ? input.actor
                : 'operator',
          role: 'operator',
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found or not in a pending state.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_cancel': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const task = await tasksService.cancelTask(projectId, id, {
          actor:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.actor === 'string'
                ? input.actor
                : 'operator',
          role: 'operator',
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found or already terminal.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_quarantine': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const task = await tasksService.quarantineTask(projectId, id, {
          actor:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.actor === 'string'
                ? input.actor
                : 'operator',
          role: 'operator',
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_restore': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const task = await tasksService.restoreTask(projectId, id, {
          actor:
            typeof input.chatRunId === 'string'
              ? `mcp:chat-run:${input.chatRunId}`
              : typeof input.actor === 'string'
                ? input.actor
                : 'operator',
          role: 'operator',
          note: typeof input.note === 'string' ? input.note : undefined,
        });
        if (!task) {
          res.status(404).json({ success: false, error: 'Task not found or not quarantined.' });
          return;
        }
        result = { task };
        break;
      }
      case 'tasks_delete': {
        const projectId = typeof input.projectId === 'string' ? input.projectId : '';
        const id = typeof input.id === 'string' ? input.id : '';
        if (!projectId || !id) {
          res.status(400).json({ success: false, error: 'projectId and id are required.' });
          return;
        }
        const removed = await tasksService.deleteTask(projectId, id);
        if (!removed) {
          res.status(404).json({ success: false, error: 'Task not found.' });
          return;
        }
        result = { deleted: true };
        break;
      }
      default:
        res.status(404).json({ success: false, error: `Unknown Tasks MCP tool "${toolName}".` });
        return;
    }

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Tasks MCP tool failed.',
    });
  }
});

export default router;