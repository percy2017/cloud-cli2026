/**
 * Read-only SQLite inspector for project files.
 *
 * Opens .db / .sqlite / .sqlite3 files with better-sqlite3 in readonly mode
 * and returns schema + paginated rows as JSON. The companion routes in
 * server/index.js are thin wrappers that apply project-root validation
 * before calling these functions; this module is intentionally pure so it
 * can be unit-tested against a temporary DB without spinning up Express.
 *
 * Safety constraints:
 * - The DB is opened with { readonly: true, fileMustExist: true }; we never
 *   mutate the user's file.
 * - readSqliteTableRows accepts a `tableName` from the URL and validates it
 *   against SAFE_TABLE_NAME before quoting it in the SELECT, so even a
 *   pathological caller cannot smuggle SQL.
 * - Hard caps on result size (pageSize) and inspected file size
 *   (SQLITE_MAX_INSPECT_BYTES) keep a corrupted/hostile file from causing
 *   memory blowups.
 */

import Database, { type Database as DatabaseType } from 'better-sqlite3';
import fs from 'node:fs';

export const SQLITE_DEFAULT_PAGE_SIZE = 50;
export const SQLITE_MAX_PAGE_SIZE = 500;
export const SQLITE_MAX_INSPECT_BYTES = 50 * 1024 * 1024;
const SAFE_TABLE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface ColumnInfo {
  name: string;
  type: string;
  pk: number;
  notnull: number;
  dflt_value: unknown | null;
}

export interface IndexInfo {
  name: string;
  columns: string[];
}

export interface TableInfo {
  name: string;
  rowCount: number;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
}

export interface InspectResult {
  fileSize: number;
  truncated: boolean;
  tables: TableInfo[];
}

export interface RowColumnMeta {
  name: string;
  type: string;
}

export type CellValue =
  | null
  | string
  | number
  | bigint
  | { __blob: true; byteLength: number };

export interface RowsResult {
  tableName: string;
  columns: RowColumnMeta[];
  rows: CellValue[][];
  page: number;
  pageSize: number;
  totalRows: number;
  hasMore: boolean;
}

export class SqliteInspectorError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = 'SqliteInspectorError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function openReadonly(dbPath: string): DatabaseType {
  if (!fs.existsSync(dbPath)) {
    throw new SqliteInspectorError(`SQLite file not found: ${dbPath}`, 'NOT_FOUND', 404);
  }
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    throw mapBetterSqliteError(err);
  }
}

function mapBetterSqliteError(err: unknown): SqliteInspectorError {
  const message = err instanceof Error ? err.message : String(err);
  if (/SQLITE_CORRUPT|not a database/i.test(message)) {
    return new SqliteInspectorError('File is not a valid SQLite database', 'SQLITE_CORRUPT', 400);
  }
  if (/SQLITE_BUSY|locked/i.test(message)) {
    return new SqliteInspectorError('Database is locked by another process', 'SQLITE_BUSY', 423);
  }
  return new SqliteInspectorError(`SQLite operation failed: ${message}`, 'SQLITE_ERROR', 500);
}

