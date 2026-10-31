/**
 * Market → BotLab category (spec §3.3) using the rules in config/categories.yaml.
 * Pure: no I/O. See `CategoriesSchema` for the matching rules.
 */

import { UNMAPPED_CATEGORY, type CategoriesConfig, type CategoryRule } from '../config/categoriesSchema';
import { slugify } from '../orders/FeeService';

export interface CategorizeInput {
  question: string;
  /** Gamma tag slugs or labels (market + event tags, Gamma `category`); slugified here */
  tags: string[];
  /** Parent event title (also searched for keywords) */
  eventTitle?: string | null;
}

export interface CategorizeResult {
  category: string;
  /** Name of the matched rule and why; null when unmapped */
  matchedBy: { rule: string; via: 'tag' | 'keyword'; term: string } | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const keywordCache = new Map<string, RegExp>();
/** Case-insensitive whole-word phrase (punctuation inside the phrase allowed, e.g. "u.s."). */
function keywordRe(kw: string): RegExp {
  let re = keywordCache.get(kw);
  if (!re) {
    const body = kw.trim().split(/\s+/).map(escapeRe).join('\\s+');
    re = new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, 'i');
    if (keywordCache.size > 2000) keywordCache.clear();
    keywordCache.set(kw, re);
  }
  return re;
}

function firstKeyword(text: string, keywords: readonly string[]): string | null {
  for (const kw of keywords) if (keywordRe(kw).test(text)) return kw;
  return null;
}

function matchRule(rule: CategoryRule, tags: Set<string>, text: string): CategorizeResult['matchedBy'] {
  if (rule.exclude_keywords.length > 0 && firstKeyword(text, rule.exclude_keywords)) return null;
  const tag = rule.tags.find((t) => tags.has(t));
  if (tag) return { rule: rule.name, via: 'tag', term: tag };
  if (rule.keywords.length === 0) return null;
  if (rule.when_tags.length > 0 && !rule.when_tags.some((t) => tags.has(t))) return null;
  const kw = firstKeyword(text, rule.keywords);
  return kw ? { rule: rule.name, via: 'keyword', term: kw } : null;
}

/**
 * Gamma tag slugs to search a category by (Mac test F6): every `tags` and `when_tags` entry of the rules that map to
 * it, strong tags first, de-duplicated. Empty for a category no rule names (e.g. `other`). Hits must still be
 * categorized (a weak `when_tags` tag such as `economy` also returns company markets).
 */
export function categorySearchTags(category: string, config: CategoriesConfig): string[] {
  const rules = config.rules.filter((r) => r.name === category);
  const out = new Set<string>();
  for (const r of rules) for (const t of r.tags) out.add(t);
  for (const r of rules) for (const t of r.when_tags) out.add(t);
  return [...out];
}

/** First matching rule wins; nothing matches ⇒ `other` (never allowed). */
export function categorize(market: CategorizeInput, config: CategoriesConfig): CategorizeResult {
  const tags = new Set(market.tags.map(slugify).filter((t) => t.length > 0));
  const text = [market.question, market.eventTitle ?? ''].join('\n');
  for (const rule of config.rules) {
    const m = matchRule(rule, tags, text);
    if (m) return { category: rule.name, matchedBy: m };
  }
  return { category: UNMAPPED_CATEGORY, matchedBy: null };
}
