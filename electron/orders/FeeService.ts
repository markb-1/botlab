import path from 'path';
import { z } from 'zod';
import { parseConfigYaml, readOrCreate, resolveConfigDir } from '../config';

/**
 * FeeService — Polymarket fee table per fee category (spec §4.4).
 *
 * Rates come from `config/fees.yaml` (created with the defaults below when missing).
 * Fees are a fraction of notional for takers; makers pay `maker_rate` (0).
 *
 * VERIFY: the default rates are a starting point and must be checked against the
 * current Polymarket fee documentation before live trading. Polymarket's published
 * taker formula may depend on price (e.g. scaled by min(p, 1 − p)); we charge
 * `rate × notional`, which is the larger (conservative) amount for the same rate.
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
      sports: rate.default(0.03),
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
# Taker rate = fraction of notional charged to orders that cross the book; makers pay maker_rate.
# VERIFY these defaults against the current Polymarket fee docs before trading live.
taker_rates:
  crypto: 0.07
  sports: 0.03
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
 * TODO(chunk 2a): replace with market_cache.fee_category once the market cache exists.
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
  getRates(category: FeeCategory | null): { takerRate: number; makerRate: number } {
    const takerRate =
      category !== null ? this.config.taker_rates[category] : Math.max(...Object.values(this.config.taker_rates));
    return { takerRate, makerRate: this.config.maker_rate };
  }
}
