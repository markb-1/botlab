import fs from 'fs';
import path from 'path';

/** The versioned system prompt next to the sources (`apps/agent/prompts/system.md`), from src or dist */
export function loadSystemPrompt(): { text: string; version: string } {
  const candidates = [
    path.join(__dirname, '..', 'prompts', 'system.md'),
    path.join(__dirname, '..', '..', '..', '..', 'apps', 'agent', 'prompts', 'system.md'),
  ];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error(`system prompt not found (looked in ${candidates.join(', ')})`);
  const raw = fs.readFileSync(file, 'utf8');
  const version = /botlab-agent-system-prompt (v\d+)/.exec(raw)?.[1] ?? 'unversioned';
  // The leading HTML comment is for maintainers, not the model
  return { text: raw.replace(/^<!--[\s\S]*?-->\s*/, ''), version };
}
