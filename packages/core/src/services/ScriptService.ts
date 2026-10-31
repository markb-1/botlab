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
import type { ScriptDiagnostic, TypecheckResult } from '../runtime/typecheckScript';
import { TypecheckLimitError, TypecheckRunner } from '../runtime/TypecheckRunner';
import { conflict, notFound, ServiceError } from './errors';
import type { ScriptCreateInput, ScriptImportFile, ScriptUpdateInput } from './schemas';
import type { MandateConfig } from '../config/schema';

/** compile + typecheck (spec §5.3, §7.3 validate_script) */
export interface ScriptValidation {
  ok: boolean;
  compiled: boolean;
  compileError: string | null;
  diagnostics: ScriptDiagnostic[];
  /** Diagnostics left out (only the first 50 are returned) */
  truncated: number;
  /** The typecheck could not finish (timeout / memory limit / busy, R144); ok is false */
  typecheckError: string | null;
}

/** Template summary for list_templates (no source) */
export interface TemplateSummary {
  id: string;
  name: string;
  description: string;
  origin: string;
  revision: number;
  trust: string;
  builtin: boolean;
  configSchema: Record<string, unknown>;
  updatedAt: string;
}

/** Source size cap for validation / templates (R144): bounds compile and typecheck work */
export const MAX_SCRIPT_SOURCE_CHARS = 64 * 1024;

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
    kind: row.kind,
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
  /** Mandate in force (`strategies.allow_custom_templates` gates agent templates); null = config unavailable */
  getMandate?: () => MandateConfig | null;
  /** Typecheck (default: a worker thread with time and memory limits, R144) */
  typecheck?: (source: string) => Promise<TypecheckResult>;
}

const originOf = (actor: Actor): 'human' | 'agent' => (actor.kind === 'agent' ? 'agent' : 'human');

export class ScriptService {
  private runner: TypecheckRunner | null = null;

  constructor(private deps: ScriptServiceDeps) {}

  private typecheck(source: string): Promise<TypecheckResult> {
    if (this.deps.typecheck) return this.deps.typecheck(source);
    this.runner ??= new TypecheckRunner();
    return this.runner.run(source);
  }

  /** Stop the typecheck worker (core shutdown) */
  async close(): Promise<void> {
    await this.runner?.close();
    this.runner = null;
  }

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

  /** Source versions (script_versions), newest first, without the source text */
  versions(id: string): Array<{ version: number; sourceHash: string; createdAt: string; createdBy: string }> {
    if (!this.deps.scriptRepo.findById(id)) throw notFound('Script not found');
    return this.deps.scriptRepo.findVersions(id).map((v) => ({ version: v.version, sourceHash: v.source_hash, createdAt: v.created_at, createdBy: v.created_by }));
  }