function listTables(db: DatabaseType): string[] {
  return (db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function readColumns(db: DatabaseType, tableName: string): ColumnInfo[] {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfo[];
}

function readRowCount(db: DatabaseType, tableName: string): number {
  // Quoted with double-quotes so the identifier is treated as a single name.
  const row = db.prepare(`SELECT COUNT(*) AS n FROM "${tableName}"`).get() as { n: number };
  return row.n;
}

function readIndexes(db: DatabaseType, tableName: string): IndexInfo[] {
  const rawList = db
    .prepare(`PRAGMA index_list(${tableName})`)
    .all() as Array<{ name: string }>;
  return rawList.map((idx) => {
    const cols = db
      .prepare(`PRAGMA index_info(${idx.name})`)
      .all() as Array<{ name: string }>;
    return { name: idx.name, columns: cols.map((c) => c.name) };
  });
}

function buildTableInfo(db: DatabaseType, tableName: string): TableInfo {
  return {
    name: tableName,
    rowCount: readRowCount(db, tableName),
    columns: readColumns(db, tableName),
    indexes: readIndexes(db, tableName),
  };
}

/**
 * Open a SQLite file in readonly mode and return its schema.
 *
 * Returns `truncated: true` (and omits per-table columns/indexes) when the
 * file is larger than {@link SQLITE_MAX_INSPECT_BYTES} so the UI can warn the
 * user and disable row browsing.
 */
export async function inspectSqliteFile(dbPath: string): Promise<InspectResult> {
  if (!fs.existsSync(dbPath)) {
    throw new SqliteInspectorError(`SQLite file not found: ${dbPath}`, 'NOT_FOUND', 404);
  }
  const stat = fs.statSync(dbPath);
  const fileSize = stat.size;

  const db = openReadonly(dbPath);
  try {
    try {
      const tableNames = listTables(db);
      const truncated = fileSize > SQLITE_MAX_INSPECT_BYTES;

      const tables: TableInfo[] = tableNames.map((name) => {
        const rowCount = readRowCount(db, name);
        if (truncated) {
          return { name, rowCount, columns: [], indexes: [] };
        }
        return buildTableInfo(db, name);
      });

      return { fileSize, truncated, tables };
    } catch (err) {
      throw mapBetterSqliteError(err);
    }
  } finally {
    db.close();
  }
}

function marshalCell(value: unknown): CellValue {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) {
    return { __blob: true, byteLength: value.byteLength };
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'string') return value;
  // Fallback: stringify (dates, typed arrays, etc.)
  return String(value);
}

/**
 * Read a single page of rows from `tableName`.
 *
 * @throws SqliteInspectorError with status 400 if `tableName` is not a safe
 *   SQL identifier, 403 if the file exceeds the inspection cap, 404 if the
 *   table doesn't exist.
 */
export async function readSqliteTableRows(
  dbPath: string,
  tableName: string,
  page: number,
  pageSize: number
): Promise<RowsResult> {
  if (!SAFE_TABLE_NAME.test(tableName)) {
    throw new SqliteInspectorError(
      `Invalid table name: ${tableName}`,
      'INVALID_TABLE_NAME',
      400
    );
  }
  if (!Number.isInteger(page) || page < 1) {
    throw new SqliteInspectorError('page must be a positive integer', 'INVALID_PAGE', 400);
  }
  // Treat 0 / negative / non-integer as "use default" rather than clamping to 1,
  // so an empty query string (?pageSize=) still gets a sane page.
  const effectivePageSize =
    !Number.isFinite(pageSize) || pageSize <= 0
      ? SQLITE_DEFAULT_PAGE_SIZE
      : Math.min(Math.floor(pageSize), SQLITE_MAX_PAGE_SIZE);

  if (!fs.existsSync(dbPath)) {
    throw new SqliteInspectorError(`SQLite file not found: ${dbPath}`, 'NOT_FOUND', 404);
  }
  const stat = fs.statSync(dbPath);
  if (stat.size > SQLITE_MAX_INSPECT_BYTES) {
    throw new SqliteInspectorError(
      'File is larger than 50 MB; row browsing is disabled',
      'FILE_TOO_LARGE',
      403
    );
  }

  const db = openReadonly(dbPath);
  try {
    try {
      const tableNames = listTables(db);
      if (!tableNames.includes(tableName)) {
        throw new SqliteInspectorError(
          `Table not found: ${tableName}`,
          'TABLE_NOT_FOUND',
          404
        );
      }

      const totalRows = readRowCount(db, tableName);
      const offset = (page - 1) * effectivePageSize;
      // ORDER BY rowid keeps pagination deterministic across pages; LIMIT and
      // OFFSET are interpolated as clamped integers rather than bound via `?`
      // because better-sqlite3 occasionally mis-binds LIMIT parameters when the
      // column list contains BLOBs.
      const rawRows = db
        .prepare(
          `SELECT * FROM "${tableName}" ORDER BY rowid LIMIT ${effectivePageSize} OFFSET ${offset}`
        )
        .all() as Record<string, unknown>[];

      const columnMeta = readColumns(db, tableName).map((c) => ({ name: c.name, type: c.type }));
      const rows: CellValue[][] = rawRows.map((row) =>
        columnMeta.map((col) => marshalCell(row[col.name]))
      );

      return {
        tableName,
        columns: columnMeta,
        rows,
        page,
        pageSize: effectivePageSize,
        totalRows,
        hasMore: offset + rawRows.length < totalRows,
      };
    } catch (err) {
      if (err instanceof SqliteInspectorError) throw err;
      throw mapBetterSqliteError(err);
    }
  } finally {
    db.close();
  }
}