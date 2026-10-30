import { z } from 'zod';

/**
 * Zod schemas for the human-owned config files (spec §3).
 *
 * Every field has a default equal to the value in the spec, so `LimitsSchema.parse({})`
 * yields the default config. Objects are strict: an unknown key (usually a typo in a
 * limit name) is an error rather than being silently ignored.
 *
 * No Electron imports here — this module moves to packages/core later.
 */

/** Nothing settling beyond this many days is ever traded (spec §3.4). */
export const MAX_HORIZON_DAYS = 90;

const usd = z.number().finite().nonnegative();
const fraction = z.number().finite().min(0).max(1);
const count = z.number().int().nonnegative();
const dayRange = z
  .tuple([z.number().nonnegative(), z.number().nonnegative()])
  .refine(([min, max]) => min <= max, { message: 'range min must be <= max' });

// ─── limits.yaml (§3.1) ──────────────────────────────────────────────

export const LimitsSchema = z.strictObject({
  global: z
    .strictObject({
      max_total_exposure_usd: usd.default(300),
      max_total_exposure_pct: fraction.default(0.6),
      max_long_horizon_pct: fraction.default(0.25),
      daily_loss_limit_usd: usd.default(100),
      max_open_orders: count.default(50),
    })
    .prefault({}),
  per_bot_defaults: z
    .strictObject({
      max_order_usd: usd.default(25),
      allocation_usd: usd.default(100),
      daily_loss_limit_usd: usd.default(50),
      max_orders_per_hour: count.default(20),
      min_hold_minutes: z.number().nonnegative().default(30),
    })
    .prefault({}),
  per_market: z
    .strictObject({
      max_exposure_usd: usd.default(50),
      min_liquidity_usd: usd.default(5000),
      min_top_of_book_usd: usd.default(200),
      no_trade_before_end_minutes: z.number().nonnegative().default(60),
      max_slippage: fraction.default(0.02),
      max_spread: fraction.default(0.06),
    })
    .prefault({}),
  orders: z
    .strictObject({
      default_type: z.enum(['limit', 'market']).default('limit'),
      allow_marketable: z.boolean().default(true),
      resting_order_ttl_minutes: z.number().positive().default(240),
    })
    .prefault({}),
  ramp: z
    .strictObject({
      probation_allocation_usd: usd.default(20),
      probation_min_fills: count.default(20),
      probation_min_days: z.number().nonnegative().default(7),
      probation_max_drawdown_pct: fraction.default(0.25),
      new_template_paper_days: z.number().nonnegative().default(7),
      new_template_probation_allocation_usd: usd.default(10),
    })
    .prefault({}),
  agent: z
    .strictObject({
      monthly_llm_budget_usd: usd.default(50),
      max_bots_created_per_day: count.default(10),
      max_active_bots: count.default(25),
    })
    .prefault({}),
  approvals: z
    .strictObject({
      new_template_live: z.boolean().default(false),
    })
    .prefault({}),
  binance: z
    .strictObject({
      enabled: z.boolean().default(true),
      max_order_usd: usd.default(25),
      allocation_usd: usd.default(100),
    })
    .prefault({}),
});

export type LimitsConfig = z.infer<typeof LimitsSchema>;

// ─── mandate.yaml (§3.2) ─────────────────────────────────────────────

const categoryList = z.array(z.string().min(1));

export const MandateSchema = z.strictObject({
  budget_usd: usd.default(300),
  categories: z
    .strictObject({
      allow: categoryList.default(['weather-climate', 'economics', 'politics-non-us']),
      later: categoryList.default(['geopolitics', 'science-tech']),
      deny: categoryList.default([
        'sports',
        'crypto-price',
        'mentions',
        'culture-entertainment',
        'us-elections-headline',
      ]),
    })
    .prefault({})
    .superRefine((cats, ctx) => {
      // A category may appear in only one list
      const seen = new Map<string, string>();
      for (const list of ['allow', 'later', 'deny'] as const) {
        for (const c of cats[list]) {
          const prev = seen.get(c);
          if (prev && prev !== list) {
            ctx.addIssue({ code: 'custom', path: [list], message: `category "${c}" is in both ${prev} and ${list}` });
          }
          seen.set(c, list);
        }
      }
    }),
  markets: z
    .strictObject({
      resolves_within_days: dayRange.default([0, 30]),
      long_horizon_days: dayRange.default([30, 90]),
      min_liquidity_usd: usd.default(5000),
      max_ambiguity_score: z.number().int().min(0).max(3).default(1),
    })
    .prefault({})
    .superRefine((m, ctx) => {
      for (const key of ['resolves_within_days', 'long_horizon_days'] as const) {
        if (m[key][1] > MAX_HORIZON_DAYS) {
          ctx.addIssue({ code: 'custom', path: [key], message: `must not extend beyond ${MAX_HORIZON_DAYS} days` });
        }
      }
      if (m.long_horizon_days[0] < m.resolves_within_days[1]) {
        ctx.addIssue({
          code: 'custom',
          path: ['long_horizon_days'],
          message: 'long horizon must start at or after the end of resolves_within_days',
        });
      }
    }),
  strategies: z
    .strictObject({
      allow: z.array(z.string().min(1)).default(['forecast', 'consistency', 'resolution_rule']),
      allow_custom_templates: z.boolean().default(true),
    })
    .prefault({}),
  notes: z.string().default(''),
});

export type MandateConfig = z.infer<typeof MandateSchema>;

export interface BotLabConfig {
  limits: LimitsConfig;
  mandate: MandateConfig;
}

/**
 * Validation rules that span fields or files (spec §3).
 * Returns a list of human-readable problems; empty means valid.
 */
export function validateCrossFile(limits: LimitsConfig, mandate: MandateConfig): string[] {
  const errors: string[] = [];
  const check = (ok: boolean, message: string) => {
    if (!ok) errors.push(message);
  };

  check(
    mandate.budget_usd <= limits.global.max_total_exposure_usd,
    `mandate.budget_usd (${mandate.budget_usd}) must be <= limits.global.max_total_exposure_usd (${limits.global.max_total_exposure_usd})`
  );
  check(
    limits.per_bot_defaults.max_order_usd <= limits.per_bot_defaults.allocation_usd,
    `limits.per_bot_defaults.max_order_usd (${limits.per_bot_defaults.max_order_usd}) must be <= per_bot_defaults.allocation_usd (${limits.per_bot_defaults.allocation_usd})`
  );
  check(
    limits.ramp.probation_allocation_usd <= limits.per_bot_defaults.allocation_usd,
    `limits.ramp.probation_allocation_usd (${limits.ramp.probation_allocation_usd}) must be <= per_bot_defaults.allocation_usd (${limits.per_bot_defaults.allocation_usd})`
  );
  check(
    limits.ramp.new_template_probation_allocation_usd <= limits.ramp.probation_allocation_usd,
    `limits.ramp.new_template_probation_allocation_usd (${limits.ramp.new_template_probation_allocation_usd}) must be <= ramp.probation_allocation_usd (${limits.ramp.probation_allocation_usd})`
  );
  check(
    limits.binance.max_order_usd <= limits.binance.allocation_usd,
    `limits.binance.max_order_usd (${limits.binance.max_order_usd}) must be <= binance.allocation_usd (${limits.binance.allocation_usd})`
  );

  return errors;
}