  /** One version's source (bot code view, version diff) */
  version(id: string, version: number): { version: number; source: string; sourceHash: string; createdAt: string; createdBy: string } {
    const v = this.deps.scriptRepo.findVersions(id).find((r) => r.version === version);
    if (!v) throw notFound(`Version ${version} of script ${id} not found`);
    return { version: v.version, source: v.source, sourceHash: v.source_hash, createdAt: v.created_at, createdBy: v.created_by };
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
    const who = requireActor(actor, ['human', 'agent'], 'scripts.create');
    // Agent code must compile and typecheck (R135 amended)
    if (who.kind === 'agent') this.requireValid(await this.validate(data.source), actor, 'script.create', null);
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
      origin: originOf(who),
    });
    this.auditScript(actor, 'script.create', row, { compiled: compiled !== undefined });
    return scriptRowToIpc(row);
  }

  /** Compile (esbuild, imports rejected) and typecheck against botlab-sdk.d.ts; saves nothing */
  async validate(source: unknown): Promise<ScriptValidation> {
    if (typeof source !== 'string' || !source.trim()) throw new ServiceError('invalid_input', 'source is required');
    if (source.length > MAX_SCRIPT_SOURCE_CHARS) throw new ServiceError('invalid_input', `source is longer than ${MAX_SCRIPT_SOURCE_CHARS} characters`);
    // esbuild compiles in its own child process; the TypeScript check runs in a limited worker thread
    const compiled = await compileScript(source);
    const compileError = 'error' in compiled ? compiled.error : null;
    let tc: TypecheckResult | null = null;
    let typecheckError: string | null = null;
    try {
      tc = await this.typecheck(source);
    } catch (err) {
      if (!(err instanceof TypecheckLimitError)) throw err;
      if (err.reason === 'busy') throw new ServiceError('conflict', err.message);
      typecheckError = err.message;
    }
    return {
      ok: compileError === null && tc !== null && tc.ok,
      compiled: compileError === null,
      compileError,
      diagnostics: tc?.diagnostics ?? [],
      truncated: tc?.truncated ?? 0,
      typecheckError,
    };
  }

  /** Scripts of kind template (builtin, human or agent), without source (spec §7.3 list_templates) */
  templates(): TemplateSummary[] {
    return this.deps.scriptRepo.findByKind('template').map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      origin: r.origin,
      revision: r.revision,
      trust: r.trust,
      builtin: r.is_template === 1,
      configSchema: JSON.parse(r.config_schema || '{}') as Record<string, unknown>,
      updatedAt: r.updated_at,
    }));
  }

  private requireValid(v: ScriptValidation, by: Actor, action: string, target: string | null): void {
    if (v.ok) return;
    const first = v.compileError ?? v.typecheckError ?? v.diagnostics.filter((d) => d.category === 'error').slice(0, 5).map((d) => `${d.line}:${d.column} ${d.message}`).join('; ');
    this.deps.audit?.record(auditActorOf(by), action, target, { compiled: v.compiled, errors: v.diagnostics.length }, 'denied: script does not compile / typecheck');
    throw new ServiceError('invalid_input', `Script does not compile or typecheck (run validate_script): ${first}`);
  }

  /**
   * A new template (spec §7.3 create_template): kind template, trust new, origin = the actor. It must compile
   * and typecheck. The agent may write templates only while the mandate allows custom templates.
   */
  async createTemplate(data: ScriptCreateInput, actor: Actor): Promise<IpcScript> {
    const who = requireActor(actor, ['human', 'agent'], 'scripts.createTemplate');
    const { scriptRepo } = this.deps;
    if (who.kind === 'agent') {
      const mandate = this.deps.getMandate?.() ?? null;
      if (!mandate || !mandate.strategies.allow_custom_templates) {
        this.deps.audit?.record('agent', 'script.create', null, { name: data.name }, 'denied: mandate does not allow custom templates');
        throw new ServiceError('forbidden', 'scripts.createTemplate: the mandate does not allow custom templates (mandate.strategies.allow_custom_templates)');
      }
    }
    const name = data.name.trim().slice(0, 100);
    if (!name) throw new ServiceError('invalid_input', 'name is required');
    const version = data.version || '1.0.0';
    if (scriptRepo.findByNameAndVersion(name, version)) throw conflict(`A script named "${name}" version ${version} already exists`);
    const v = await this.validate(data.source);
    this.requireValid(v, actor, 'script.create', null);
    const compiled = await compileScript(data.source);
    const row = scriptRepo.create({
      name,
      description: data.description,
      version,
      author: data.author || (who.kind === 'agent' ? 'agent' : ''),
      source: data.source,
      compiled: 'code' in compiled ? compiled.code : undefined,
      configSchema: data.configSchema,
      isTemplate: false,
      kind: 'template',
      origin: originOf(who),
      trust: 'new',
    });
    this.auditScript(actor, 'script.create', row, { kind: 'template', origin: row.origin });
    return scriptRowToIpc(row);
  }

  /**
   * New version of a template (spec §7.3 update_template): trust back to new and every bot on it back to paper
   * (ScriptRepository.update). Builtin templates cannot be edited; the agent may edit only agent templates.
   */
  async updateTemplate(id: string, input: ScriptUpdateInput, actor: Actor): Promise<IpcScript> {
    requireActor(actor, ['human', 'agent'], 'scripts.updateTemplate');
    const existing = this.deps.scriptRepo.findById(id);
    if (!existing) throw notFound('Script not found');
    if (existing.kind !== 'template') throw conflict('Not a template (update_template edits templates only)');
    return this.update(id, input, actor, { validate: true });
  }

  /** `validate`: the new source must compile and typecheck — always for the agent (R135), and for templates */
  async update(id: string, input: ScriptUpdateInput, actor: Actor, opts: { validate?: boolean } = {}): Promise<IpcScript> {
    const who = requireActor(actor, ['human', 'agent'], 'scripts.update');
    const { scriptRepo } = this.deps;
    const data = { ...input };
    // Don't allow editing templates directly
    const existing = scriptRepo.findById(id);
    if (!existing) throw notFound('Script not found');
    if (existing.is_template) {
      throw conflict('Cannot edit template scripts. Fork it to create a custom copy.');
    }
    // The agent edits only what it wrote (Decision R135): never a human's script that live bots may run
    if (who.kind === 'agent' && existing.origin !== 'agent') {
      this.deps.audit?.record('agent', 'script.update', id, { name: existing.name, origin: existing.origin }, 'denied: not an agent script');
      throw new ServiceError('forbidden', 'scripts.update: the agent may only edit scripts it wrote (origin agent)');
    }
    if ((opts.validate || who.kind === 'agent') && data.source !== undefined && data.source !== existing.source) {
      this.requireValid(await this.validate(data.source), actor, 'script.update', id);
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

    const row = scriptRepo.update(id, { ...data, ...(compiled !== undefined ? { compiled } : {}) }, originOf(who));
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
    const who = requireActor(actor, ['human', 'agent'], 'scripts.delete');
    if (who.kind === 'agent' && this.deps.scriptRepo.findById(id)?.origin !== 'agent') {
      this.deps.audit?.record('agent', 'script.delete', id, undefined, 'denied: not an agent script');
      throw new ServiceError('forbidden', 'scripts.delete: the agent may only delete scripts it wrote (origin agent)');
    }
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
    const who = requireActor(actor, ['human', 'agent'], 'scripts.fork');
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
      origin: originOf(who),
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
    const who = requireActor(actor, ['human', 'agent'], 'scripts.import');
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
          origin: originOf(who),
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
