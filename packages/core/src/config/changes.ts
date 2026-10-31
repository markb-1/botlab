/**
 * Config diffs and risk classification (spec §3: changes that raise risk take effect at once
 * but trigger a Telegram confirmation). Pure: no fs, no Electron.
 */

import type { LimitsConfig, MandateConfig } from './schema';
import type { ServerConfig } from './serverSchema';
import type { FeesConfig } from '../orders/FeeService';
import type { CategoriesConfig } from './categoriesSchema';

export interface AppConfig {
  limits: LimitsConfig;
  mandate: MandateConfig;
  fees: FeesConfig;
  server: ServerConfig;
  categories: CategoriesConfig;
}

export type ConfigFileName = keyof AppConfig;
export const CONFIG_FILE_NAMES: readonly ConfigFileName[] = ['limits', 'mandate', 'fees', 'server', 'categories'];

export type ChangeEffect = 'raises' | 'lowers' | 'neutral';

export interface ConfigChange {
  file: ConfigFileName;
  /** Dotted key path, e.g. `global.max_total_exposure_usd` */
  path: string;
  old: unknown;
  new: unknown;
}

export interface ClassifiedChange extends ConfigChange {
  effect: ChangeEffect;
}

/** Values hidden from audit rows, notifications and the renderer. */
export const REDACTED = '***';
const SECRET_PATHS = new Set(['server:notify.telegram.bot_token']);
export const isSecretPath = (file: string, path: string): boolean => SECRET_PATHS.has(`${file}:${path}`);

/** Remove known secrets and anything shaped like a Telegram bot token from text that may be logged, audited or sent. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join(REDACTED);
  out = out.replace(/\d{6,}:[A-Za-z0-9_-]{30,}/g, REDACTED);
  out = out.replace(/(bot_token\s*:\s*)(["']?)[^\s"'#]+\2/g, `$1${REDACTED}`);
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Leaf-level differences; arrays are leaves. */
function diffValue(file: ConfigFileName, path: string, a: unknown, b: unknown, out: ConfigChange[]): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffValue(file, path ? `${path}.${key}` : key, a[key], b[key], out);
    }
    return;
  }
  if (!deepEqual(a, b)) out.push({ file, path, old: a, new: b });
}

/** Changed key paths per file with old/new values. Either side may omit files. */
export function diffConfig(before: Partial<AppConfig> | null, after: Partial<AppConfig> | null): ConfigChange[] {
  const out: ConfigChange[] = [];
  for (const file of CONFIG_FILE_NAMES) {
    if (before?.[file] === undefined && after?.[file] === undefined) continue;
    diffValue(file, '', before?.[file] ?? {}, after?.[file] ?? {}, out);
  }
  return out;
}

/** Replace secret values so a change can be audited / sent / shown. */
export function redactChange<T extends ConfigChange>(c: T): T {
  if (!isSecretPath(c.file, c.path)) return c;
  const mask = (v: unknown) => (typeof v === 'string' && v.length > 0 ? REDACTED : v);
  return { ...c, old: mask(c.old), new: mask(c.new) };
}

// ─── Classification ──────────────────────────────────────────────────

type Rule =
  | 'up' // a higher number raises risk
  | 'down' // a lower number raises risk
  | 'enable' // false → true raises
  | 'disable' // true → false raises
  | 'set-grows' // adding entries raises (allow lists)
  | 'set-shrinks' // removing entries raises (deny lists)
  | 'range-widens' // [min, max] widening raises
  | 'neutral';

const LIMIT_RULES: Record<string, Rule> = {
  'live_trading.enabled': 'enable',
  'global.max_total_exposure_usd': 'up',
  'global.max_total_exposure_pct': 'up',
  'global.max_long_horizon_pct': 'up',
  'global.daily_loss_limit_usd': 'up',
  'global.max_open_orders': 'up',
  'per_bot_defaults.max_order_usd': 'up',
  'per_bot_defaults.allocation_usd': 'up',
  'per_bot_defaults.daily_loss_limit_usd': 'up',
  'per_bot_defaults.max_orders_per_hour': 'up',
  'per_bot_defaults.min_hold_minutes': 'down',
  'per_market.max_exposure_usd': 'up',
  'per_market.min_liquidity_usd': 'down',
  'per_market.min_top_of_book_usd': 'down',
  'per_market.no_trade_before_end_minutes': 'down',
  'per_market.max_slippage': 'up',
  'per_market.max_spread': 'up',
  'orders.default_type': 'neutral',
  'orders.allow_marketable': 'enable',
  'orders.resting_order_ttl_minutes': 'up',
  'ramp.probation_allocation_usd': 'up',
  'ramp.probation_min_fills': 'down',
  'ramp.probation_min_days': 'down',
  'ramp.probation_max_drawdown_pct': 'up',
  'ramp.new_template_paper_days': 'down',
  'ramp.new_template_probation_allocation_usd': 'up',
  'agent.monthly_llm_budget_usd': 'up',
  'agent.max_bots_created_per_day': 'up',
  'agent.max_active_bots': 'up',
  'approvals.new_template_live': 'disable',
  'binance.enabled': 'enable',
  'binance.max_order_usd': 'up',
  'binance.allocation_usd': 'up',
  'reconcile.max_unexplained_usd': 'up',
  'server.start_halted_after_crash': 'disable',
  'server.script_fetch_allowlist': 'set-grows',
};

