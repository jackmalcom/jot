export interface Store {
  all<T = Record<string, unknown>>(sql: string, ...params: any[]): T[];
  run(sql: string, ...params: any[]): void;
  transaction<T>(fn: () => T): T;
}
export const migrations = [
  {
    version: 1,
    statements: [
      `CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
      `CREATE TABLE session (id TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL, token TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, ipAddress TEXT, userAgent TEXT, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE)`,
      `CREATE INDEX session_user ON session(userId)`,
      `CREATE TABLE account (id TEXT PRIMARY KEY, accountId TEXT NOT NULL, providerId TEXT NOT NULL, userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, accessToken TEXT, refreshToken TEXT, idToken TEXT, accessTokenExpiresAt INTEGER, refreshTokenExpiresAt INTEGER, scope TEXT, password TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
      `CREATE INDEX account_user ON account(userId)`,
      `CREATE TABLE verification (id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL, expiresAt INTEGER NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL)`,
      `CREATE TABLE pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, parentId TEXT REFERENCES pages(id), position INTEGER NOT NULL, deletedAt INTEGER, deletionId TEXT, updatedAt INTEGER NOT NULL)`,
      `CREATE INDEX pages_tree ON pages(parentId, position)`,
      `CREATE TABLE documents (pageId TEXT PRIMARY KEY REFERENCES pages(id), snapshot BLOB NOT NULL)`,
      `CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT, pageId TEXT NOT NULL REFERENCES pages(id), data BLOB NOT NULL)`,
      `CREATE INDEX updates_page ON updates(pageId, id)`,
      `CREATE TABLE limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expiresAt INTEGER NOT NULL)`,
    ],
  },
  { version: 2, statements: ['ALTER TABLE pages ADD COLUMN emoji TEXT'] },
  {
    version: 3,
    statements: [
      'CREATE TABLE page_visits (userId TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, pageId TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE, viewedAt INTEGER NOT NULL, PRIMARY KEY(userId, pageId))',
      'CREATE INDEX visits_recent ON page_visits(userId, viewedAt DESC)',
      'CREATE TABLE images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL)',
      'CREATE TABLE image_chunks (imageId TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE, position INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(imageId, position))',
    ],
  },
];
export function migrate(store: Store) {
  store.run(
    'CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)',
  );
  for (const migration of migrations) {
    if (
      store.all(
        'SELECT version FROM migrations WHERE version = ?',
        migration.version,
      ).length
    )
      continue;
    store.transaction(() => {
      for (const sql of migration.statements) store.run(sql);
      store.run('INSERT INTO migrations VALUES (?)', migration.version);
    });
  }
}
