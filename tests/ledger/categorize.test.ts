import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import fs from 'fs';
import path from 'path';
import { categorize } from '../../packages/core/src/ledger/categorize';
import { CategoriesSchema, DEFAULT_CATEGORIES_YAML, defaultCategories, MandateSchema, parseConfigYaml } from '../../packages/core/src/config';

const cfg = defaultCategories();

describe('categorize (config/categories.yaml)', () => {
  const table: Array<[string, { question: string; tags: string[]; eventTitle?: string }, string]> = [
    // Allowed categories
    ['weather tag', { question: 'Highest temperature in London on Nov 2?', tags: ['Weather'] }, 'weather-climate'],
    ['weather by keyword only', { question: 'Will NYC see snowfall above 2 inches? Highest temperature above 60°F?', tags: [] }, 'weather-climate'],
    ['hurricane keyword', { question: 'How many named storms in the 2026 Atlantic season?', tags: ['climate-science'] }, 'weather-climate'],
    // Gamma's broad "Climate & Science" tag is also on IPO / AI markets (live data 2026-10-31): not weather
    ['climate-science tag alone', { question: 'SpaceX IPO closing market cap above $2.6T?', tags: ['climate-science'] }, 'other'],
    ['economics tag', { question: 'US CPI above 3.0% in October?', tags: ['economy', 'inflation'] }, 'economics'],
    ['ECB via keyword + context tag', { question: 'Will the ECB cut rates in December?', tags: ['finance'] }, 'economics'],
    ['non-US election via tag', { question: 'Will Labour win the most seats?', tags: ['politics', 'world-elections'] }, 'politics-non-us'],
    ['non-US politics via keyword', { question: 'Will the next German chancellor be from the CDU?', tags: ['politics'] }, 'politics-non-us'],
    // Later
    ['geopolitics', { question: 'Russia x Ukraine ceasefire in 2026?', tags: ['geopolitics', 'politics'] }, 'geopolitics'],
    ['science-tech', { question: 'Will OpenAI release GPT-6 by March?', tags: ['ai', 'tech'] }, 'science-tech'],
    // Denied
    ['sports', { question: 'Lakers vs Celtics', tags: ['sports', 'nba'] }, 'sports'],
    ['crypto price', { question: 'Bitcoin above $150k on Dec 31?', tags: ['crypto'] }, 'crypto-price'],
    ['crypto keyword in finance', { question: 'Will BTC hit $200k?', tags: ['finance'] }, 'crypto-price'],
    ['mentions', { question: 'Will Powell say "recession" this week?', tags: ['mentions', 'economy'] }, 'mentions'],
    ['culture', { question: 'Best Picture winner?', tags: ['Pop Culture', 'awards'] }, 'culture-entertainment'],
    ['US election headline (tag)', { question: 'Who will win the 2028 election?', tags: ['politics', 'us-presidential-election'] }, 'us-elections-headline'],
    ['US politics by keyword', { question: 'Will the Senate confirm the nominee?', tags: ['politics'] }, 'us-elections-headline'],
    ['US keyword beats non-US keyword (order)', { question: 'Will Trump meet the UK prime minister?', tags: ['politics'] }, 'us-elections-headline'],
    // Denied category listed before an allowed one wins when both match
    ['sports + weather tags ⇒ sports', { question: 'Will rain delay the match?', tags: ['weather', 'tennis'] }, 'sports'],
    ['Fed headline is not economics', { question: 'Fed decision in December?', tags: ['economy', 'fed'] }, 'fed-headline'],
    // Deny rules match on a keyword alone (no tag needed); a false deny is acceptable
    ['Fed decision, rate tags', { question: 'Fed decision in December?', tags: ['interest-rates', 'central-banks'] }, 'fed-headline'],
    ['Fed cut, economy tag', { question: 'Will the Fed cut rates by 50 bps?', tags: ['economy'] }, 'fed-headline'],
    ['Powell, no tags', { question: 'Powell out as chair in 2026?', tags: [] }, 'fed-headline'],
    ['FOMC, economics tag', { question: 'How many FOMC dissents?', tags: ['economics'] }, 'fed-headline'],
    ['Fed tag alone', { question: 'Rates unchanged in March?', tags: ['fed'] }, 'fed-headline'],
    ['ECB is still economics', { question: 'Will the ECB cut rates in December?', tags: ['interest-rates', 'central-banks'] }, 'economics'],
    ['bitcoin, economy tag', { question: 'Bitcoin above $100k?', tags: ['economy'] }, 'crypto-price'],
    ['crypto keyword, no tags', { question: 'Will ETH flip BTC?', tags: [] }, 'crypto-price'],
    ['Senate, economy tag', { question: 'Will the Senate pass the budget bill?', tags: ['economy'] }, 'us-elections-headline'],
    ['Trump tariffs on an economics market', { question: 'Will Trump tariffs push CPI above 3%?', tags: ['economy', 'inflation'] }, 'us-elections-headline'],
    ['generic "US" only on political markets', { question: 'US CPI above 3%?', tags: ['economy'] }, 'economics'],
    ['sports keyword, no tags', { question: 'Who wins the Super Bowl?', tags: [] }, 'sports'],
    ['mentions keyword, economy tag', { question: 'Will Lagarde say "tariff" at the press conference?', tags: ['economy'] }, 'mentions'],
    // Fail closed
    ['generic election, no country', { question: 'Who will win the presidential election?', tags: ['politics', 'elections'] }, 'other'],
    ['no tags, no keyword', { question: 'Will it happen?', tags: [] }, 'other'],
    ['unknown tag', { question: 'Something', tags: ['unknown-thing'] }, 'other'],
  ];

  it.each(table)('%s', (_name, input, expected) => {
    expect(categorize(input, cfg).category).toBe(expected);
  });

  it('keywords are whole words, case-insensitive; event title is searched', () => {
    expect(categorize({ question: 'Will the temperatures rise?', tags: [] }, cfg).category).toBe('other'); // "temperatures" ≠ "temperature"
    expect(categorize({ question: 'Over 80?', tags: [], eventTitle: 'HIGHEST TEMPERATURE in Dallas' }, cfg)).toMatchObject({
      category: 'weather-climate',
      matchedBy: { rule: 'weather-climate', via: 'keyword' },
    });
  });

  it('exclude_keywords veto a rule; unmapped ⇒ other with no match', () => {
    const custom = CategoriesSchema.parse({ rules: [{ name: 'weather-climate', keywords: ['temperature'], exclude_keywords: ['bitcoin'] }] });
    expect(categorize({ question: 'Bitcoin temperature index?', tags: [] }, custom)).toEqual({ category: 'other', matchedBy: null });
  });

  it('when_tags gate keywords', () => {
    const custom = CategoriesSchema.parse({ rules: [{ name: 'economics', keywords: ['cpi'], when_tags: ['economy'] }] });
    expect(categorize({ question: 'CPI above 3%?', tags: [] }, custom).category).toBe('other');
    expect(categorize({ question: 'CPI above 3%?', tags: ['Economy'] }, custom).category).toBe('economics');
  });

  it('schema: "other" is reserved and a rule must be able to match; mandate cannot allow "other"', () => {
    expect(CategoriesSchema.safeParse({ rules: [{ name: 'other', tags: ['x'] }] }).success).toBe(false);
    expect(CategoriesSchema.safeParse({ rules: [{ name: 'empty' }] }).success).toBe(false);
    expect(CategoriesSchema.safeParse({ rules: [{ name: 'Bad Name', tags: ['x'] }] }).success).toBe(false);
    expect(MandateSchema.safeParse({ categories: { allow: ['other'] } }).success).toBe(false);
  });

  it('example file equals the built-in default and parses', () => {
    const example = fs.readFileSync(path.join(__dirname, '../../config/categories.example.yaml'), 'utf8');
    expect(example).toBe(DEFAULT_CATEGORIES_YAML);
    expect(parseConfigYaml(CategoriesSchema, example, 'example')).toEqual(CategoriesSchema.parse(YAML.parse(DEFAULT_CATEGORIES_YAML)));
  });
});
