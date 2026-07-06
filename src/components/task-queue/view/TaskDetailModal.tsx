import { useState } from 'react';
import { CheckCircle2, ClipboardCopy, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../shared/view/ui';

import type { QueueTask, TaskHistoryEntry, TaskStatus } from './TaskQueuePanel';

type ActionPath = 'approve' | 'cancel' | 'quarantine' | 'restore' | 'delete';

type TaskDetailModalProps = {
  task: QueueTask;
  onClose: () => void;
  onAction: (taskId: string, path: ActionPath, note?: string) => void | Promise<void>;
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function historyLabel(entry: TaskHistoryEntry, t: ReturnType<typeof useTranslation>['t']): string {
  switch (entry.action) {
    case 'created':
      return t('detail.historyCreated');
    case 'approved':
      return t('detail.historyApproved');
    case 'cancelled':
      return t('detail.historyCancelled');
    case 'quarantined':
      return t('detail.historyQuarantined');
    case 'restored':
      return t('detail.historyRestored');
    case 'note':
      return t('detail.historyNote');
    case 'status_changed':
    default:
      if (entry.fromStatus && entry.status && entry.fromStatus !== entry.status) {
        return t('detail.historyStatusChange', {
          from: entry.fromStatus,
          to: entry.status,
        });
      }
      return t('detail.historyNote');
  }
}

function statusBadgeClasses(status: TaskStatus): string {
  switch (status) {
    case 'submitted':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300';
    case 'pending':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300';
    case 'approved':
      return 'bg-indigo-100 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300';
    case 'in_progress':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300';
    case 'completed':
      return 'bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-300';
    case 'failed':
      return 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300';
    case 'cancelled':
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
    default:
      return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

export default function TaskDetailModal({ task, onClose, onAction }: TaskDetailModalProps) {
  const { t } = useTranslation('taskQueue');
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedPath(path);
      window.setTimeout(() => setCopiedPath(null), 1500);
    } catch (copyErr) {
      console.warn('[TaskQueue] Failed to copy path:', copyErr);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-lg border border-border bg-card p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-lg font-semibold">{task.title}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClasses(task.status)}`}>
                {t(`status.${task.status}`)}
              </span>
              <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                {t(`types.${task.taskType}`)}
              </span>
              <span className="font-mono text-[11px]">{task.agent}</span>
              {task.quarantined && (
                <span className="inline-block rounded-full bg-yellow-200 px-2 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200">
                  {t('detail.quarantinedBadge')}
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 hover:bg-muted"
            aria-label={t('actions.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('fields.createdBy')}</dt>
          <dd><code className="text-xs">{task.createdBy || '—'}</code></dd>
          <dt className="text-muted-foreground">{t('fields.createdAt')}</dt>
          <dd>{formatDate(task.createdAt)}</dd>
          <dt className="text-muted-foreground">{t('fields.startedAt')}</dt>
          <dd>{formatDate(task.startedAt)}</dd>
          <dt className="text-muted-foreground">{t('fields.completedAt')}</dt>
          <dd>{formatDate(task.completedAt)}</dd>
          {task.description && (
            <>
              <dt className="text-muted-foreground">{t('fields.description')}</dt>
              <dd>{task.description}</dd>
            </>
          )}
        </dl>

        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">{t('fields.prompt')}</h3>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">
            {task.prompt}
          </pre>
        </div>

        {task.contextRefs.length > 0 && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium">
              {t('fields.contextRefs')}
              <span className="ml-2 text-xs text-muted-foreground">
                ({task.contextRefs.length})
              </span>
            </h3>
            <ul className="space-y-1">
              {task.contextRefs.map((path) => (
                <li
                  key={path}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-2 py-1"
                >
                  <code className="truncate text-xs" title={path}>{path}</code>
                  <button
                    type="button"
                    onClick={() => copyPath(path)}
                    className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted"
                    aria-label={t('actions.copyPath')}
                  >
                    {copiedPath === path ? (
                      <>
                        <CheckCircle2 className="h-3 w-3 text-green-600" />
                        {t('actions.copied')}
                      </>
                    ) : (
                      <>
                        <ClipboardCopy className="h-3 w-3" />
                        {t('actions.copy')}
                      </>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {task.result && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium text-green-700 dark:text-green-300">
              {t('fields.result')}
            </h3>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-green-300 bg-green-50 p-3 text-xs dark:border-green-800 dark:bg-green-950/40">
              {task.result}
            </pre>
          </div>
        )}

        {task.error && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-medium text-red-700 dark:text-red-300">
              {t('fields.error')}
            </h3>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-red-300 bg-red-50 p-3 text-xs dark:border-red-800 dark:bg-red-950/40">
              {task.error}
            </pre>
          </div>
        )}

        <div className="mt-6">
          <h3 className="mb-2 text-sm font-medium">
            {t('detail.historyTitle')}
            <span className="ml-2 text-xs text-muted-foreground">
              ({task.history.length})
            </span>
          </h3>
          {task.history.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('detail.historyEmpty')}</p>
          ) : (
            <ol className="space-y-2 border-l-2 border-border pl-4">
              {task.history.map((entry, index) => (
                <li key={`${entry.at}-${index}`} className="relative">
                  <span className="absolute -left-[7px] top-1 inline-block h-3 w-3 rounded-full bg-blue-500" />
                  <p className="text-sm">{historyLabel(entry, t)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {formatDate(entry.at)} · <code>{entry.actor}</code> ({entry.role})
                  </p>
                  {entry.note && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                      {entry.note}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
        </div>

        {!task.quarantined && (
          <div className="mt-4">
            <label className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('detail.noteLabel')}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={t('detail.notePlaceholder')}
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('actions.close')}
          </Button>
          {!task.quarantined && (task.status === 'submitted' || task.status === 'pending') && (
            <Button onClick={() => onAction(task.id, 'approve', note)}>
              {t('actions.approve')}
            </Button>
          )}
          {!task.quarantined && task.status !== 'completed' && task.status !== 'cancelled' && (
            <Button variant="destructive" onClick={() => onAction(task.id, 'cancel', note)}>
              {t('actions.cancel')}
            </Button>
          )}
          {!task.quarantined ? (
            <Button variant="outline" onClick={() => onAction(task.id, 'quarantine', note)}>
              {t('actions.quarantine')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => onAction(task.id, 'restore', note)}>
              {t('actions.restore')}
            </Button>
          )}
          <Button
            variant="destructive"
            onClick={() => onAction(task.id, 'delete', note)}
            aria-label={t('actions.delete')}
            title={t('actions.delete')}
          >
            <Trash2 className="mr-1.5 inline-block h-3.5 w-3.5" aria-hidden="true" />
            {t('actions.delete')}
          </Button>
        </div>
      </div>
    </div>
  );
}