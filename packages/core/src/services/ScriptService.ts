/**
 * ScriptService — script CRUD, compile, fork, `.botlab` export/import (moved out of the Electron
 * `scriptHandlers`). Export returns the file object and import takes file contents; choosing and
 * reading/writing files (save/open dialogs, uploads) is the transport's job.
 */

import type { ScriptRepository } from '../db/repositories/ScriptRepository';
import type { IpcScript } from './types';
import type { AuditService } from '../audit/AuditService';
import { auditActorOf, requireActor, type Actor } from './actors';
import { compileScript } from '../runtime/compileScript';
import { conflict, notFound } from './errors';
import type { ScriptCreateInput, ScriptImportFile, ScriptUpdateInput } from './schemas';

/** .botlab file format */
export interface BotLabScriptFile {
  format: 'botlab-script-v1';
  meta: {
    name: string;
    description: string;
    version: string;
    author: string;
  };
  configSchema: Record<string, unknown>;
  source: string;
}

export interface ScriptImportResult {
  imported: number;
  scripts: IpcScript[];
  errors?: string[];
}

function scriptRowToIpc(row: any): IpcScript {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    version: row.version,
    author: row.author,
    source: row.source,
    configSchema: JSON.parse(row.config_schema || '{}'),
    isTemplate: row.is_template === 1,
    origin: row.origin,
    revision: row.revision,
    trust: row.trust,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface ScriptServiceDeps {
  scriptRepo: ScriptRepository;
  audit?: AuditService;
}

export class ScriptService {
  constructor(private deps: ScriptServiceDeps) {}

  private auditScript(
    by: Actor,
    action: string,
    row: { id: string; name: string; revision: number; trust: string; source_hash: string | null },
    extra: Record<string, unknown> = {}
  ): void {
    this.deps.audit?.record(auditActorOf(by), action, row.id, { name: row.name, revision: row.revision, trust: row.trust, sourceHash: row.source_hash, ...extra });
  }

  list(): IpcScript[] {
    return this.deps.scriptRepo.findAll().map(scriptRowToIpc);
  }

  get(id: string): IpcScript {
    const row = this.deps.scriptRepo.findById(id);
    if (!row) throw notFound('Script not found');
    return scriptRowToIpc(row);
  }

  /** Compile check only, does not save */
  async compile(source: string): Promise<{ compiled: true } | { compiled: false; error: string }> {
    const result = await compileScript(source);
    if ('error' in result) {
      return { compiled: false, error: result.error };
    }
    return { compiled: true };
  }

  async create(data: ScriptCreateInput, actor: Actor): Promise<IpcScript> {
    requireActor(actor, ['human', 'agent'], 'scripts.create');
    // Compile TypeScript to JavaScript
    let compiled: string | undefined;
    const compileResult = await compileScript(data.source);
    if ('code' in compileResult) {
      compiled = compileResult.code;
    }

    const row = this.deps.scriptRepo.create({
      name: data.name,
      description: data.description,
      version: data.version,
      author: data.author,
      source: data.source,
      compiled,
      configSchema: data.configSchema,
      isTemplate: false,
    });
    this.auditScript(actor, 'script.create', row, { compiled: compiled !== undefined });
    return scriptRowToIpc(row);
  }

  async update(id: string, input: ScriptUpdateInput, actor: Actor): Promise<IpcScript> {
    requireActor(actor, ['human', 'agent'], 'scripts.update');
    const { scriptRepo } = this.deps;
    const data = { ...input };
    // Don't allow editing templates directly
    const existing = scriptRepo.findById(id);
    if (!existing) throw notFound('Script not found');
    if (existing.is_template) {
      throw conflict('Cannot edit template scripts. Fork it to create a custom copy.');
    }

    // Auto-bump patch version if source code changed and no explicit version provided
    if (data.source && data.source !== existing.source && !data.version) {
      const parts = (existing.version || '1.0.0').split('.');
      const patch = parseInt(parts[2] || '0', 10) + 1;
      data.version = `${parts[0] || '1'}.${parts[1] || '0'}.${patch}`;
    }

    // Recompile if source changed OR if script has never been compiled
    let compiled: string | null | undefined;
    const sourceChanged = data.source && data.source !== existing.source;
    const needsCompile = sourceChanged || !existing.compiled;
    if (needsCompile) {
      const sourceToCompile = data.source || existing.source;
      const compileResult = await compileScript(sourceToCompile);
      if ('code' in compileResult) {
        compiled = compileResult.code;
      } else {
        compiled = null; // Clear compiled on error
      }
    }

    const row = scriptRepo.update(id, { ...data, ...(compiled !== undefined ? { compiled } : {}) });
    if (!row) throw notFound('Script not found');
    this.auditScript(actor, 'script.update', row, {
      fields: Object.keys(data),
      sourceChanged: row.revision !== existing.revision,
      previousRevision: existing.revision,
      previousTrust: existing.trust,
    });
    return scriptRowToIpc(row);
  }

  delete(id: string, actor: Actor): void {
    requireActor(actor, ['human', 'agent'], 'scripts.delete');
    const deleted = this.deps.scriptRepo.delete(id);
    if (!deleted) throw conflict('Script not found, is a template, or has bots using it');
    this.deps.audit?.record(auditActorOf(actor), 'script.delete', id);
  }

  /** Config schema of a script */
  getSchema(id: string): Record<string, unknown> {
    const row = this.deps.scriptRepo.findById(id);
    if (!row) throw notFound('Script not found');
    return JSON.parse(row.config_schema || '{}');
  }

  /** Copy a script (typically a template) into a new, editable custom script */
  async fork(id: string, newName: string | undefined, actor: Actor): Promise<IpcScript> {
    requireActor(actor, ['human', 'agent'], 'scripts.fork');
    const { scriptRepo } = this.deps;
    const original = scriptRepo.findById(id);
    if (!original) throw notFound('Script not found');

    // Compile the forked source
    let compiled: string | undefined;
    const compileResult = await compileScript(original.source);
    if ('code' in compileResult) {
      compiled = compileResult.code;
    }

    const forkedRow = scriptRepo.create({
      name: newName || `${original.name} (Custom)`,
      description: original.description,
      version: '1.0.0',
      author: '',
      source: original.source,
      compiled,
      configSchema: original.config_schema,
      isTemplate: false,
    });
    this.auditScript(actor, 'script.create', forkedRow, { forkedFrom: original.id, forkedRevision: original.revision });

    return scriptRowToIpc(forkedRow);
  }

  /** The `.botlab` file for a script, plus a suggested file name */
  exportScript(id: string): { fileName: string; file: BotLabScriptFile } {
    const row = this.deps.scriptRepo.findById(id);
    if (!row) throw notFound('Script not found');
    const script = scriptRowToIpc(row);
    return {
      fileName: `${script.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}.botlab`,
      file: {
        format: 'botlab-script-v1',
        meta: {
          name: script.name,
          description: script.description,
          version: script.version,
          author: script.author,
        },
        configSchema: script.configSchema,
        source: script.source,
      },
    };
  }

  /** Import `.botlab` files; a bad file is reported in `errors` and does not stop the others */
  async importScripts(files: ScriptImportFile[], actor: Actor): Promise<ScriptImportResult> {
    requireActor(actor, ['human', 'agent'], 'scripts.import');
    const imported: IpcScript[] = [];
    const errors: string[] = [];

    for (const { name: filePath, content } of files) {
      try {
        const parsed = JSON.parse(content) as BotLabScriptFile;

        // Validate format
        if (parsed.format !== 'botlab-script-v1') {
          errors.push(`${filePath}: Invalid file format (expected botlab-script-v1)`);
          continue;
        }

        // Validate required fields
        if (!parsed.source || typeof parsed.source !== 'string') {
          errors.push(`${filePath}: Missing or invalid source code`);
          continue;
        }

        if (!parsed.meta?.name) {
          errors.push(`${filePath}: Missing script name`);
          continue;
        }

        // Validate script has required exports (basic check)
        const hasOnStart = /export\s+(async\s+)?function\s+onStart/.test(parsed.source);
        if (!hasOnStart) {
          errors.push(`${filePath}: Script must export an onStart function`);
          continue;
        }

        // Compile with esbuild
        const compileResult = await compileScript(parsed.source);
        if ('error' in compileResult) {
          errors.push(`${filePath}: Compilation error - ${compileResult.error}`);
          continue;
        }

        // Create the script in the database
        const row = this.deps.scriptRepo.create({
          name: parsed.meta.name,
          description: parsed.meta.description || '',
          version: parsed.meta.version || '1.0.0',
          author: parsed.meta.author || 'Imported',
          source: parsed.source,
          compiled: compileResult.code,
          configSchema: parsed.configSchema || {},
          isTemplate: false,
        });
        this.auditScript(actor, 'script.create', row, { importedFrom: filePath });

        imported.push(scriptRowToIpc(row));
      } catch (fileErr: any) {
        errors.push(`${filePath}: ${fileErr.message}`);
      }
    }

    return {
      imported: imported.length,
      scripts: imported,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}
