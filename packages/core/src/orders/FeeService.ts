import path from 'path';
import { z } from 'zod';
import { parseConfigYaml, readOrCreate, resolveConfigDir } from '../config';
import { ratesFromSchedule, type FeeRates, type MarketFeeSchedule } from './feeModel';

/**
 * FeeService — Polymarket fee rates (spec §4.4, PROGRESS R13 / R125).
 *
 * A market's own Gamma fee schedule (`feeModel.ts`, stored in market_cache) always wins. Only when a
 * market carries none is the category table in `config/fees.yaml` used (created with the defaults
 * below, which follow the Polymarket fee docs table, checked 2026-10-31). Taker fee =
 * shares × rate × p × (1 − p), in USDC on top; makers pay `maker_rate` (0).
 */

export const FEE_CATEGORIES = [
  'crypto',
  'sports',
  'finance',
  'politics',
  'tech',
  'mentions',
  'economics',
  'culture',
  'weather',
  'other',
  'geopolitics',
] as const;
export type FeeCategory = (typeof FEE_CATEGORIES)[number];

export const FEES_FILE = 'fees.yaml';

const rate = z.number().finite().min(0).max(1);

export const FeesSchema = z.strictObject({
  // Defaults must be verified against Polymarket docs (see header comment)
  taker_rates: z
    .strictObject({
      crypto: rate.default(0.07),
      sports: rate.default(0.05),
      finance: rate.default(0.04),
      politics: rate.default(0.04),
      tech: rate.default(0.04),
      mentions: rate.default(0.04),
      economics: rate.default(0.05),
      culture: rate.default(0.05),
      weather: rate.default(0.05),
      other: rate.default(0.05),
      geopolitics: rate.default(0),
    })
    .prefault({}),
  maker_rate: rate.default(0),
});

export type FeesConfig = z.infer<typeof FeesSchema>;

export const DEFAULT_FEES_YAML = `# Polymarket fee table (spec §4.4). Human-owned.
# Used only for markets whose Gamma data carries no fee schedule (a market's own feeSchedule wins).
# Taker fee (USDC, on top) = shares × rate × p × (1 − p); makers pay maker_rate.
# Defaults follow the Polymarket fee docs table (docs.polymarket.com/trading/fees, checked 2026-10-31).
taker_rates:
  crypto: 0.07
  sports: 0.05
  finance: 0.04
  politics: 0.04
  tech: 0.04
  mentions: 0.04
  economics: 0.05
  culture: 0.05
  weather: 0.05
  other: 0.05
  geopolitics: 0
maker_rate: 0
`;

export function loadFees(configDir: string = resolveConfigDir()): FeesConfig {
  const file = path.join(configDir, FEES_FILE);
  return parseConfigYaml(FeesSchema, readOrCreate(file, DEFAULT_FEES_YAML), file);
}

/**
 * Keyword → fee category, matched against the market's Gamma category and tag slugs.
 * Earlier entries win (geopolitics before politics, mentions before anything else).
 * Also stored as market_cache.fee_category (MarketCacheService) for reporting; orders compute it from
 * the same Gamma labels.
 */
const FEE_CATEGORY_KEYWORDS: Array<[FeeCategory, string[]]> = [
  ['mentions', ['mentions']],
  ['geopolitics', ['geopolitics']],
  ['crypto', ['crypto', 'bitcoin', 'ethereum', 'solana', 'xrp']],
  ['sports', ['sports', 'nba', 'nfl', 'nhl', 'mlb', 'soccer', 'football', 'tennis', 'golf', 'ufc', 'f1', 'cricket', 'esports', 'boxing']],
  ['weather', ['weather', 'climate', 'temperature', 'hurricane']],
  ['economics', ['economy', 'economics', 'fed', 'inflation', 'cpi', 'gdp', 'jobs', 'interest-rates']],
  ['finance', ['finance', 'stocks', 'business', 'ipo', 'earnings', 'commodities']],
  ['tech', ['tech', 'technology', 'ai', 'science', 'space']],
  ['culture', ['culture', 'pop-culture', 'entertainment', 'movies', 'music', 'celebrities', 'awards']],
  ['politics', ['politics', 'elections', 'election']],
];

/** Lowercase slug ("Pop Culture" → "pop-culture"). */
export function slugify(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class FeeService {
  private config: FeesConfig;

  constructor(config: FeesConfig = FeesSchema.parse({})) {
    this.config = config;
  }

  /** Replace the fee table (hot reload). */
  setConfig(config: FeesConfig): void {
    this.config = config;
  }

  /** Fee category for a market given its Gamma category/tag labels; null when nothing matches. */
  feeCategoryFor(labels: string[]): FeeCategory | null {
    const slugs = labels.map(slugify).filter((s) => s.length > 0);
    for (const [category, keywords] of FEE_CATEGORY_KEYWORDS) {
      if (slugs.some((s) => keywords.includes(s))) return category;
    }
    return null;
  }

  /**
   * Rates for a fee category. Unknown category ⇒ the highest configured taker rate,
   * so edge and expected-fee calculations never understate fees.
   */
  getRates(category: FeeCategory | null): FeeRates {
    const takerRate =
      category !== null ? this.config.taker_rates[category] : Math.max(...Object.values(this.config.taker_rates));
    return { takerRate, makerRate: this.config.maker_rate, formula: 'price', source: category !== null ? 'category' : 'unknown' };
  }

  /** Rates for a market: its own Gamma schedule when present, else the category table. */
  ratesFor(schedule: MarketFeeSchedule | null | undefined, category: FeeCategory | null): FeeRates {
    return schedule ? ratesFromSchedule(schedule) : this.getRates(category);
  }

  /** Category from free-form labels (null when unmapped / not a fee category). */
  static asFeeCategory(cat: string | null | undefined): FeeCategory | null {
    return cat && (FEE_CATEGORIES as readonly string[]).includes(cat) ? (cat as FeeCategory) : null;
  }
}
