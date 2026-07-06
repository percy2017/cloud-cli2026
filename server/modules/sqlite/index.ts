/**
 * Public surface of the sqlite module.
 *
 * The module intentionally has no runtime side effects — the inspector
 * functions are pure and stateless. Companion REST routes in
 * server/index.js call these directly after applying project-root guards.
 */

export {
  inspectSqliteFile,
  readSqliteTableRows,
  SqliteInspectorError,
  SQLITE_DEFAULT_PAGE_SIZE,
  SQLITE_MAX_PAGE_SIZE,
  SQLITE_MAX_INSPECT_BYTES,
} from './sqlite-inspector.js';

export type {
  CellValue,
  ColumnInfo,
  IndexInfo,
  InspectResult,
  RowColumnMeta,
  RowsResult,
  TableInfo,
} from './sqlite-inspector.js';