/**
 * One server per data directory (replaces Electron's single-instance lock): `<dataDir>/server.lock`
 * records the pid, host and boot time. A lock is stale when its host or boot differs (reboot or power
 * cut, where the pid may have been reused) or its process is gone; a live one refuses the start.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

interface LockInfo {
  pid: number;
  host: string;
  bootTime: number;
  startedAt: string;
}

const BOOT_TOLERANCE_MS = 120_000;

function bootTime(): number {
  return Date.now() - os.uptime() * 1000;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: exists but owned by someone else
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function lockFile(dataDir: string): string {
  return path.join(dataDir, 'server.lock');
}

/** The other live process holding the lock, or null */
export function lockHolder(dataDir: string): LockInfo | null {
  let info: LockInfo;
  try {
    info = JSON.parse(fs.readFileSync(lockFile(dataDir), 'utf8')) as LockInfo;
  } catch {
    return null;
  }
  if (!info || typeof info.pid !== 'number' || info.pid === process.pid) return null;
  if (info.host !== os.hostname() || Math.abs(info.bootTime - bootTime()) > BOOT_TOLERANCE_MS) return null;
  return alive(info.pid) ? info : null;
}

function holderMessage(dataDir: string, holder: LockInfo): string {
  return (
    `Another BotLab server (pid ${holder.pid}, started ${holder.startedAt}) is using ${dataDir}. ` +
    `Stop it first (or delete ${lockFile(dataDir)} if that process is not BotLab).`
  );
}

/**
 * Creates the lock with `wx` (atomic: two servers starting at once cannot both win). If a lock file
 * exists and its holder is stale, it is removed and creation retried once.
 */
export function acquireInstanceLock(dataDir: string): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = lockFile(dataDir);
  const info: LockInfo = { pid: process.pid, host: os.hostname(), bootTime: bootTime(), startedAt: new Date().toISOString() };
  const create = () => fs.writeFileSync(file, JSON.stringify(info), { encoding: 'utf8', flag: 'wx' });
  try {
    create();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const holder = lockHolder(dataDir);
    if (holder) throw new Error(holderMessage(dataDir, holder));
    fs.rmSync(file, { force: true });
    try {
      create();
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code !== 'EEXIST') throw retryErr;
      const winner = lockHolder(dataDir);
      throw new Error(winner ? holderMessage(dataDir, winner) : `Could not take the server lock ${file}: another server is starting`);
    }
  }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
      if (current.pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
  };
}
