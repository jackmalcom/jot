import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Store, schema } from '../../../packages/core/src/index.ts';
export function database(path: string) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  const store: Store = {
    all: (sql, ...params) => sqlite.prepare(sql).all(...params) as any,
    run: (sql, ...params) => {
      sqlite.prepare(sql).run(...params);
    },
    transaction: (fn) => sqlite.transaction(fn)(),
  };
  return {
    store,
    db: drizzle(sqlite, { schema }),
    close: () => sqlite.close(),
  };
}
