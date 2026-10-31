import YAML from 'yaml';
import { z } from 'zod';

/**
 * categories.yaml schema (spec §3.3): maps Polymarket tags / question text to BotLab categories.
 *
 * Rules are evaluated in file order; the first rule that matches decides the category. A market
 * that matches no rule is `other`, which can never be in the mandate allow list (fail closed).
 *
 * A rule matches when
 *   - any of `tags` is among the market's tag slugs (strong match), or
 *   - `keywords` match the question / event title AND (`when_tags` is empty or any of `when_tags`
 *     is among the market's tag slugs),
 * and none of `exclude_keywords` matches the question / event title.
 *
 * Tags are compared as slugs ("Pop Culture" → "pop-culture"); keywords are case-insensitive
 * whole-word phrases.
 */

export const UNMAPPED_CATEGORY = 'other';

const slug = z
  .string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase slug (a-z, 0-9, -)');
const phrase = z.string().trim().min(1);

export const CategoryRuleSchema = z.strictObject({
  name: slug.refine((n) => n !== UNMAPPED_CATEGORY, { message: `"${UNMAPPED_CATEGORY}" is reserved for unmapped markets` }),
  tags: z.array(slug).default([]),
  when_tags: z.array(slug).default([]),
  keywords: z.array(phrase).default([]),
  exclude_keywords: z.array(phrase).default([]),
});

export type CategoryRule = z.infer<typeof CategoryRuleSchema>;

export const CategoriesSchema = z.strictObject({
  rules: z
    .array(CategoryRuleSchema)
    .default([])
    .superRefine((rules, ctx) => {
      rules.forEach((r, i) => {
        if (r.tags.length === 0 && r.keywords.length === 0) {
          ctx.addIssue({ code: 'custom', path: [i], message: `rule "${r.name}" has neither tags nor keywords (it can never match)` });
        }
      });
    }),
});

export type CategoriesConfig = z.infer<typeof CategoriesSchema>;

/**
 * Default mapping. VERIFY against live Gamma data (tag slugs below are from knowledge of the
 * Polymarket Gamma API, not checked against the current tag list; see PROGRESS Decision R50).
 * Kept in sync with config/categories.example.yaml.
 */
export const DEFAULT_CATEGORIES_YAML = `# BotLab category mapping (spec §3.3). Human-owned; hot-reloaded like the other config files.
#
# Maps Polymarket tags and question text to the categories used in mandate.yaml.
# Rules are checked top to bottom; the FIRST matching rule wins. A market matching no rule is
# "other", which can never be allowed (fail closed). Denied categories are listed first so a
# market that looks like sports/crypto/US elections is never mistaken for an allowed one.
# Denied / never-allowed rules match on a keyword ALONE (no when_tags): a false deny is acceptable,
# a false allow is not.
#
# A rule matches when any of \`tags\` is on the market (Gamma tag slugs, lowercase), or when one
# of \`keywords\` appears in the question/event title (case-insensitive, whole words) and the
# market has one of \`when_tags\` (or \`when_tags\` is empty). \`exclude_keywords\` veto the rule.
#
# VERIFY: tag slugs are from knowledge of the Gamma API and have not been checked against live
# data. Check a sample of markets per category before relying on this for live trading.
rules:
  - name: sports
    tags: [sports, nba, nfl, nhl, mlb, wnba, ncaa, cfb, cbb, soccer, football, epl, premier-league, champions-league, la-liga, serie-a, bundesliga, mls, tennis, golf, ufc, mma, boxing, f1, formula-1, cricket, esports, olympics, chess, nascar]
    keywords: [nba, nfl, nhl, mlb, super bowl, world cup, premier league, champions league, stanley cup, world series, grand slam, wimbledon, grand prix, playoffs, ufc, olympics]
  - name: crypto-price
    tags: [crypto, crypto-prices, bitcoin, ethereum, solana, xrp, dogecoin, memecoins, airdrops, stablecoins, defi, nft]
    keywords: [bitcoin, btc, ethereum, eth, solana, dogecoin, xrp, crypto, cryptocurrency, memecoin]
  - name: mentions
    tags: [mentions, mention-markets]
    keywords: [say, says, said, mention, mentions, tweet, tweets]
  - name: us-elections-headline
    # Any US political market lands here (denied) unless a human maps it elsewhere.
    # Unambiguously US-political words deny on their own (an economics market mentioning Trump is denied too).
    tags: [us-presidential-election, us-election, us-elections, presidential-election, midterms, us-midterms, us-politics, us-senate, us-house, congress, trump, trump-presidency, biden, scotus]
    keywords: [senate, senator, congress, congressional, house of representatives, electoral college, midterm, midterms, gop, republican, republicans, democrat, democrats, democratic party, trump, vance, harris, biden, newsom, desantis, white house, supreme court, scotus]
  - name: us-elections-headline
    # Generic US words (would also hit US CPI/jobs markets) deny only on political markets.
    when_tags: [politics, elections, us-government]
    keywords: [u.s., us, usa, united states, america, american, governor]
  - name: culture-entertainment
    tags: [pop-culture, culture, entertainment, movies, music, awards, oscars, grammys, emmys, celebrities, tv, television, box-office, youtube, tiktok, streaming, video-games, gaming]
  - name: fed-headline
    # Spec §3.3: economics excludes the headline Fed meeting. Not in any mandate list ⇒ never allowed.
    tags: [fed, fed-rates, fomc]
    keywords: [fed, fomc, federal reserve, powell, fed funds]
  - name: geopolitics
    tags: [geopolitics, middle-east, ukraine, russia, israel, iran, gaza, china, taiwan, north-korea, nato, war, ceasefire, foreign-policy]
  - name: weather-climate
    tags: [weather, climate, temperature, daily-temperature, global-temp, global-temperature, hurricanes, hurricane, snow, rain]
    keywords: [temperature, highest temperature, lowest temperature, hottest, coldest, rainfall, snowfall, hurricane, named storm, named storms, tropical storm, heat wave]
    exclude_keywords: [bitcoin, ethereum]
  - name: economics
    tags: [economy, economics, inflation, cpi, gdp, jobs-report, unemployment, interest-rates, central-banks, ecb, boe, boj, rba, boc, recession, macro, pce, nfp, payrolls]
    keywords: [cpi, inflation, gdp, unemployment rate, nonfarm payrolls, jobs report, interest rate, rate cut, rate hike, central bank, ecb, bank of england, bank of japan, recession, pce]
    when_tags: [finance, business, economy, world]
  - name: science-tech
    tags: [tech, technology, ai, science, space, spacex, nasa, openai, anthropic, google, apple, fda, biotech, big-tech]
  - name: politics-non-us
    tags: [world-elections, global-elections, uk-politics, uk-election, european-politics, eu, canada-politics, india-elections, brazil-elections, france-politics, germany-politics, japan-politics, australia-politics]
    # Keywords are deliberately non-US terms: a generic "election" market with no country tag stays "other".
    when_tags: [politics, elections, world]
    keywords: [prime minister, parliament, parliamentary, chancellor, bundestag, knesset, snap election, leadership election, taoiseach, dail, lok sabha, national assembly]
`;

let defaultParsed: CategoriesConfig | null = null;
/** The built-in mapping (used when no ConfigService is wired, e.g. tests). */
export function defaultCategories(): CategoriesConfig {
  defaultParsed ??= CategoriesSchema.parse(YAML.parse(DEFAULT_CATEGORIES_YAML));
  return defaultParsed;
}
