/**
 * Database seed logic for script templates.
 * On first launch (or when templates are missing), reads template .ts files
 * and inserts them into the scripts table with is_template = 1.
 * Templates are compiled with esbuild at seed time so they're ready to use.
 */

import { BUILTIN_ROLES, type BuiltinRole, type ScriptRepository } from './repositories/ScriptRepository';
import { compileScript } from '../runtime/compileScript';

/**
 * Compile a template with the sandbox compiler (imports rejected, spec §5.1).
 */
async function compileSource(source: string): Promise<string | null> {
  const result = await compileScript(source);
  if ('error' in result) {
    console.warn('[Seed] Compilation failed:', result.error);
    return null;
  }
  return result.code;
}

// Template definitions embedded directly to avoid file path issues in packaged apps
const TEMPLATES: Array<{
  name: string;
  description: string;
  version: string;
  author: string;
  source: string;
  configSchema: Record<string, unknown>;
}> = [];

// We'll populate templates dynamically at build time or inline them.
// For now, use a function that reads from the repository and checks if seeding is needed.

/**
 * Parses a script source to extract the meta export.
 * Handles the common pattern: export const meta = { ... };
 */
function parseMetaFromSource(source: string): {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  configSchema?: Record<string, unknown>;
  role?: BuiltinRole;
  trust?: 'new' | 'proven';
} {
  try {
    // Extract the meta object using regex
    const metaMatch = source.match(
      /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\};)/
    );
    if (!metaMatch) return {};

    // Use Function constructor to evaluate the object literal
    // This is safe because we only run this on our own template files
    const metaStr = metaMatch[1];
    // eslint-disable-next-line no-new-func
    const meta = new Function(`return ${metaStr}`)();
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      author: meta.author,
      configSchema: meta.configSchema,
      // Standing role (5a) and initial trust; read only from our own template files
      role: BUILTIN_ROLES.includes(meta.role) ? meta.role : undefined,
      trust: meta.trust === 'new' || meta.trust === 'proven' ? meta.trust : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Seed template scripts into the database.
 * Only inserts templates that don't already exist (by name + version).
 * Compiles each template with esbuild so they're ready to use immediately.
 */
export async function seedTemplates(
  scriptRepo: ScriptRepository,
  templateSources: Array<{ filename: string; source: string }>
): Promise<number> {
  let seeded = 0;

  for (const { filename, source } of templateSources) {
    const meta = parseMetaFromSource(source);
    const name = meta.name || filename.replace(/\.ts$/, '');
    const version = meta.version || '1.0.0';

    // Check if this template already exists
    // Same name and version, else the builtin row of the same name (a new meta.version updates it in place, so its
    // bots run the new code — and go back to paper — instead of staying on an orphaned old row). Both lookups match
    // builtin template rows only: a human / imported / agent script with the same name and version is never touched.
    const builtins = scriptRepo.findAll().filter((r) => r.origin === 'builtin' && r.is_template === 1 && r.name === name);
    const existing = builtins.find((r) => r.version === version) ?? builtins[0];
    if (existing) {
      // Update source and recompile if template file has changed on disk
      const sourceChanged = existing.source.trim() !== source.trim();
      // (name, version) is unique: a non-builtin script already holding the new version keeps it, the builtin row
      // keeps its old version text (its source is still upgraded)
      if (existing.version !== version) {
        const taken = scriptRepo.findByNameAndVersion(name, version);
        if (!taken) scriptRepo.update(existing.id, { version }, 'system');
        else console.warn(`[Seed] ${name} v${version} is taken by a ${taken.origin} script: the builtin keeps version ${existing.version}`);
      }
      if (sourceChanged || !existing.compiled) {
        const compiled = await compileSource(source);
        if (compiled) {
          // A changed source also brings its description and config schema (the agent's config checks read the
          // schema, R172); the 1c rule sends every bot on it back to paper (ScriptRepository.update)
          scriptRepo.update(
            existing.id,
            { source, compiled, ...(sourceChanged ? { description: meta.description || '', configSchema: meta.configSchema || {} } : {}) },
            'system'
          );
          // A builtin whose meta says trust `new` (5c: Copy Trading v2) must prove the changed code again (R183)
          if (sourceChanged && meta.trust === 'new' && existing.trust !== 'new') scriptRepo.setTrust(existing.id, 'new');
          console.log(`[Seed] Updated template: ${name} v${version}${sourceChanged ? ' (source changed)' : ' (compiled)'}`);
        }
      }
      if ((existing.builtin_role ?? null) !== (meta.role ?? null)) scriptRepo.setBuiltinRole(existing.id, meta.role ?? null);
      continue;
    }

    // Compile the template source
    const compiled = await compileSource(source);

    // A non-builtin script holding this name + version (unique): the builtin gets a distinct version text
    const createVersion = scriptRepo.findByNameAndVersion(name, version) ? `${version}-builtin` : version;
    const created = scriptRepo.create({
      name,
      description: meta.description || '',
      version: createVersion,
      author: meta.author || 'BotLab',
      source,
      compiled: compiled || undefined,
      configSchema: meta.configSchema || {},
      isTemplate: true,
      // Builtin templates are seeded proven (spec §4.5) unless their meta says `trust: 'new'`: the 5a strategy
      // templates must prove themselves (paper first, then the ramp; R162)
      origin: 'builtin',
      ...(meta.trust ? { trust: meta.trust } : {}),
    });
    if (meta.role) scriptRepo.setBuiltinRole(created.id, meta.role);

    seeded++;
    console.log(`[Seed] Created template: ${name} v${version}${compiled ? ' (compiled)' : ' (compile failed)'}`);
  }

  return seeded;
}

/**
 * Get built-in template sources.
 * In production (packaged app), templates are bundled inline.
 * In development, we read from the filesystem.
 */
export function getBuiltinTemplates(templatesDir?: string): Array<{ filename: string; source: string }> {
  const templates: Array<{ filename: string; source: string }> = [];

  try {
    // Try to read from filesystem (development)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    // Templates live in <repo>/templates/. From source this file is packages/core/src/db/;
    // compiled it is dist-electron/packages/core/src/db/ (packaged: inside app.asar, same layout).
    const possiblePaths = [
      ...(templatesDir ? [templatesDir] : []),
      path.join(__dirname, '..', '..', '..', '..', 'templates'),
      path.join(__dirname, '..', '..', '..', '..', '..', 'templates'),
      path.join(process.cwd(), 'templates'),
    ];

    for (const dir of possiblePaths) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.ts'));
        for (const file of files) {
          const source = fs.readFileSync(path.join(dir, file), 'utf-8');
          templates.push({ filename: file, source });
        }
        if (templates.length > 0) break;
      }
    }
  } catch (err) {
    console.warn('[Seed] Could not read template files from filesystem:', err);
  }

  // Fallback: if no files found, use inline templates
  if (templates.length === 0) {
    console.log('[Seed] Using inline template definitions');
    templates.push(...getInlineTemplates());
  }

  return templates;
}

/**
 * Inline template sources as fallback for packaged apps.
 * In development, templates are read from templates/ instead.
 */
function getInlineTemplates(): Array<{ filename: string; source: string }> {
  // Inline fallbacks are intentionally minimal stubs.
  // The full templates live in templates/.
  return [];
}
