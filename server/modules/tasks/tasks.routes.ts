import express from 'express';

import { tasksService } from '@/modules/tasks/tasks.service.js';

const router = express.Router();

function readParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function readProjectId(query: express.Request['query']): string | null {
  const raw = query.projectId;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw.trim();
}

router.get('/settings', async (_req, res) => {
  try {
    res.json({ success: true, data: { settings: tasksService.getSettings() } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Tasks settings.',
    });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const settings = await tasksService.updateSettings(req.body || {});
    res.json({ success: true, data: { settings } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Tasks settings.',
    });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const projectId = readProjectId(req.query);
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    res.json({ success: true, data: { stats: tasksService.getStats(projectId) } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Tasks stats.',
    });
  }
});

// Health snapshot for the TaskQueuePanel header chip. Must be registered
// before `/:id` so Express doesn't capture "health" as a task id. Surfaces
// whether the cloudcli-tasks MCP is enabled and when the bridge last saw an
// authenticated tool call — letting the UI distinguish "WebSocket is live"
// from "agents can actually file tasks right now".
router.get('/health', async (_req, res) => {
  try {
    const settings = tasksService.getSettings();
    res.json({
      success: true,
      data: {
        enabled: settings.enabled === true,
        lastMcpActivityAt: tasksService.getMcpActivity().lastMcpActivityAt,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Tasks health.',
    });
  }
});

router.get('/', async (req, res) => {
  try {
    const projectId = readProjectId(req.query);
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const taskType = typeof req.query.taskType === 'string' ? req.query.taskType : undefined;
    const priority = typeof req.query.priority === 'string' ? req.query.priority : undefined;
    const agent = typeof req.query.agent === 'string' ? req.query.agent : undefined;
    const limit = req.query.limit ? Number.parseInt(String(req.query.limit), 10) : undefined;
    const includeQuarantined = req.query.includeQuarantined === 'true';

    const tasks = tasksService.listTasks(projectId, {
      status: status as any,
      taskType: taskType as any,
      priority: priority as any,
      agent,
      includeQuarantined,
      limit: Number.isFinite(limit as number) ? (limit as number) : undefined,
    });
    res.json({ success: true, data: { tasks } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list tasks.',
    });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const projectId = readProjectId(req.query);
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = tasksService.getTask(projectId, readParam(req.params.id));
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load task.',
    });
  }
});

router.post('/', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = await tasksService.createTask({
      projectId,
      agent: typeof body.agent === 'string' ? body.agent : null,
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : '',
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      taskType: typeof body.taskType === 'string' ? (body.taskType as any) : null,
      riskLevel: typeof body.riskLevel === 'string' ? (body.riskLevel as any) : null,
      priority: typeof body.priority === 'string' ? (body.priority as any) : null,
      contextRefs: Array.isArray(body.contextRefs)
        ? (body.contextRefs as string[])
        : null,
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : null,
    });
    if (!task) {
      res.status(404).json({ success: false, error: 'Unknown projectId.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create task.',
    });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const status = typeof body.status === 'string' ? body.status : '';
    if (!['submitted', 'pending', 'approved', 'in_progress', 'completed', 'failed', 'cancelled'].includes(status)) {
      res.status(400).json({ success: false, error: 'Invalid status.' });
      return;
    }
    const task = await tasksService.updateTaskStatus(
      projectId,
      readParam(req.params.id),
      status as any,
      {
        actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor : 'operator',
        role: body.role === 'agent' ? 'agent' : 'operator',
        result: typeof body.result === 'string' ? body.result : null,
        error: typeof body.error === 'string' ? body.error : null,
        note: typeof body.note === 'string' ? body.note : undefined,
      },
    );
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update task status.',
    });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = await tasksService.approveTask(projectId, readParam(req.params.id), {
      actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor : 'operator',
      role: body.role === 'agent' ? 'agent' : 'operator',
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found or not in a pending state.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to approve task.',
    });
  }
});

router.post('/:id/cancel', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = await tasksService.cancelTask(projectId, readParam(req.params.id), {
      actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor : 'operator',
      role: body.role === 'agent' ? 'agent' : 'operator',
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found or already terminal.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel task.',
    });
  }
});

router.post('/:id/quarantine', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = await tasksService.quarantineTask(projectId, readParam(req.params.id), {
      actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor : 'operator',
      role: body.role === 'agent' ? 'agent' : 'operator',
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to quarantine task.',
    });
  }
});

router.post('/:id/restore', async (req, res) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const projectId = typeof body.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const task = await tasksService.restoreTask(projectId, readParam(req.params.id), {
      actor: typeof body.actor === 'string' && body.actor.trim() ? body.actor : 'operator',
      role: body.role === 'agent' ? 'agent' : 'operator',
      note: typeof body.note === 'string' ? body.note : undefined,
    });
    if (!task) {
      res.status(404).json({ success: false, error: 'Task not found or not quarantined.' });
      return;
    }
    res.json({ success: true, data: { task } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to restore task.',
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const projectId = readProjectId(req.query);
    if (!projectId) {
      res.status(400).json({ success: false, error: 'projectId is required.' });
      return;
    }
    const removed = await tasksService.deleteTask(projectId, readParam(req.params.id));
    if (!removed) {
      res.status(404).json({ success: false, error: 'Task not found.' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to delete task.',
    });
  }
});

export default router;