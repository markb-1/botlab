import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import type { ScriptRepository } from '../../../packages/core/src/db/repositories/ScriptRepository';
import type { IpcScript } from '../../../packages/core/src/services/types';
import type { AuditService } from '../../../packages/core/src/audit/AuditService';
import { compileScript } from '../../../packages/core/src/runtime/compileScript';

/** .botlab file format */
interface BotLabScriptFile {
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

export function registerScriptHandlers(
  scriptRepo: ScriptRepository,
  audit?: AuditService
): void {
  const auditScript = (action: string, row: { id: string; name: string; revision: number; trust: string; source_hash: string | null }, extra: Record<string, unknown> = {}) =>
    audit?.record('human', action, row.id, { name: row.name, revision: row.revision, trust: row.trust, sourceHash: row.source_hash, ...extra });

  // List all scripts
  ipcMain.handle('scripts:list', async () => {
    try {
      const rows = scriptRepo.findAll();
      return {
        success: true,
        data: rows.map(scriptRowToIpc),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get single script
  ipcMain.handle('scripts:get', async (_event, id: string) => {
    try {
      const row = scriptRepo.findById(id);
      if (!row) return { success: false, error: 'Script not found' };
      return {
        success: true,
        data: scriptRowToIpc(row),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Compile script (check only, does not save)
  ipcMain.handle('scripts:compile', async (_event, source: string) => {
    try {
      const result = await compileScript(source);
      if ('error' in result) {
        return { success: true, data: { compiled: false, error: result.error } };
      }
      return { success: true, data: { compiled: true } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Create script
  ipcMain.handle('scripts:create', async (_event, data: {
    name: string;
    description?: string;
    version?: string;
    author?: string;
    source: string;
    configSchema?: Record<string, unknown>;
  }) => {
    try {
      // Compile TypeScript to JavaScript
      let compiled: string | undefined;
      const compileResult = await compileScript(data.source);
      if ('code' in compileResult) {
        compiled = compileResult.code;
      }

      const row = scriptRepo.create({
        name: data.name,
        description: data.description,
        version: data.version,
        author: data.author,
        source: data.source,
        compiled,
        configSchema: data.configSchema,
        isTemplate: false,
      });
      auditScript('script.create', row, { compiled: compiled !== undefined });
      return {
        success: true,
        data: scriptRowToIpc(row),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Update script
  ipcMain.handle('scripts:update', async (_event, id: string, data: {
    name?: string;
    description?: string;
    version?: string;
    author?: string;
    source?: string;
    configSchema?: Record<string, unknown>;
  }) => {
    try {
      // Don't allow editing templates directly
      const existing = scriptRepo.findById(id);
      if (!existing) return { success: false, error: 'Script not found' };
      if (existing.is_template) {
        return { success: false, error: 'Cannot edit template scripts. Fork it to create a custom copy.' };
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
      if (!row) return { success: false, error: 'Script not found' };
      auditScript('script.update', row, {
        fields: Object.keys(data),
        sourceChanged: row.revision !== existing.revision,
        previousRevision: existing.revision,
        previousTrust: existing.trust,
      });
      return {
        success: true,
        data: scriptRowToIpc(row),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Delete script
  ipcMain.handle('scripts:delete', async (_event, id: string) => {
    try {
      const deleted = scriptRepo.delete(id);
      if (!deleted) return { success: false, error: 'Script not found, is a template, or has bots using it' };
      audit?.record('human', 'script.delete', id);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Get config schema for a script
  ipcMain.handle('scripts:getSchema', async (_event, id: string) => {
    try {
      const row = scriptRepo.findById(id);
      if (!row) return { success: false, error: 'Script not found' };
      return {
        success: true,
        data: JSON.parse(row.config_schema || '{}'),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Fork a template script
  ipcMain.handle('scripts:fork', async (_event, id: string, newName?: string) => {
    try {
      const original = scriptRepo.findById(id);
      if (!original) return { success: false, error: 'Script not found' };

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
      auditScript('script.create', forkedRow, { forkedFrom: original.id, forkedRevision: original.revision });

      return {
        success: true,
        data: scriptRowToIpc(forkedRow),
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Export a script to a .botlab file
  ipcMain.handle('scripts:export', async (_event, id: string) => {
    try {
      const row = scriptRepo.findById(id);
      if (!row) return { success: false, error: 'Script not found' };

      const script = scriptRowToIpc(row);

      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export Script',
        defaultPath: `${script.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}.botlab`,
        filters: [
          { name: 'BotLab Script', extensions: ['botlab'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { success: true, data: { exported: false } };
      }

      const fileContent: BotLabScriptFile = {
        format: 'botlab-script-v1',
        meta: {
          name: script.name,
          description: script.description,
          version: script.version,
          author: script.author,
        },
        configSchema: script.configSchema,
        source: script.source,
      };

      fs.writeFileSync(result.filePath, JSON.stringify(fileContent, null, 2), 'utf-8');

      return {
        success: true,
        data: { exported: true, filePath: result.filePath },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Import script(s) from .botlab file(s)
  ipcMain.handle('scripts:import', async () => {
    try {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showOpenDialog(win!, {
        title: 'Import Script',
        filters: [
          { name: 'BotLab Script', extensions: ['botlab'] },
          { name: 'All Files', extensions: ['*'] },
        ],
        properties: ['openFile', 'multiSelections'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: true, data: { imported: 0, scripts: [] } };
      }

      const imported: IpcScript[] = [];
      const errors: string[] = [];

      for (const filePath of result.filePaths) {
        try {
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(raw) as BotLabScriptFile;

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
          const row = scriptRepo.create({
            name: parsed.meta.name,
            description: parsed.meta.description || '',
            version: parsed.meta.version || '1.0.0',
            author: parsed.meta.author || 'Imported',
            source: parsed.source,
            compiled: compileResult.code,
            configSchema: parsed.configSchema || {},
            isTemplate: false,
          });
          auditScript('script.create', row, { importedFrom: filePath });

          imported.push(scriptRowToIpc(row));
        } catch (fileErr: any) {
          errors.push(`${filePath}: ${fileErr.message}`);
        }
      }

      return {
        success: true,
        data: {
          imported: imported.length,
          scripts: imported,
          errors: errors.length > 0 ? errors : undefined,
        },
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });
}
