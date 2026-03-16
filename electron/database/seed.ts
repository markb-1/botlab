/**
 * Database seed logic for script templates.
 * On first launch (or when templates are missing), reads template .ts files
 * and inserts them into the scripts table with is_template = 1.
 * Templates are compiled with esbuild at seed time so they're ready to use.
 */

import type { ScriptRepository } from './repositories/ScriptRepository';

/**
 * Compile TypeScript source to JavaScript using esbuild.
 */
async function compileSource(source: string): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const esbuild = require('esbuild');
    const result = await esbuild.transform(source, {
      loader: 'ts',
      target: 'es2022',
      format: 'cjs',
    });
    return result.code;
  } catch (err) {
    console.warn('[Seed] Compilation failed:', err);
    return null;
  }
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
    const existing = scriptRepo.findByNameAndVersion(name, version);
    if (existing) {
      // Update source and recompile if template file has changed on disk
      const sourceChanged = existing.source.trim() !== source.trim();
      if (sourceChanged || !existing.compiled) {
        const compiled = await compileSource(source);
        if (compiled) {
          scriptRepo.update(existing.id, { source, compiled });
          console.log(`[Seed] Updated template: ${name} v${version}${sourceChanged ? ' (source changed)' : ' (compiled)'}`);
        }
      }
      continue;
    }

    // Compile the template source
    const compiled = await compileSource(source);

    scriptRepo.create({
      name,
      description: meta.description || '',
      version,
      author: meta.author || 'BotLab',
      source,
      compiled: compiled || undefined,
      configSchema: meta.configSchema || {},
      isTemplate: true,
    });

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
export function getBuiltinTemplates(): Array<{ filename: string; source: string }> {
  const templates: Array<{ filename: string; source: string }> = [];

  try {
    // Try to read from filesystem (development)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');

    // In development, templates are at electron/scripts/templates/
    // In packaged app, they'll be relative to __dirname
    const possiblePaths = [
      path.join(__dirname, '..', '..', 'electron', 'scripts', 'templates'),
      path.join(__dirname, '..', 'scripts', 'templates'),
      path.join(process.cwd(), 'electron', 'scripts', 'templates'),
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
 * In development, templates are read from electron/scripts/templates/ instead.
 */
function getInlineTemplates(): Array<{ filename: string; source: string }> {
  // Inline fallbacks are intentionally minimal stubs.
  // The full templates live in electron/scripts/templates/.
  return [];
}
