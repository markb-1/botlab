import type Database from 'better-sqlite3';
import { generateId } from '../index';

export interface ScriptRow {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  compiled: string | null;
  config_schema: string; // JSON string
  is_template: number; // SQLite boolean (0/1)
  created_at: string;
  updated_at: string;
}

export class ScriptRepository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  findById(id: string): ScriptRow | undefined {
    return this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined;
  }

  findAll(): ScriptRow[] {
    return this.db
      .prepare('SELECT * FROM scripts ORDER BY is_template DESC, created_at DESC')
      .all() as ScriptRow[];
  }

  findTemplates(): ScriptRow[] {
    return this.db
      .prepare('SELECT * FROM scripts WHERE is_template = 1 ORDER BY name ASC')
      .all() as ScriptRow[];
  }

  findByNameAndVersion(name: string, version: string): ScriptRow | undefined {
    return this.db
      .prepare('SELECT * FROM scripts WHERE name = ? AND version = ?')
      .get(name, version) as ScriptRow | undefined;
  }

  create(data: {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    source: string;
    compiled?: string;
    configSchema?: Record<string, unknown> | string;
    isTemplate?: boolean;
  }): ScriptRow {
    const id = generateId();
    const now = new Date().toISOString();
    const configSchema =
      typeof data.configSchema === 'string'
        ? data.configSchema
        : JSON.stringify(data.configSchema || {});

    this.db
      .prepare(
        `INSERT INTO scripts (id, name, description, version, author, source, compiled, config_schema, is_template, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.name,
        data.description || '',
        data.version || '1.0.0',
        data.author || '',
        data.source,
        data.compiled || null,
        configSchema,
        data.isTemplate ? 1 : 0,
        now,
        now
      );

    return this.findById(id)!;
  }

  update(
    id: string,
    data: Partial<{
      name: string;
      description: string;
      version: string;
      author: string;
      source: string;
      compiled: string | null;
      configSchema: Record<string, unknown> | string;
    }>
  ): ScriptRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (data.name !== undefined) { sets.push('name = ?'); values.push(data.name); }
    if (data.description !== undefined) { sets.push('description = ?'); values.push(data.description); }
    if (data.version !== undefined) { sets.push('version = ?'); values.push(data.version); }
    if (data.author !== undefined) { sets.push('author = ?'); values.push(data.author); }
    if (data.source !== undefined) { sets.push('source = ?'); values.push(data.source); }
    if (data.compiled !== undefined) { sets.push('compiled = ?'); values.push(data.compiled); }
    if (data.configSchema !== undefined) {
      sets.push('config_schema = ?');
      values.push(
        typeof data.configSchema === 'string'
          ? data.configSchema
          : JSON.stringify(data.configSchema)
      );
    }

    if (sets.length === 0) return this.findById(id);

    sets.push("updated_at = datetime('now')");
    values.push(id);

    this.db.prepare(`UPDATE scripts SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    return this.findById(id);
  }

  delete(id: string): boolean {
    // Don't delete templates
    const script = this.findById(id);
    if (!script || script.is_template) return false;

    // Check if any bots reference this script
    const botCount = this.db
      .prepare('SELECT COUNT(*) as count FROM bots WHERE script_id = ?')
      .get(id) as { count: number };
    if (botCount.count > 0) return false;

    const result = this.db.prepare('DELETE FROM scripts WHERE id = ? AND is_template = 0').run(id);
    return result.changes > 0;
  }
}
