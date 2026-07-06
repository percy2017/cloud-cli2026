import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  inspectSqliteFile,
  readSqliteTableRows,
  SQLITE_DEFAULT_PAGE_SIZE,
  SqliteInspectorError,
} from '../sqlite-inspector.js';

async function withTempDb(
  runTest: (dbPath: string) => void | Promise<void>
): Promise<void> {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sqlite-inspector-'));
  const dbPath = path.join(tempDirectory, 'sample.db');
  const writer = new Database(dbPath);
  writer.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      avatar BLOB
    );
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      title TEXT,
      created_at TEXT DEFAULT '1970-01-01'
    );
    CREATE INDEX idx_posts_user ON posts(user_id);
    INSERT INTO users (id, name, email, avatar) VALUES
      (1, 'Alice', 'alice@example.com', X'4849'),
      (2, 'Bob',   NULL,             NULL),
      (3, 'Carol', 'carol@example.com', NULL);
    INSERT INTO posts (user_id, title, created_at) VALUES
      (1, 'Hello world', '2024-01-12'),
      (1, 'Second post', '2024-01-13'),
      (2, 'Bob first',   NULL);
  `);
  writer.close();

  try {
    await runTest(dbPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

test('inspectSqliteFile returns all tables with columns and indexes', async () => {
  await withTempDb(async (dbPath) => {
    const result = await inspectSqliteFile(dbPath);

    assert.equal(result.truncated, false);
    assert.ok(result.fileSize > 0);
    assert.deepEqual(
      result.tables.map((t) => t.name).sort(),
      ['posts', 'users']
    );

    const users = result.tables.find((t) => t.name === 'users');
    assert.ok(users, 'users table should exist');
    assert.equal(users.rowCount, 3);
    const idCol = users.columns.find((c) => c.name === 'id');
    assert.ok(idCol);
    assert.equal(idCol.pk, 1);
    assert.equal(idCol.notnull, 1);

    const posts = result.tables.find((t) => t.name === 'posts');
    assert.ok(posts);
    assert.equal(posts.rowCount, 3);
    const idx = posts.indexes.find((i) => i.name === 'idx_posts_user');
    assert.ok(idx);
    assert.deepEqual(idx.columns, ['user_id']);
  });
});

test('readSqliteTableRows paginates and marshals cells', async () => {
  await withTempDb(async (dbPath) => {
    const page1 = await readSqliteTableRows(dbPath, 'users', 1, 2);
    assert.equal(page1.tableName, 'users');
    assert.equal(page1.page, 1);
    assert.equal(page1.pageSize, 2);
    assert.equal(page1.totalRows, 3);
    assert.equal(page1.hasMore, true);
    assert.equal(page1.rows.length, 2);

    // ORDER BY rowid → Alice (rowid=1) then Bob (rowid=2)
    const aliceRow = page1.rows[0];
    assert.deepEqual(aliceRow[0], 1); // id
    assert.equal(aliceRow[1], 'Alice'); // name
    assert.equal(aliceRow[2], 'alice@example.com');
    assert.deepEqual(aliceRow[3], { __blob: true, byteLength: 2 }); // avatar (X'4849')

    const bobRow = page1.rows[1];
    assert.equal(bobRow[0], 2);
    assert.equal(bobRow[1], 'Bob');
    assert.equal(bobRow[2], null); // email is NULL
    assert.equal(bobRow[3], null); // avatar is NULL

    const page2 = await readSqliteTableRows(dbPath, 'users', 2, 2);
    assert.equal(page2.rows.length, 1);
    assert.equal(page2.hasMore, false);
    assert.equal(page2.rows[0][0], 3); // Carol
    assert.equal(page2.rows[0][1], 'Carol');
  });
});

test('readSqliteTableRows rejects unsafe table names', async () => {
  await withTempDb(async (dbPath) => {
    await assert.rejects(
      readSqliteTableRows(dbPath, 'users; DROP TABLE users;--', 1, 10),
      (err: unknown) =>
        err instanceof SqliteInspectorError && err.code === 'INVALID_TABLE_NAME'
    );
  });
});

test('readSqliteTableRows returns 404 for missing table', async () => {
  await withTempDb(async (dbPath) => {
    await assert.rejects(
      readSqliteTableRows(dbPath, 'does_not_exist', 1, 10),
      (err: unknown) =>
        err instanceof SqliteInspectorError && err.code === 'TABLE_NOT_FOUND'
    );
  });
});

test('inspectSqliteFile returns NOT_FOUND for missing path', async () => {
  await assert.rejects(
    inspectSqliteFile('/nonexistent/path.db'),
    (err: unknown) => err instanceof SqliteInspectorError && err.code === 'NOT_FOUND'
  );
});

test('inspectSqliteFile returns SQLITE_CORRUPT for non-sqlite file', async () => {
  const tempDirectory = await mkdtemp(path.join(tmpdir(), 'sqlite-inspector-corrupt-'));
  const fakePath = path.join(tempDirectory, 'fake.db');
  await writeFile(fakePath, 'this is not a sqlite database');
  try {
    await assert.rejects(
      inspectSqliteFile(fakePath),
      (err: unknown) =>
        err instanceof SqliteInspectorError && err.code === 'SQLITE_CORRUPT'
    );
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});

test('readSqliteTableRows uses default page size when caller passes 0', async () => {
  await withTempDb(async (dbPath) => {
    const result = await readSqliteTableRows(dbPath, 'posts', 1, 0);
    assert.equal(result.pageSize, SQLITE_DEFAULT_PAGE_SIZE);
  });
});

test('readSqliteTableRows clamps oversized pageSize to SQLITE_MAX_PAGE_SIZE', async () => {
  await withTempDb(async (dbPath) => {
    const result = await readSqliteTableRows(dbPath, 'users', 1, 9999);
    assert.equal(result.pageSize, 500);
  });
});