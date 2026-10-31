/**
 * Error text that leaves the server through read endpoints open to the agent / readonly scopes must not
 * carry secrets. Library errors (ethers, fetch, the Binance client) embed request URLs — an Alchemy RPC
 * URL holds the API key in its path, a signed Binance URL holds the key and signature in its query —
 * and request bodies with wallet addresses. These helpers keep only what an operator needs.
 */

/** Error whose message was written for users (no library text inside) */
export class PublicError extends Error {
  readonly publicMessage: string;
  constructor(message: string) {
    super(message);
    this.name = 'PublicError';
    this.publicMessage = message;
  }
}

/** URLs → scheme://host only; 20-byte hex addresses → shortened */
export function scrubPublicText(text: string): string {
  return text
    .replace(/\b(https?|wss?):\/\/([^/\s"'`)<>?#]+)[^\s"'`)<>]*/gi, '$1://$2/…')
    .replace(/\b0x[0-9a-fA-F]{40}\b(?![0-9a-fA-F])/g, (a) => `${a.slice(0, 6)}…${a.slice(-4)}`)
    .replace(/(requestBody|body|params)=("[^"]*"|\S+)/g, '$1=…');
}

/**
 * A short, generic message for a failed lookup: the PublicError's own message, else
 * `<what> failed (<library error code>)`. Log the full error yourself.
 */
export function publicLookupError(err: unknown, what: string): string {
  if (err instanceof PublicError) return err.publicMessage;
  const code = err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string' ? (err as { code: string }).code : null;
  return code && /^[A-Z0-9_]{2,40}$/.test(code) ? `${what} failed (${code})` : `${what} failed`;
}
