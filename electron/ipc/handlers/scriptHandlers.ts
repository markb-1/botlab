import { ipcMain, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import type { ScriptService } from '../../../packages/core/src/services/ScriptService';
import { ScriptCreateSchema, ScriptUpdateSchema, parseInput } from '../../../packages/core/src/services/schemas';
import { respond, ipcHuman } from '../respond';

/** Script IPC. The actor is `human`. Export/import use the native save/open dialogs; the files' content goes through ScriptService. */
export function registerScriptHandlers(scripts: ScriptService): void {
  ipcMain.handle('scripts:list', () => respond(() => scripts.list()));

  ipcMain.handle('scripts:get', (event, id: string) => respond(() => scripts.get(id)));

  // Compile script (check only, does not save)
  ipcMain.handle('scripts:compile', (event, source: string) => respond(() => scripts.compile(source)));

  ipcMain.handle('scripts:create', (event, data: unknown) => respond(() => scripts.create(parseInput(ScriptCreateSchema, data), ipcHuman(event))));

  ipcMain.handle('scripts:update', (event, id: string, data: unknown) => respond(() => scripts.update(id, parseInput(ScriptUpdateSchema, data), ipcHuman(event))));

  ipcMain.handle('scripts:delete', (event, id: string) => respond(() => scripts.delete(id, ipcHuman(event))));

  ipcMain.handle('scripts:getSchema', (event, id: string) => respond(() => scripts.getSchema(id)));

  // Fork a template script
  ipcMain.handle('scripts:fork', (event, id: string, newName?: string) => respond(() => scripts.fork(id, newName, ipcHuman(event))));

  // Export a script to a .botlab file
  ipcMain.handle('scripts:export', (event, id: string) =>
    respond(async () => {
      const { fileName, file } = scripts.exportScript(id);

      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(win!, {
        title: 'Export Script',
        defaultPath: fileName,
        filters: [
          { name: 'BotLab Script', extensions: ['botlab'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });

      if (result.canceled || !result.filePath) {
        return { exported: false };
      }

      fs.writeFileSync(result.filePath, JSON.stringify(file, null, 2), 'utf-8');
      return { exported: true, filePath: result.filePath };
    })
  );

  // Import script(s) from .botlab file(s)
  ipcMain.handle('scripts:import', (event) =>
    respond(async () => {
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
        return { imported: 0, scripts: [] };
      }

      const files: Array<{ name: string; content: string }> = [];
      const readErrors: string[] = [];
      for (const filePath of result.filePaths) {
        try {
          files.push({ name: filePath, content: fs.readFileSync(filePath, 'utf-8') });
        } catch (fileErr) {
          readErrors.push(`${filePath}: ${(fileErr as Error).message}`);
        }
      }
      const imported = await scripts.importScripts(files, ipcHuman(event));
      const errors = [...readErrors, ...(imported.errors ?? [])];
      return { ...imported, errors: errors.length > 0 ? errors : undefined };
    })
  );
}
