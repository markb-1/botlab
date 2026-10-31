/**
 * Config history (spec §3: the UI shows history and can revert).
 *
 * One snapshot of the file text per accepted change, stored as files in the data dir:
 *   <dir>/<file>/<versionId>.yaml   the exact file text
 *   <dir>/<file>/<versionId>.json   { actor, source, at, sha256 }
 * versionId = compact UTC timestamp + counter, so lexical order is chronological and the name
 * is valid on every OS. Only the newest MAX_VERSIONS per file are kept.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';

export const MAX_VERSIONS = 100;

export interface ConfigVersion {
  versionId: string;
  file: string;
  at: string;
  actor: string;
  source: string;
  sha256: string;
}

export const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');

export class ConfigHistory {
  constructor(private dir: string) {}

  private fileDir(file: string): string {
    if (!/^[a-z]+$/.test(file)) throw new Error(`Invalid config file name: ${file}`);
    return path.join(this.dir, file);
  }

  /** Newest first. */
  list(file: string): ConfigVersion[] {
    const dir = this.fileDir(file);
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
    const out: ConfigVersion[] = [];
    for (const name of names.sort().reverse()) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as Omit<ConfigVersion, 'versionId' | 'file'>;
        out.push({ ...meta, versionId: name.slice(0, -'.json'.length), file });
      } catch {
        /* unreadable sidecar: skip */
      }
    }
    return out;
  }

  latest(file: string): ConfigVersion | null {
    return this.list(file)[0] ?? null;
  }

  /** Text of a version; null if unknown. */
  read(file: string, versionId: string): string | null {
    if (!/^[0-9TZ-]+$/.test(versionId)) return null;
    try {
      return fs.readFileSync(path.join(this.fileDir(file), `${versionId}.yaml`), 'utf8');
    } catch {
      return null;
    }
  }

  /** Record a snapshot. A snapshot equal to the newest one is not stored again. */
  record(file: string, text: string, actor: string, source: string, now: Date = new Date()): ConfigVersion | null {
    const hash = sha256(text);
    const newest = this.latest(file);
    if (newest?.sha256 === hash) return null;

    const dir = this.fileDir(file);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[-:.]/g, '');
    let versionId = stamp;
    for (let i = 1; newest && versionId <= newest.versionId; i++) versionId = `${stamp}-${i}`; // keep order strictly increasing
    for (let i = 1; fs.existsSync(path.join(dir, `${versionId}.json`)); i++) versionId = `${stamp}-${i}`;

    const meta = { actor, source, at: now.toISOString(), sha256: hash };
    writeFileAtomic.sync(path.join(dir, `${versionId}.yaml`), text);
    writeFileAtomic.sync(path.join(dir, `${versionId}.json`), JSON.stringify(meta));
    this.prune(file);
    return { ...meta, versionId, file };
  }

  private prune(file: string): void {
    const all = this.list(file);
    for (const old of all.slice(MAX_VERSIONS)) {
      for (const ext of ['yaml', 'json']) {
        try {
          fs.unlinkSync(path.join(this.fileDir(file), `${old.versionId}.${ext}`));
        } catch {
          /* best effort */
        }
      }
    }
  }
}
