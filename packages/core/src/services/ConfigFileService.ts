/**
 * ConfigFileService — read / write / history / restore of the human-owned config files (moved out
 * of the Electron `configHandlers`, spec §3). Writes are human-only (ConfigService refuses other
 * actors). Secrets (the Telegram token) are masked in `get`; sending the mask back unchanged in
 * `write` keeps the stored value.
 */

import { configJsonSchemas, type ConfigChangedEvent, type ConfigService } from '../config/ConfigService';
import { CONFIG_FILE_NAMES, type ConfigFileName } from '../config/changes';
import { requireActor, type Actor, type HumanActor } from './actors';
import { invalidInput, notFound } from './errors';

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

  /** Current config (secrets masked), the last load error and each file's SHA-256. Human or agent. */
  get(actor: Actor) {
    requireActor(actor, ['human', 'agent'], 'config.get');
    const { config } = this;
    return { config: config.getRedacted(), error: config.getLastError(), hashes: config.getFileHashes() };
  }

  /** Human only. `expectedSha256`: the hash from `get()`; the write is refused if the file changed since */
  async write(file: unknown, value: unknown, actor: HumanActor, expectedSha256?: unknown): Promise<ConfigChangeSummary> {
    return summary(await this.config.write(asFile(file), value, actor, typeof expectedSha256 === 'string' ? expectedSha256 : undefined));
  }

  /** Version metadata (no file text). Human or agent. */
  history(file: unknown, actor: Actor) {
    requireActor(actor, ['human', 'agent'], 'config.history');
    return this.config.history(asFile(file));
  }

  /** JSON Schema of each file (UI forms) */
  schemas() {
    return configJsonSchemas();
  }

  /** Validate and classify an edit without writing it (UI "review changes"). Human only. */
  preview(file: unknown, value: unknown, actor: HumanActor) {
    requireActor(actor, ['human'], 'config.preview');
    return this.config.preview(asFile(file), value);
  }

  /** Text of a history version, secrets redacted (UI diff). Human only. */
  versionText(file: unknown, versionId: unknown, actor: HumanActor): { versionId: string; text: string } {
    requireActor(actor, ['human'], 'config.versionText');
    const id = String(versionId);
    const text = this.config.versionText(asFile(file), id);
    if (text === null) throw notFound(`Unknown version ${id}`);
    return { versionId: id, text };
  }

  /** Human only */
  async restore(file: unknown, versionId: unknown, actor: HumanActor): Promise<ConfigChangeSummary> {
    return summary(await this.config.restore(asFile(file), String(versionId), actor));
  }
}
