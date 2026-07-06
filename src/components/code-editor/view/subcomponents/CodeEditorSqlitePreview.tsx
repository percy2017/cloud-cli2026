import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Database, Loader2, X, ChevronLeft, ChevronRight, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../utils/api';
import type { CodeEditorFile } from '../../types/types';

// ── Types (mirror server/modules/sqlite/sqlite-inspector.ts) ────────────────

type CellValue = string | number | null | { __blob: true; byteLength: number };

interface InspectResult {
  fileSize: number;
  truncated: boolean;
  tables: TableInfo[];
}

interface TableInfo {
  name: string;
  rowCount: number;
  columns: ColumnColumn[];
  indexes: IndexInfo[];
}

interface ColumnColumn {
  name: string;
  type: string;
  pk: number;
  notnull: number;
  dflt_value: unknown | null;
}

interface IndexInfo {
  name: string;
  columns: string[];
}

interface RowsResult {
  tableName: string;
  columns: { name: string; type: string }[];
  rows: CellValue[][];
  page: number;
  pageSize: number;
  totalRows: number;
  hasMore: boolean;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; inspect: InspectResult }
  | { kind: 'error'; message: string };

type RowsStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; rows: RowsResult }
  | { kind: 'error'; message: string };

// ── Props ───────────────────────────────────────────────────────────────────

