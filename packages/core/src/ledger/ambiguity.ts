/**
 * Rules hashing and the server-side ambiguity raise (spec §2.2 market_cache.rules_hash, §7.4).
 * Pure.
 */

import crypto from 'crypto';

/** A rules change in the last 7 days (or a UMA dispute) raises the score to at least 2. */
export const RULES_CHANGE_RAISE_MS = 7 * 86_400_000;
export const AUTO_RAISE_MIN_SCORE = 2;

/**
 * Normalised rules text: Unicode NFC, line endings and runs of whitespace collapsed, trimmed.
 * Case and punctuation are kept (they can change the meaning of a rule).
 */
export function normalizeRulesText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function rulesHash(text: string): string {
  return crypto.createHash('sha256').update(normalizeRulesText(text), 'utf8').digest('hex');
}

/** Why the server raises the score right now; null when it does not. */
export function autoRaiseReason(m: { rulesChangedAt: string | null; disputed: boolean }, now: number): string | null {
  if (m.disputed) return 'UMA dispute detected';
  if (m.rulesChangedAt) {
    const at = Date.parse(m.rulesChangedAt);
    if (!Number.isNaN(at) && now - at < RULES_CHANGE_RAISE_MS) return `rules changed at ${m.rulesChangedAt}`;
  }
  return null;
}

/**
 * Ambiguity the risk engine sees: the assessed score raised to ≥ 2 when `autoRaiseReason` applies.
 * Not assessed ⇒ null (unknown), which the engine rejects for buys.
 */
export function effectiveAmbiguity(
  m: { assessed: number | null; rulesChangedAt: string | null; disputed: boolean },
  now: number
): number | null {
  if (m.assessed === null || !Number.isInteger(m.assessed) || m.assessed < 0 || m.assessed > 3) return null;
  return autoRaiseReason(m, now) ? Math.max(m.assessed, AUTO_RAISE_MIN_SCORE) : m.assessed;
}
