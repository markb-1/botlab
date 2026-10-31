/**
 * Data and web directories (spec §15.2). All paths via `path`, so Windows separators work.
 *
 * Data dir: `BOTLAB_DATA_DIR`, else in production (`NODE_ENV=production`, i.e. `npm start`, Docker, the
 * Windows service) the OS app-data dir, else `<cwd>/data`. The OS dirs match the Electron app's
 * `userData`, so `npm start` finds an existing Electron database on macOS and Windows:
 * `~/Library/Application Support/BotLab`, `%APPDATA%\BotLab`, `~/.local/share/botlab`.
 * The config dir: `BOTLAB_CONFIG_DIR`, else in production `<data dir>/config` when `BOTLAB_DATA_DIR` is set, else the
 * OS app-data dir + `config`; `<cwd>/config` in dev (`resolveConfigDir` in core).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export function isProduction(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV === 'production';
}

export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homeDir: string = os.homedir()): string {
  switch (platform) {
    case 'darwin':
      return path.join(homeDir, 'Library', 'Application Support', 'BotLab');
    case 'win32':
      return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'BotLab');
    default:
      return path.join(homeDir, '.local', 'share', 'botlab');
  }
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, homeDir: string = os.homedir()): string {
  if (env.BOTLAB_DATA_DIR) return path.resolve(env.BOTLAB_DATA_DIR);
  if (isProduction(env)) return appDataDir(env, platform, homeDir);
  return path.join(process.cwd(), 'data');
}

/**
 * The built web app (`apps/web/dist`): `BOTLAB_WEB_DIR`, else next to the sources (tsx:
 * `apps/server/src` → `apps/web/dist`) or the compiled server (`dist/apps/server/src` → `<repo>/apps/web/dist`),
 * else `<cwd>/apps/web/dist`. Null if none has an index.html (dev: Vite serves the UI).
 */
export function resolveWebDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    ...(env.BOTLAB_WEB_DIR ? [path.resolve(env.BOTLAB_WEB_DIR)] : []),
    path.resolve(__dirname, '..', '..', 'web', 'dist'),
    path.resolve(__dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    path.resolve(process.cwd(), 'apps', 'web', 'dist'),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}