const MANDATE_RULES: Record<string, Rule> = {
  budget_usd: 'up',
  'categories.allow': 'set-grows',
  'categories.later': 'neutral',
  'categories.deny': 'set-shrinks',
  'markets.resolves_within_days': 'range-widens',
  'markets.long_horizon_days': 'range-widens',
  'markets.min_liquidity_usd': 'down',
  'markets.max_ambiguity_score': 'up',
  'strategies.allow': 'set-grows',
  'strategies.allow_custom_templates': 'enable',
  notes: 'neutral',
};

const effectOf = (rule: Rule, o: unknown, n: unknown): ChangeEffect => {
  const flip = (up: boolean): ChangeEffect => (up ? 'raises' : 'lowers');
  switch (rule) {
    case 'neutral':
      return 'neutral';
    case 'up':
    case 'down': {
      if (typeof o !== 'number' || typeof n !== 'number') return 'raises'; // cannot tell: assume the worst
      if (o === n) return 'neutral';
      return flip(rule === 'up' ? n > o : n < o);
    }
    case 'enable':
    case 'disable': {
      if (typeof o !== 'boolean' || typeof n !== 'boolean') return 'raises';
      if (o === n) return 'neutral';
      return flip(rule === 'enable' ? n : !n);
    }
    case 'set-grows':
    case 'set-shrinks': {
      if (!Array.isArray(o) || !Array.isArray(n)) return 'raises';
      const os = new Set(o.map(String));
      const ns = new Set(n.map(String));
      const added = [...ns].some((x) => !os.has(x));
      const removed = [...os].some((x) => !ns.has(x));
      const growsRisk = rule === 'set-grows' ? added : removed;
      const lowersRisk = rule === 'set-grows' ? removed : added;
      return growsRisk ? 'raises' : lowersRisk ? 'lowers' : 'neutral';
    }
    case 'range-widens': {
      if (!Array.isArray(o) || !Array.isArray(n) || o.length !== 2 || n.length !== 2) return 'raises';
      const [oMin, oMax, nMin, nMax] = [o[0], o[1], n[0], n[1]] as number[];
      const widens = nMin < oMin || nMax > oMax;
      const narrows = nMin > oMin || nMax < oMax;
      return widens ? 'raises' : narrows ? 'lowers' : 'neutral';
    }
  }
};

/** Risk effect of one changed key. Unknown keys in the risk files count as raising (fail loud). */
export function classifyKey(file: ConfigFileName, path: string, o: unknown, n: unknown): ChangeEffect {
  switch (file) {
    case 'limits': {
      const rule = LIMIT_RULES[path];
      return rule ? effectOf(rule, o, n) : 'raises';
    }
    case 'mandate': {
      const rule = MANDATE_RULES[path];
      return rule ? effectOf(rule, o, n) : 'raises';
    }
    case 'fees': {
      // A lower assumed fee makes the edge check and expected-fee estimate less conservative
      if (typeof o !== 'number' || typeof n !== 'number') return 'raises';
      return o === n ? 'neutral' : n < o ? 'raises' : 'lowers';
    }
    case 'server':
      // Notifications are a safety net: turning them off or pointing them elsewhere is a loosening
      if (path === 'notify.telegram.enabled') return o === true && n === false ? 'raises' : 'neutral';
      if (path === 'notify.telegram.chat_id' || path === 'notify.telegram.bot_token') return 'raises';
      return 'neutral';
    case 'categories':
      // Any remap can move markets into an allowed category; cannot tell cheaply, assume it raises
      return 'raises';
  }
}

/** Classify every changed key between two configs (either side may omit files). */
export function classifyChange(before: Partial<AppConfig> | null, after: Partial<AppConfig> | null): ClassifiedChange[] {
  return diffConfig(before, after).map((c) => ({ ...c, effect: classifyKey(c.file, c.path, c.old, c.new) }));
}

export function overallEffect(changes: readonly ClassifiedChange[]): ChangeEffect {
  if (changes.some((c) => c.effect === 'raises')) return 'raises';
  if (changes.some((c) => c.effect === 'lowers')) return 'lowers';
  return 'neutral';
}

const fmt = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? 'undefined');

/** "limits.global.max_total_exposure_usd: 300 → 500" */
export function describeChange(c: ConfigChange): string {
  const r = redactChange(c);
  return `${r.file}.${r.path}: ${fmt(r.old)} → ${fmt(r.new)}`;
}
