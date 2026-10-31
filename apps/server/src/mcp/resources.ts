/**
 * BotLab MCP resources (spec §7.3): the script SDK types and guide, templates, and the human-owned config
 * the agent must respect (read only; secrets are masked by ConfigService.getRedacted).
 */

import type { CoreServices } from '../../../../packages/core/src/core';
import type { AgentActor } from '../../../../packages/core/src/services/actors';
import { notFound } from '../../../../packages/core/src/services/errors';
import { SDK_DTS } from '../../../../packages/core/src/sdk/sdkDts.generated';
import { SCRIPT_GUIDE_MD } from '../../../../packages/core/src/sdk/guide';

export interface ResourceDef {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  read: (services: CoreServices, actor: AgentActor) => string;
}

function configPart<K extends 'limits' | 'mandate' | 'fees'>(services: CoreServices, actor: AgentActor, key: K): string {
  const { config, error } = services.config.get(actor);
  if (!config) return JSON.stringify({ error: error ?? 'config unavailable' }, null, 2);
  return JSON.stringify(config[key], null, 2);
}

export const RESOURCES: ResourceDef[] = [
  {
    uri: 'botlab://sdk/types.d.ts',
    name: 'botlab-sdk.d.ts',
    description: 'Type definitions of the bot script API (ctx: BotContext and sandbox globals). validate_script typechecks against this file.',
    mimeType: 'text/plain',
    read: () => SDK_DTS,
  },
  {
    uri: 'botlab://sdk/guide.md',
    name: 'BotLab guide',
    description:
      'How to operate BotLab and write bot scripts: run cycle, forecasts and ambiguity, agent bot rules, ctx API, risk engine, sandbox, untrusted data.',
    mimeType: 'text/markdown',
    read: () => SCRIPT_GUIDE_MD,
  },
  {
    uri: 'botlab://config/mandate',
    name: 'mandate.yaml',
    description: 'The human-owned mandate: categories (allow / later / deny), horizons, minimum liquidity, maximum ambiguity, strategies. Read only.',
    mimeType: 'application/json',
    read: (s, a) => configPart(s, a, 'mandate'),
  },
  {
    uri: 'botlab://config/limits',
    name: 'limits.yaml',
    description: 'The human-owned hard limits the risk engine enforces (exposure, per bot, per market, orders, ramp, agent budget and caps). Read only.',
    mimeType: 'application/json',
    read: (s, a) => configPart(s, a, 'limits'),
  },
  {
    uri: 'botlab://fees',
    name: 'fees.yaml',
    description:
      'Polymarket fee table by category (fallback when a market has no own fee schedule; get_market shows the rates that apply). Taker fee per share = rate × p × (1 − p); makers pay nothing.',
    mimeType: 'application/json',
    read: (s, a) => configPart(s, a, 'fees'),
  },
];

export const TEMPLATE_URI_PREFIX = 'botlab://templates/';

/** `botlab://templates/{id}`: one template's metadata and source */
export function readTemplate(services: CoreServices, id: string): string {
  const summary = services.scripts.templates().find((t) => t.id === id);
  if (!summary) throw notFound(`No template ${id}`);
  const script = services.scripts.get(id);
  return JSON.stringify({ ...summary, source: script.source }, null, 2);
}

export function listTemplateResources(services: CoreServices): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  return services.scripts.templates().map((t) => ({
    uri: `${TEMPLATE_URI_PREFIX}${t.id}`,
    name: `template: ${t.name}`,
    description: `${t.origin} template r${t.revision} (trust ${t.trust})${t.description ? ` — ${t.description.slice(0, 200)}` : ''}`,
    mimeType: 'application/json',
  }));
}
