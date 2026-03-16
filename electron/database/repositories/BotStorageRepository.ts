import type Database from 'better-sqlite3';

export interface BotStorageRow {
  bot_id: string;
  key: string;
  value: string | null;
  updated_at: string;
}

export class BotStorageRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(botId: string, key: string): unknown | null {
    const row = this.db
      .prepare('SELECT value FROM bot_storage WHERE bot_id = ? AND key = ?')
      .get(botId, key) as { value: string | null } | undefined;

    if (!row || row.value === null) return null;

    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  set(botId: string, key: string, value: unknown): void {
    const serialized = JSON.stringify(value);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO bot_storage (bot_id, key, value, updated_at)
         VALUES (?, ?, ?, datetime('now'))`
      )
      .run(botId, key, serialized);
  }

  delete(botId: string, key: string): boolean {
    const result = this.db
      .prepare('DELETE FROM bot_storage WHERE bot_id = ? AND key = ?')
      .run(botId, key);
    return result.changes > 0;
  }

  getAllForBot(botId: string): Record<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value FROM bot_storage WHERE bot_id = ?')
      .all(botId) as Array<{ key: string; value: string | null }>;

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        result[row.key] = row.value !== null ? JSON.parse(row.value) : null;
      } catch {
        result[row.key] = row.value;
      }
    }
    return result;
  }

  deleteAllForBot(botId: string): void {
    this.db.prepare('DELETE FROM bot_storage WHERE bot_id = ?').run(botId);
  }
}