type CodeEditorSqlitePreviewProps = {
  file: CodeEditorFile;
  projectId?: string;
  isSidebar: boolean;
  onClose: () => void;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatCell = (value: CellValue, blobLabel: (bytes: number) => string): string => {
  if (value === null) return '∅';
  if (typeof value === 'object' && value && '__blob' in value) {
    return blobLabel(value.byteLength);
  }
  return String(value);
};

// ── Component ───────────────────────────────────────────────────────────────

export default function CodeEditorSqlitePreview({
  file,
  projectId,
  isSidebar,
  onClose,
}: CodeEditorSqlitePreviewProps) {
  const { t } = useTranslation('codeEditor');

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [rowsStatus, setRowsStatus] = useState<RowsStatus>({ kind: 'idle' });
  const [page, setPage] = useState(1);

  // Identifies the file the current inspect/rows data belongs to. The editor
  // can reuse this component across file opens, so we must guard against stale
  // data from a previous file showing under a new one.
  const inspectKey = `${projectId ?? ''}:${file.path}`;
  const lastInspectKey = useRef<string | null>(null);

  const inspect = useCallback(async () => {
    if (!projectId) {
      setStatus({ kind: 'error', message: t('sqliteViewer.error') });
      return;
    }
    setStatus({ kind: 'loading' });
    setRowsStatus({ kind: 'idle' });
    setActiveTable(null);
    setPage(1);
    const url = `/api/projects/${projectId}/sqlite/inspect?path=${encodeURIComponent(file.path)}`;
    try {
      const response = await authenticatedFetch(url);
      const payload = (await response.json()) as InspectResult & { error?: string };
      if (!response.ok) {
        setStatus({ kind: 'error', message: payload.error ?? t('sqliteViewer.error') });
        return;
      }
      lastInspectKey.current = inspectKey;
      setStatus({ kind: 'ready', inspect: payload });
      // Auto-select the first table so the user sees rows immediately.
      if (payload.tables.length > 0) {
        setActiveTable(payload.tables[0].name);
      }
    } catch (err) {
      setStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : t('sqliteViewer.error'),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectKey, projectId, file.path, t]);

  useEffect(() => {
    void inspect();
  }, [inspect]);

  // Fetch rows when active table or page changes.
  useEffect(() => {
    if (status.kind !== 'ready' || !activeTable || !projectId) return;
    if (status.inspect.truncated) return; // big DBs skip row browsing
    let cancelled = false;
    setRowsStatus({ kind: 'loading' });
    const url = `/api/projects/${projectId}/sqlite/tables/${encodeURIComponent(
      activeTable
    )}/rows?path=${encodeURIComponent(file.path)}&page=${page}&pageSize=50`;
    (async () => {
      try {
        const response = await authenticatedFetch(url);
        const payload = (await response.json()) as RowsResult & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setRowsStatus({ kind: 'error', message: payload.error ?? t('sqliteViewer.error') });
          return;
        }
        setRowsStatus({ kind: 'ready', rows: payload });
      } catch (err) {
        if (cancelled) return;
        setRowsStatus({
          kind: 'error',
          message: err instanceof Error ? err.message : t('sqliteViewer.error'),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTable, page, status, projectId, file.path, t]);

  const totalPages = useMemo(() => {
    if (rowsStatus.kind !== 'ready') return 1;
    return Math.max(1, Math.ceil(rowsStatus.rows.totalRows / rowsStatus.rows.pageSize));
  }, [rowsStatus]);

  const handleSelectTable = (name: string) => {
    if (name === activeTable) return;
    setActiveTable(name);
    setPage(1);
  };

  const headerSizeLabel = useMemo(() => {
    if (status.kind !== 'ready') return '';
    return formatBytes(status.inspect.fileSize);
  }, [status]);

  return (
    <div className={`flex h-full w-full flex-col bg-gray-900 text-gray-100 ${isSidebar ? '' : 'rounded-md'}`}>
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-gray-700 bg-gray-800 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Database className="h-4 w-4 flex-shrink-0 text-cyan-400" aria-hidden="true" />
          <span className="truncate text-sm font-medium" title={file.name}>{file.name}</span>
          {headerSizeLabel && (
            <span className="flex-shrink-0 rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300">
              {headerSizeLabel}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-gray-300 hover:bg-gray-700 hover:text-white"
          title={t('actions.close')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Truncated banner (DB > 50 MB) */}
      {status.kind === 'ready' && status.inspect.truncated && (
        <div className="flex flex-shrink-0 items-start gap-2 border-b border-yellow-600/40 bg-yellow-900/30 px-3 py-2 text-xs text-yellow-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{t('sqliteViewer.truncatedBanner')}</span>
        </div>
      )}

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col">
        {status.kind === 'idle' || status.kind === 'loading' ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-gray-300">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>{t('sqliteViewer.loadingSchema')}</span>
          </div>
        ) : status.kind === 'error' ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center">
            <AlertTriangle className="h-8 w-8 text-red-400" aria-hidden="true" />
            <p className="text-sm text-red-300">{status.message}</p>
            <button
              type="button"
              onClick={() => void inspect()}
              className="rounded-md bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-100 hover:bg-gray-600"
            >
              {t('actions.retry')}
            </button>
          </div>
        ) : status.inspect.tables.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-sm text-gray-400">
            {t('sqliteViewer.empty')}
          </div>
        ) : (
          <>
            {/* Tabs */}
            <div
              role="tablist"
              aria-label={t('sqliteViewer.tabsLabel')}
              className="flex flex-shrink-0 overflow-x-auto border-b border-gray-700 bg-gray-800/50 px-2 py-1"
            >
              {status.inspect.tables.map((table) => {
                const isActive = table.name === activeTable;
                return (
                  <button
                    key={table.name}
                    role="tab"
                    aria-selected={isActive}
                    type="button"
                    onClick={() => handleSelectTable(table.name)}
                    className={`flex flex-shrink-0 items-center gap-2 whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-cyan-600 text-white'
                        : 'text-gray-300 hover:bg-gray-700'
                    } ${status.inspect.truncated ? 'cursor-not-allowed opacity-60' : ''}`}
                    title={`${table.name} (${table.rowCount})`}
                  >
                    <span>{table.name}</span>
                    <span
                      className={`rounded px-1 text-[10px] ${
                        isActive ? 'bg-cyan-700' : 'bg-gray-700 text-gray-300'
                      }`}
                    >
                      {table.rowCount}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Schema summary */}
            {activeTable && (() => {
              const table = status.inspect.tables.find((t) => t.name === activeTable);
              if (!table || table.columns.length === 0) return null;
              return (
                <div className="flex-shrink-0 border-b border-gray-700 bg-gray-800/30 px-3 py-2">
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                    {t('sqliteViewer.schemaHeading')}
                  </p>
                  <div className="flex flex-wrap gap-2 text-xs text-gray-300">
                    {table.columns.map((col) => (
                      <span key={col.name} className="rounded bg-gray-700/70 px-1.5 py-0.5 font-mono">
                        <span className="text-cyan-300">{col.name}</span>
                        <span className="text-gray-400"> · {col.type || 'ANY'}</span>
                        {col.pk > 0 && <span className="ml-1 text-yellow-400">PK</span>}
                      </span>
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Data grid */}
            <div className="min-h-0 flex-1 overflow-auto">
              {rowsStatus.kind === 'loading' && (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-gray-300">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>{t('sqliteViewer.loadingRows')}</span>
                </div>
              )}
              {rowsStatus.kind === 'error' && (
                <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
                  <AlertTriangle className="h-6 w-6 text-red-400" aria-hidden="true" />
                  <p className="text-sm text-red-300">{rowsStatus.message}</p>
                </div>
              )}
              {rowsStatus.kind === 'ready' && (
                rowsStatus.rows.rows.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-sm text-gray-400">
                    {t('sqliteViewer.empty')}
                  </div>
                ) : (
                  <table className="w-full border-collapse text-xs">
                    <thead className="sticky top-0 z-10 bg-gray-800">
                      <tr>
                        {rowsStatus.rows.columns.map((col) => (
                          <th
                            key={col.name}
                            className="border-b border-gray-700 px-3 py-1.5 text-left font-semibold text-gray-300"
                            title={col.type}
                          >
                            {col.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rowsStatus.rows.rows.map((row, rowIdx) => (
                        <tr key={rowIdx} className="odd:bg-gray-900 even:bg-gray-800/40">
                          {row.map((cell, cellIdx) => {
                            const isNull = cell === null;
                            const isBlob = typeof cell === 'object' && cell !== null && '__blob' in cell;
                            return (
                              <td
                                key={cellIdx}
                                className={`max-w-[300px] truncate border-b border-gray-800 px-3 py-1 align-top ${
                                  isNull
                                    ? 'text-gray-500 italic'
                                    : isBlob
                                      ? 'text-purple-300 italic'
                                      : 'text-gray-100'
                                }`}
                                title={
                                  isNull
                                    ? t('sqliteViewer.nullValue')
                                    : isBlob
                                      ? t('sqliteViewer.blobValue', { bytes: (cell as { byteLength: number }).byteLength })
                                      : undefined
                                }
                              >
                                {formatCell(cell, (bytes) => t('sqliteViewer.blobValue', { bytes }))}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              )}
            </div>

            {/* Pagination footer */}
            {rowsStatus.kind === 'ready' && (
              <div className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-gray-700 bg-gray-800/60 px-3 py-1.5 text-xs text-gray-300">
                <span>
                  {t('sqliteViewer.rowCount', { count: rowsStatus.rows.totalRows })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={page <= 1}
                    className="inline-flex h-6 items-center gap-1 rounded border border-gray-600 bg-gray-700 px-2 font-medium text-gray-100 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3 w-3" aria-hidden="true" />
                    {t('sqliteViewer.previousPage')}
                  </button>
                  <span className="font-mono">
                    {t('sqliteViewer.pageOf', { page, totalPages })}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={!rowsStatus.rows.hasMore}
                    className="inline-flex h-6 items-center gap-1 rounded border border-gray-600 bg-gray-700 px-2 font-medium text-gray-100 hover:bg-gray-600 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {t('sqliteViewer.nextPage')}
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}