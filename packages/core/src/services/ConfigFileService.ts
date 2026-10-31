/**
 * ConfigFileService — read / write / history / restore of the human-owned config files (moved out
 * of the Electron `configHandlers`, spec §3). Writes are human-only (ConfigService refuses other
 * actors). Secrets (the Telegram token) are masked in `get`; sending the mask back unchanged in
 * `write` keeps the stored value.
 */

import type { ConfigChangedEvent, ConfigService } from '../config/ConfigService';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '../config/changes';
import type { AuditActor } from '../audit/AuditService';
import { invalidInput } from './errors';

export interface ConfigChangeSummary {
  changes: ConfigChangedEvent['changes'];
  raises: string[];
}

function asFile(file: unknown): ConfigFileName {
  if (typeof file !== 'string' || !CONFIG_FILE_NAMES.includes(file as ConfigFileName)) throw invalidInput(`Unknown config file: ${String(file)}`);
  return file as ConfigFileName;
}

const summary = (e: ConfigChangedEvent | null): ConfigChangeSummary =>
  e ? { changes: e.changes, raises: e.raises.map((c) => `${c.file}.${c.path}`) } : { changes: [], raises: [] };

export class ConfigFileService {
  constructor(private config: ConfigService) {}

  /** Current config (secrets masked), the last load error and each file's SHA-256 */
  get() {
    const { config } = this;
    return { config: config.getRedacted(), error: config.getLastError(), hashes: config.getFileHashes() };
  }

  /** `expectedSha256`: the hash from `get()`; the write is refused if the file changed since */
  async write(file: unknown, value: unknown, actor: AuditActor, expectedSha256?: unknown): Promise<ConfigChangeSummary> {
    return summary(await this.config.write(asFile(file), value, actor, typeof expectedSha256 === 'string' ? expectedSha256 : undefined));
  }

  history(file: unknown) {
    return this.config.history(asFile(file));
  }

  async restore(file: unknown, versionId: unknown, actor: AuditActor): Promise<ConfigChangeSummary> {
    return summary(await this.config.restore(asFile(file), String(versionId), actor));
  }
}
