/** GTD expiry rules of the Polymarket CLOB (no order functions here: safe to import anywhere). */

/**
 * Polymarket applies a one-minute security threshold to GTD expirations: an order
 * meant to live N seconds must be sent with expiration = now + 60 + N (CLOB docs,
 * "GTD orders"; checked 2026-10-31, docs/TEST-REPORT-MAC.md).
 */
export const GTD_SECURITY_BUFFER_SECONDS = 60;
/**
 * The CLOB also refuses a GTD expiration less than 3 minutes in the future. BotLab requires the
 * order's own lifetime (ttlMinutes) to be at least that, on top of the 60 s buffer (PROGRESS R126).
 */
export const GTD_MIN_LIFETIME_SECONDS = 180;
export const GTD_MIN_TTL_MINUTES = GTD_MIN_LIFETIME_SECONDS / 60;
