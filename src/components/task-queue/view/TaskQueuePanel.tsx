import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useWebSocket } from '../../../contexts/WebSocketContext';
import { api, authenticatedFetch } from '../../../utils/api';
import type { Project } from '../../../types/app';

import TaskDetailModal from './TaskDetailModal';

type ActionPath = 'approve' | 'cancel' | 'quarantine' | 'restore' | 'delete';

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

export type Priority = 'normal' | 'high' | 'urgent';

export type TaskHistoryEntry = {
  at: string;
  actor: string;
  role: 'agent' | 'operator';
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

export type QueueTask = {
  id: string;
  projectId: string;
  agent: string;
  title: string;
  description: string;
  prompt: string;
  taskType: TaskType;
  riskLevel: 'low' | 'medium' | 'high';
  priority: Priority;
  contextRefs: string[];
  history: TaskHistoryEntry[];
  status: TaskStatus;
  quarantined: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: string | null;
  error: string | null;
  createdBy: string | null;
};

const STATUS_OPTIONS: TaskStatus[] = [
  'submitted',
  'pending',
  'approved',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
];

const TYPE_OPTIONS: TaskType[] = [
  'build',
  'deploy',
  'fix',
  'research',
  'review',
  'audit',
  'notify',
  'other',
];

function statusDotClasses(status: TaskStatus): string {
  switch (status) {
    case 'submitted':
      return 'bg-blue-500';
    case 'pending':
      return 'bg-amber-500';
    case 'approved':
      return 'bg-indigo-500';
    case 'in_progress':
      // Orchestrator-driven tasks: the LLM is mid-execution. Pulse the dot
      // so the operator can tell at a glance which rows are live.
      return 'bg-purple-500 animate-pulse';
    case 'completed':
      return 'bg-emerald-500';
    case 'failed':
      return 'bg-red-500';
    case 'cancelled':
      return 'bg-gray-400';
    default:
      return 'bg-gray-400';
  }
}

// Single-line preview of `result` / `error` for completed/failed rows. Keeps
// the panel scannable — full output lives in the detail modal.
function previewLine(value: string | null, maxChars = 80): string | null {
  if (!value) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

function formatRelative(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data as T;
}

async function listTasksForProject(projectId: string): Promise<QueueTask[]> {
  const qs = `?projectId=${encodeURIComponent(projectId)}&limit=200&includeQuarantined=true`;
  const response = await authenticatedFetch(`/api/tasks${qs}`);
  const data = await readJson<{ data: { tasks: QueueTask[] } }>(response);
  return Array.isArray(data.data.tasks) ? data.data.tasks : [];
}

type TasksHealth = {
  enabled: boolean;
  lastMcpActivityAt: number | null;
};

async function fetchTasksHealth(): Promise<TasksHealth | null> {
  try {
    const response = await authenticatedFetch('/api/tasks/health');
    const data = await readJson<{ data: TasksHealth }>(response);
    return data.data;
  } catch {
    // Health is informational only — if the endpoint fails (e.g. server
    // restarted), fall back to "no chip" rather than blocking the panel.
    return null;
  }
}

// Age (in ms) after which an MCP that hasn't pinged the bridge is
// considered stale. Five minutes matches the WebSocket reconnect interval
// for chat runs, so anything older means the agent side has gone silent.
const MCP_STALE_AFTER_MS = 5 * 60 * 1000;

async function runAction(
  projectId: string,
  taskId: string,
  path: 'approve' | 'cancel' | 'quarantine' | 'restore',
  note?: string,
): Promise<QueueTask> {
  const response = await authenticatedFetch(
    `/api/tasks/${encodeURIComponent(taskId)}/${path}`,
    {
      method: 'POST',
      body: JSON.stringify({ projectId, note: note ?? null }),
    },
  );
  const data = await readJson<{ data: { task: QueueTask } }>(response);
  return data.data.task;
}

export type TaskQueuePanelProps = {
  selectedProject: Project;
};

export default function TaskQueuePanel({ selectedProject }: TaskQueuePanelProps) {
  const { t } = useTranslation('taskQueue');
  const { subscribe } = useWebSocket();
  const [tasks, setTasks] = useState<QueueTask[]>([]);
  const [statusFilter, setStatusFilter] = useState<TaskStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<TaskType | 'all'>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detailTask, setDetailTask] = useState<QueueTask | null>(null);
  const [pendingDeleteTaskId, setPendingDeleteTaskId] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [health, setHealth] = useState<TasksHealth | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setTasks(await listTasksForProject(selectedProject.projectId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks');
    } finally {
      setIsLoading(false);
    }
  }, [selectedProject.projectId]);

  const loadHealth = useCallback(async () => {
    setHealth(await fetchTasksHealth());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Health snapshot — re-fetched when the active project changes so a fresh
  // session doesn't inherit a stale "no MCP activity" warning from the
  // previous project. The MCP bridge is process-global so this is cheap.
  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  // Live updates: the server pushes `tasks_queue_updated` whenever anything
  // changes inside the active project — re-pull the queue so the panel stays
  // in sync without polling.
  useEffect(() => {
    const unsubscribe = subscribe((message: any) => {
      if (
        message
        && message.kind === 'tasks_queue_updated'
        && (message.projectId == null || message.projectId === selectedProject.projectId)
      ) {
        void load();
      }
    });
    return unsubscribe;
  }, [subscribe, load, selectedProject.projectId]);

  const agents = useMemo(() => {
    const seen = new Set<string>();
    for (const task of tasks) {
      if (task.agent) seen.add(task.agent);
    }
    return Array.from(seen).sort();
  }, [tasks]);

  // Derive the MCP health chip. We only show it when the feature is enabled
  // AND we have evidence the stdio process isn't talking to the bridge —
  // either it's never called (null) or it stopped recently (older than
  // MCP_STALE_AFTER_MS). Healthy MCPs stay silent so the header doesn't
  // compete for attention with the "live" WebSocket badge.
  const healthChip = useMemo(() => {
    if (!health || !health.enabled) return null;
    const last = health.lastMcpActivityAt;
    if (last == null) {
      return {
        key: 'idle',
        dotClass: 'bg-amber-500',
        label: t('header.health.idle'),
        tooltip: t('header.health.idleTooltip'),
      };
    }
    const ageMs = Date.now() - last;
    if (ageMs > MCP_STALE_AFTER_MS) {
      return {
        key: 'stale',
        dotClass: 'bg-amber-500',
        label: t('header.health.stale', {
          minutes: Math.max(1, Math.round(ageMs / 60000)),
        }),
        tooltip: t('header.health.staleTooltip'),
      };
    }
    return null;
  }, [health, t]);

  const filtered = useMemo(() => {
    let result = tasks;
    if (statusFilter !== 'all') {
      result = result.filter((task) => task.status === statusFilter);
    }
    if (typeFilter !== 'all') {
      result = result.filter((task) => task.taskType === typeFilter);
    }
    if (agentFilter !== 'all') {
      result = result.filter((task) => task.agent === agentFilter);
    }
    return result;
  }, [tasks, statusFilter, typeFilter, agentFilter]);

  // Group filtered tasks by agent so the panel shows section headers like the
  // reference plugin (SYSADMIN (1) / DEVELOPER (1)). Empty filter means the
  // user picked a specific agent — collapse to a single section.
  const grouped = useMemo(() => {
    const buckets = new Map<string, QueueTask[]>();
    for (const task of filtered) {
      const key = task.agent || 'agent';
      const bucket = buckets.get(key);
      if (bucket) bucket.push(task);
      else buckets.set(key, [task]);
    }
    return Array.from(buckets.entries());
  }, [filtered]);

  const handleAction = useCallback(
    async (
      taskId: string,
      path: ActionPath,
      note?: string,
    ) => {
      if (path === 'delete') {
        // Don't call the API yet — open the inline confirmation first so an
        // accidental click can't wipe the file off disk. Close the detail
        // modal if it was open over the row so confirm + detail don't stack.
        setPendingDeleteTaskId(taskId);
        setDetailTask((current) => (current?.id === taskId ? null : current));
        return;
      }
      try {
        const updated = await runAction(selectedProject.projectId, taskId, path, note);
        setTasks((prev) => prev.map((task) => (task.id === updated.id ? updated : task)));
        if (detailTask?.id === updated.id) {
          setDetailTask(updated);
        }
      } catch (actionErr) {
        setError(actionErr instanceof Error ? actionErr.message : `Failed to ${path} task`);
      }
    },
    [selectedProject.projectId, detailTask],
  );

  const projectName =
    (typeof selectedProject.displayName === 'string' && selectedProject.displayName)
    || (typeof selectedProject.name === 'string' && selectedProject.name)
    || selectedProject.projectId;

  const pendingDeleteTask = useMemo(
    () => (pendingDeleteTaskId ? tasks.find((task) => task.id === pendingDeleteTaskId) ?? null : null),
    [pendingDeleteTaskId, tasks],
  );

  const cancelDelete = useCallback(() => {
    if (isDeleting) return;
    setPendingDeleteTaskId(null);
  }, [isDeleting]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDeleteTaskId) return;
    setIsDeleting(true);
    setError(null);
    try {
      await readJson<{ success: true; data: { deleted: boolean } }>(
        await api.tasks.delete(pendingDeleteTaskId, selectedProject.projectId),
      );
      setTasks((prev) => prev.filter((task) => task.id !== pendingDeleteTaskId));
      setPendingDeleteTaskId(null);
      // The server also broadcasts `tasks_queue_updated` after delete, so the
      // websocket-driven `load()` will reconcile; the optimistic removal above
      // keeps the UI snappy until that round-trip lands.
    } catch (deleteErr) {
      setError(deleteErr instanceof Error ? deleteErr.message : 'Failed to delete task');
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDeleteTaskId, selectedProject.projectId]);

  return (
    <div className="space-y-3 text-sm">
      {/* Header bar — matches the plugin: title, count, live dot, refresh icon. */}
      <div className="flex items-center justify-between border-b border-border/60 pb-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold text-foreground">
            {t('title')}
          </h1>
          <span className="text-xs text-muted-foreground">
            {t('header.tasksCount', {
              count: filtered.length,
              defaultValue: `${filtered.length} task${filtered.length === 1 ? '' : 's'}`,
            })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
            {t('header.live')}
          </span>
          {healthChip && (
            <span
              key={healthChip.key}
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
              title={healthChip.tooltip}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${healthChip.dotClass}`} />
              {healthChip.label}
            </span>
          )}
          <button
            type="button"
            onClick={() => { void load(); void loadHealth(); }}
            disabled={isLoading}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label={t('actions.refresh')}
            title={t('actions.refresh')}
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Single filter row — Agent / Status / Type plus a "X of Y tasks" count. */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label={t('filters.agentLabel')}
            value={agentFilter}
            options={['all', ...agents]}
            renderOption={(value) => (value === 'all' ? t('filters.all') : value)}
            onChange={setAgentFilter}
          />
          <FilterSelect
            label={t('filters.statusLabel')}
            value={statusFilter}
            options={['all', ...STATUS_OPTIONS]}
            renderOption={(value) =>
              value === 'all' ? t('filters.all') : t(`status.${value}`)
            }
            onChange={setStatusFilter}
          />
          <FilterSelect
            label={t('filters.typeLabel')}
            value={typeFilter}
            options={['all', ...TYPE_OPTIONS]}
            renderOption={(value) =>
              value === 'all' ? t('filters.all') : t(`types.${value}`)
            }
            onChange={setTypeFilter}
          />
        </div>
        <span className="text-xs text-muted-foreground">
          {t('header.countOf', {
            filtered: filtered.length,
            total: tasks.length,
            defaultValue: `${filtered.length} of ${tasks.length}`,
          })}
        </span>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      {isLoading && tasks.length === 0 ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : grouped.length === 0 ? (
        <div className="rounded-md border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
          {t('empty')}
        </div>
      ) : (
        <div className="space-y-4">
          {grouped.map(([agent, bucket]) => (
            <AgentSection
              key={agent}
              agent={agent}
              tasks={bucket}
              projectName={projectName}
              onOpen={(task) => setDetailTask(task)}
              onAction={handleAction}
            />
          ))}
        </div>
      )}

      {detailTask && (
        <TaskDetailModal
          task={detailTask}
          onClose={() => setDetailTask(null)}
          onAction={handleAction}
        />
      )}

      {pendingDeleteTask && (
        <DeleteTaskConfirmDialog
          task={pendingDeleteTask}
          isDeleting={isDeleting}
          onCancel={cancelDelete}
          onConfirm={confirmDelete}
        />
      )}
    </div>
  );
}

function DeleteTaskConfirmDialog({
  task,
  isDeleting,
  onCancel,
  onConfirm,
}: {
  task: QueueTask;
  isDeleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('taskQueue');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDeleting) onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, onCancel]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-task-confirm-title"
    >
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-xl">
        <div className="mb-3 flex items-center gap-3">
          <div className="rounded-full bg-rose-100 p-2 text-rose-600 dark:bg-rose-900/30 dark:text-rose-400">
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </div>
          <h2 id="delete-task-confirm-title" className="text-base font-semibold text-foreground">
            {t('actions.deleteConfirmTitle')}
          </h2>
        </div>
        <p className="mb-1 text-sm text-muted-foreground">{t('actions.deleteConfirmBody')}</p>
        <p className="mb-5 truncate text-xs text-muted-foreground" title={task.title}>
          <span className="font-medium text-foreground">{task.title}</span>
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={isDeleting}
            className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('actions.deleteConfirmNo')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isDeleting}
            className="inline-flex items-center gap-1.5 rounded-md bg-rose-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
          >
            {isDeleting && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            {t('actions.deleteConfirmYes')}
          </button>
        </div>
      </div>
    </div>
  );
}

function FilterSelect<V extends string>({
  label,
  value,
  options,
  renderOption,
  onChange,
}: {
  label: string;
  value: V;
  options: readonly V[];
  renderOption: (value: V) => string;
  onChange: (value: V) => void;
}) {
  return (
    <label className="inline-flex items-center gap-1.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value as V)}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {renderOption(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgentSection({
  agent,
  tasks,
  projectName,
  onOpen,
  onAction,
}: {
  agent: string;
  tasks: QueueTask[];
  projectName: string;
  onOpen: (task: QueueTask) => void;
  onAction: (
    taskId: string,
    path: ActionPath,
    note?: string,
  ) => void;
}) {
  return (
    <section className="space-y-1.5">
      <header className="flex items-center gap-2 px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-foreground/80">
        <span>{agent}</span>
        <span className="text-muted-foreground">({tasks.length})</span>
      </header>
      <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60 bg-card">
        {tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            projectName={projectName}
            onOpen={() => onOpen(task)}
            onAction={onAction}
          />
        ))}
      </div>
    </section>
  );
}

function TaskRow({
  task,
  projectName,
  onOpen,
  onAction,
}: {
  task: QueueTask;
  projectName: string;
  onOpen: () => void;
  onAction: (
    taskId: string,
    path: ActionPath,
    note?: string,
  ) => void;
}) {
  const { t } = useTranslation('taskQueue');

  return (
    <div
      className={`flex flex-wrap items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/30 ${
        task.quarantined ? 'bg-yellow-50/40 dark:bg-yellow-950/10' : ''
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="min-w-20 text-left font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
        title={task.projectId}
      >
        {projectName}
      </button>

      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={`h-2 w-2 rounded-full ${statusDotClasses(task.status)}`} />
        <span>{t(`status.${task.status}`)}</span>
        {task.quarantined && (
          <span className="ml-1 rounded bg-yellow-200 px-1 text-[10px] font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">
            {t('detail.quarantinedBadge')}
          </span>
        )}
      </span>

      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 flex-col items-start text-left"
      >
        <span className="flex w-full items-baseline gap-1">
          <span className="font-mono text-xs text-muted-foreground">{task.taskType === 'other' ? '' : `${task.taskType} `}</span>
          <span className="truncate font-medium text-foreground">{task.title}</span>
          {task.description && (
            <span className="truncate text-muted-foreground"> — {task.description}</span>
          )}
        </span>
        {/* Orchestrator tasks report result/error inline — operators see at a
            glance whether the LLM finished cleanly without opening the modal. */}
        {(task.status === 'completed' || task.status === 'failed') && (
          <span
            className={`mt-0.5 line-clamp-1 text-xs italic ${
              task.status === 'failed'
                ? 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground'
            }`}
            title={task.status === 'failed' ? task.error ?? undefined : task.result ?? undefined}
          >
            {task.status === 'failed'
              ? previewLine(task.error)
              : previewLine(task.result)}
          </span>
        )}
      </button>

      <span className="text-xs text-muted-foreground">{formatRelative(task.createdAt)}</span>

      <RowActions task={task} onAction={onAction} />
    </div>
  );
}

function RowActions({
  task,
  onAction,
}: {
  task: QueueTask;
  onAction: (
    taskId: string,
    path: ActionPath,
    note?: string,
  ) => void;
}) {
  const { t } = useTranslation('taskQueue');
  const actions: Array<{
    path: 'approve' | 'cancel' | 'quarantine' | 'restore' | 'delete';
    label: string;
    className: string;
    icon?: React.ReactNode;
  }> = [];
  if (!task.quarantined) {
    if (task.status === 'submitted' || task.status === 'pending') {
      actions.push({
        path: 'approve',
        label: t('actions.approve'),
        className:
          'border-emerald-500 text-emerald-600 hover:bg-emerald-500/10 dark:text-emerald-400',
      });
    }
    if (task.status !== 'completed' && task.status !== 'cancelled') {
      actions.push({
        path: 'cancel',
        label: t('actions.cancel'),
        className:
          'border-red-500 text-red-600 hover:bg-red-500/10 dark:text-red-400',
      });
    }
    actions.push({
      path: 'quarantine',
      label: t('actions.quarantine'),
      className:
        'border-slate-500 text-slate-600 hover:bg-slate-500/10 dark:text-slate-400 dark:border-slate-500',
    });
    actions.push({
      path: 'delete',
      label: t('actions.delete'),
      className:
        'border-rose-700 text-rose-700 hover:bg-rose-700/10 dark:text-rose-400 dark:border-rose-400',
      icon: <Trash2 className="mr-1 inline-block h-3 w-3" aria-hidden="true" />,
    });
  } else {
    actions.push({
      path: 'restore',
      label: t('actions.restore'),
      className:
        'border-sky-500 text-sky-600 hover:bg-sky-500/10 dark:text-sky-400',
    });
    actions.push({
      path: 'delete',
      label: t('actions.delete'),
      className:
        'border-rose-700 text-rose-700 hover:bg-rose-700/10 dark:text-rose-400 dark:border-rose-400',
      icon: <Trash2 className="mr-1 inline-block h-3 w-3" aria-hidden="true" />,
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      {actions.map((action) => (
        <button
          key={action.path}
          type="button"
          onClick={() => onAction(task.id, action.path)}
          className={`inline-flex items-center rounded-md border bg-background px-2 py-0.5 text-xs font-medium transition-colors ${action.className}`}
        >
          {action.icon}
          {action.label}
        </button>
      ))}
    </div>
  );
}