import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export type DrizzleDB = BetterSQLite3Database<typeof schema>;

function initTables(sqlite: InstanceType<typeof Database>): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TEXT,
      finished_at TEXT,
      total_pages INTEGER DEFAULT 0,
      parsed_pages INTEGER DEFAULT 0,
      max_depth INTEGER DEFAULT 5,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      crawl_job_id TEXT REFERENCES crawl_jobs(id),
      slug TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT,
      description TEXT,
      tags TEXT,
      full_html TEXT,
      scripts TEXT,
      stylesheets TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id),
      url TEXT NOT NULL,
      type TEXT NOT NULL,
      file_path TEXT,
      size_bytes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      crawl_job_id TEXT REFERENCES crawl_jobs(id),
      project_id TEXT REFERENCES projects(id),
      url TEXT NOT NULL,
      depth INTEGER NOT NULL,
      parent_url TEXT,
      full_html TEXT,
      title TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

export function createDatabase(dbPath: string = './data/crawler.db'): DrizzleDB {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  initTables(sqlite);

  const db = drizzle(sqlite, { schema });
  return db;
}

export function createInMemoryDatabase(): DrizzleDB {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  initTables(sqlite);

  const db = drizzle(sqlite, { schema });
  return db;
}

let defaultDb: DrizzleDB | null = null;

export function getDatabase(): DrizzleDB {
  if (!defaultDb) {
    defaultDb = createDatabase();
  }
  return defaultDb;
}
