import { describe, it, expect } from 'vitest';
import { LimitsSchema, MandateSchema, ServerSchema, classifyChange, overallEffect, redactChange, diffConfig, type AppConfig } from '../../packages/core/src/config';
import { FeesSchema } from '../../packages/core/src/orders/FeeService';

const base = (): AppConfig => ({
  limits: LimitsSchema.parse({}),
  mandate: MandateSchema.parse({}),
  fees: FeesSchema.parse({}),
  server: ServerSchema.parse({}),
});

function edit(fn: (c: AppConfig) => void): AppConfig {
  const c = structuredClone(base());
  fn(c);
  return c;
}

describe('classifyChange agent.enabled', () => {
  it('true -> false lowers', () => {
    const on = edit((c) => (c.server.agent.enabled = true));
    const res = classifyChange(on, base());
    expect(res).toHaveLength(1);
    expect(res[0].effect).toBe('lowers');
  });
});

describe('classifyChange', () => {
  const table: Array<[string, (c: AppConfig) => void, 'raises' | 'lowers' | 'neutral']> = [
    ['enabling the agent', (c) => (c.server.agent.enabled = true), 'raises'],
    ['switching the agent model', (c) => (c.server.agent.model = 'claude-opus-5-5'), 'raises'],
    ['adding an agent cycle', (c) => (c.server.agent.schedule.cycles = [...c.server.agent.schedule.cycles, '21:30']), 'raises'],
    ['removing an agent cycle', (c) => (c.server.agent.schedule.cycles = ['11:30']), 'lowers'],
    ['moving the agent review time', (c) => (c.server.agent.schedule.review = '08:00'), 'neutral'],
    ['raising the agent monthly budget', (c) => (c.limits.agent.monthly_llm_budget_usd += 5), 'raises'],
    ['lowering agent max tool calls per run', (c) => (c.limits.agent.max_tool_calls_per_run -= 1), 'lowers'],
    ['raising agent max active bots', (c) => (c.limits.agent.max_active_bots += 1), 'raises'],
    ['raising total exposure', (c) => (c.limits.global.max_total_exposure_usd = 400), 'raises'],
    ['lowering total exposure', (c) => (c.limits.global.max_total_exposure_usd = 200), 'lowers'],
    ['raising max order', (c) => (c.limits.per_bot_defaults.max_order_usd = 30), 'raises'],
    ['raising daily loss limit', (c) => (c.limits.global.daily_loss_limit_usd = 150), 'raises'],
    ['lowering min hold time', (c) => (c.limits.per_bot_defaults.min_hold_minutes = 5), 'raises'],
    ['raising min hold time', (c) => (c.limits.per_bot_defaults.min_hold_minutes = 60), 'lowers'],
    ['lowering min liquidity', (c) => (c.limits.per_market.min_liquidity_usd = 1000), 'raises'],
    ['widening max spread', (c) => (c.limits.per_market.max_spread = 0.1), 'raises'],
    ['allowing marketable orders', (c) => ((c.limits.orders.allow_marketable = false), (c.limits.orders.allow_marketable = true)), 'neutral'],
    ['disabling start_halted_after_crash', (c) => (c.limits.server.start_halted_after_crash = false), 'raises'],
    ['enabling start_halted_after_crash', () => undefined, 'neutral'],
    ['enabling binance', (c) => (c.limits.binance.enabled = true), 'neutral'], // default is already true
    ['approvals.new_template_live true → false', (c) => (c.limits.approvals.new_template_live = false), 'neutral'],
    ['raising binance allocation', (c) => (c.limits.binance.allocation_usd = 500), 'raises'],
    ['adding a fetch host', (c) => c.limits.server.script_fetch_allowlist.push('example.com'), 'raises'],
    ['removing a fetch host', (c) => c.limits.server.script_fetch_allowlist.pop(), 'lowers'],
    ['raising the mandate budget', (c) => (c.mandate.budget_usd = 350), 'raises'],
    ['adding an allowed category', (c) => c.mandate.categories.allow.push('science'), 'raises'],
    ['removing an allowed category', (c) => c.mandate.categories.allow.pop(), 'lowers'],
    ['removing a denied category', (c) => c.mandate.categories.deny.pop(), 'raises'],
    ['adding a denied category', (c) => c.mandate.categories.deny.push('weather-extreme'), 'lowers'],
    ['moving a later category (no list gains an allow)', (c) => c.mandate.categories.later.push('x'), 'neutral'],
    ['adding a strategy', (c) => c.mandate.strategies.allow.push('copy'), 'raises'],
    ['widening the horizon', (c) => (c.mandate.markets.resolves_within_days = [0, 30]), 'neutral'],
    ['narrowing the horizon', (c) => (c.mandate.markets.resolves_within_days = [0, 14]), 'lowers'],
    ['widening the horizon lower bound', (c) => (c.mandate.markets.long_horizon_days = [30, 90]), 'neutral'],
    ['raising max ambiguity', (c) => (c.mandate.markets.max_ambiguity_score = 2), 'raises'],
    ['notes only', (c) => (c.mandate.notes = 'hello'), 'neutral'],
    ['lower assumed fee', (c) => (c.fees.taker_rates.weather = 0.01), 'raises'],
    ['higher assumed fee', (c) => (c.fees.taker_rates.weather = 0.09), 'lowers'],
    ['server.yaml timezone and enabling Telegram', (c) => ((c.server.timezone = 'UTC'), (c.server.notify.telegram.enabled = true)), 'neutral'],
    ['changing the Telegram chat id', (c) => (c.server.notify.telegram.chat_id = '9'), 'raises'],
    ['changing the Telegram token', (c) => (c.server.notify.telegram.bot_token = 'x'), 'raises'],
  ];

  it.each(table)('%s', (_name, fn, expected) => {
    const changes = classifyChange(base(), edit(fn));
    expect(overallEffect(changes)).toBe(expected);
  });

  it('widening a range raises (explicit bounds)', () => {
    const before = edit((c) => (c.mandate.markets.resolves_within_days = [1, 10]));
    const wider = edit((c) => (c.mandate.markets.resolves_within_days = [0, 10]));
    const narrower = edit((c) => (c.mandate.markets.resolves_within_days = [2, 10]));
    expect(overallEffect(classifyChange(before, wider))).toBe('raises');
    expect(overallEffect(classifyChange(before, narrower))).toBe('lowers');
  });

  it('a mixed edit raises if any key raises; each key is classified on its own', () => {
    const after = edit((c) => {
      c.limits.global.max_total_exposure_usd = 200;
      c.limits.per_bot_defaults.max_order_usd = 30;
    });
    const changes = classifyChange(base(), after);
    expect(changes.map((c) => [c.path, c.effect])).toEqual([
      ['global.max_total_exposure_usd', 'lowers'],
      ['per_bot_defaults.max_order_usd', 'raises'],
    ]);
    expect(overallEffect(changes)).toBe('raises');
  });

  it('reports old and new values and no change for identical configs', () => {
    expect(diffConfig(base(), base())).toEqual([]);
    const [c] = classifyChange(base(), edit((x) => (x.limits.global.max_open_orders = 80)));
    expect(c).toMatchObject({ file: 'limits', path: 'global.max_open_orders', old: 50, new: 80, effect: 'raises' });
  });

  it('disabling Telegram (from enabled) raises', () => {
    const on = edit((c) => (c.server.notify.telegram.enabled = true));
    expect(overallEffect(classifyChange(on, base()))).toBe('raises');
  });

  it('redacts the Telegram token', () => {
    const [c] = classifyChange(base(), edit((x) => (x.server.notify.telegram.bot_token = '123:secret')));
    expect(redactChange(c).new).toBe('***');
    expect(JSON.stringify(redactChange(c))).not.toContain('secret');
  });
});
