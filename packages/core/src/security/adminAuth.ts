/**
 * Admin login, sessions and API tokens (spec §8.2). Storage only; the HTTP layer (apps/server) sets
 * cookies, checks scopes and derives actors.
 *
 * - Admin password: scrypt (N=2^14, r=8, p=1, 16-byte salt), stored as `scrypt$N$r$p$salt$hash` (base64)
 *   in `settings.admin_password_hash`. Not used for encryption (the master key is, §8.3).
 * - Sessions: a random 32-byte token in an httpOnly cookie; the DB keeps only its SHA-256. Idle
 *   timeout 7 days, absolute 30 days. `auth_at` is the last password check (login or re-auth); human-only
 *   admin actions require it to be < 15 minutes old.
 * - API tokens: `blt_<base64url>` with scope `agent` (MCP, Phase 4) or `readonly`; only the SHA-256 is stored.
 */

import crypto from 'crypto';
import type Database from 'better-sqlite3';

export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
export const SESSION_MAX_MS = 30 * 24 * 3600_000;
export const RECENT_AUTH_MS = 15 * 60_000;
export const MIN_PASSWORD_LENGTH = 8;

const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keyLen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPasswordHash(password: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof password !== 'string' || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || expected.length === 0) return false;
  const actual = await scrypt(password, salt, N, r, p, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export type TokenScope = 'agent' | 'readonly';

export interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  auth_at: string;
  expires_at: string;
  user_agent: string | null;
}

export interface ApiTokenRow {
  id: string;
  name: string;
  scope: TokenScope;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export type ApiTokenView = Omit<ApiTokenRow, 'token_hash'>;

export class AdminAuthStore {
  constructor(
    private db: Database.Database,
    private now: () => number = () => Date.now()
  ) {}

  private iso(ms = this.now()): string {
    return new Date(ms).toISOString();
  }

  // ── Admin password ────────────────────────────────────────────────

  hasAdminPassword(): boolean {
    const row = this.db.prepare("SELECT admin_password_hash FROM settings WHERE id = 'global'").get() as { admin_password_hash: string | null } | undefined;
    return !!row?.admin_password_hash;
  }

  async setAdminPassword(password: string): Promise<void> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const hash = await hashPassword(password);
    this.db.prepare("UPDATE settings SET admin_password_hash = ?, updated_at = datetime('now') WHERE id = 'global'").run(hash);
  }

  /**
   * First-run setup: sets the password only if none is set (atomic check-and-set), so two concurrent
   * setup requests cannot both win.
   */
  async setInitialAdminPassword(password: string): Promise<boolean> {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    const hash = await hashPassword(password);
    const r = this.db.prepare("UPDATE settings SET admin_password_hash = ?, updated_at = datetime('now') WHERE id = 'global' AND admin_password_hash IS NULL").run(hash);
    return r.changes === 1;
  }

  async verifyAdminPassword(password: string): Promise<boolean> {
    const row = this.db.prepare("SELECT admin_password_hash FROM settings WHERE id = 'global'").get() as { admin_password_hash: string | null } | undefined;
    return verifyPasswordHash(password, row?.admin_password_hash);
  }

  // ── Sessions ──────────────────────────────────────────────────────

  /** New session; returns the cookie token (only its hash is stored) */
  createSession(userAgent?: string | null): { token: string; session: SessionRow } {
    const token = randomToken();
    const now = this.now();
    const session: SessionRow = {
      id: sha256Hex(token),
      created_at: this.iso(now),
      last_seen_at: this.iso(now),
      auth_at: this.iso(now),
      expires_at: this.iso(now + SESSION_MAX_MS),
      user_agent: userAgent ? userAgent.slice(0, 200) : null,
    };
    this.db
      .prepare('INSERT INTO auth_sessions (id, created_at, last_seen_at, auth_at, expires_at, user_agent) VALUES (@id, @created_at, @last_seen_at, @auth_at, @expires_at, @user_agent)')
      .run(session);
    this.pruneSessions();
    return { token, session };
  }

  /** The live session for a cookie token (null if unknown, expired or idle too long); refreshes last_seen. */
  getSession(token: string | undefined | null): SessionRow | null {
    if (!token) return null;
    const id = sha256Hex(token);
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    const now = this.now();
    if (Date.parse(row.expires_at) <= now || Date.parse(row.last_seen_at) + SESSION_IDLE_MS <= now) {
      this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id);
      return null;
    }
    // Touch at most once a minute (fewer writes)
    if (now - Date.parse(row.last_seen_at) > 60_000) {
      row.last_seen_at = this.iso(now);
      this.db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(row.last_seen_at, id);
    }
    return row;
  }

  /** A live session by id (no touch); used to re-check long-lived streams */
  getSessionById(id: string): SessionRow | null {
    const row = this.db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    const now = this.now();
    return Date.parse(row.expires_at) > now && Date.parse(row.last_seen_at) + SESSION_IDLE_MS > now ? row : null;
  }

  isRecentAuth(session: Pick<SessionRow, 'auth_at'>): boolean {
    return this.now() - Date.parse(session.auth_at) < RECENT_AUTH_MS;
  }

  /** Re-auth: the password was just checked again */
  markReauth(sessionId: string): void {
    this.db.prepare('UPDATE auth_sessions SET auth_at = ? WHERE id = ?').run(this.iso(), sessionId);
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(sessionId);
  }

  /** Log out everywhere (password change), optionally keeping one session */
  deleteAllSessions(exceptId?: string): void {
    if (exceptId) this.db.prepare('DELETE FROM auth_sessions WHERE id <> ?').run(exceptId);
    else this.db.prepare('DELETE FROM auth_sessions').run();
  }

  private pruneSessions(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(this.iso(now), this.iso(now - SESSION_IDLE_MS));
  }

  // ── API tokens ────────────────────────────────────────────────────

  createToken(name: string, scope: TokenScope): { token: string; view: ApiTokenView } {
    if (scope !== 'agent' && scope !== 'readonly') throw new Error('scope must be agent or readonly');
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : scope;
    const token = `blt_${randomToken()}`;
    const row: ApiTokenRow = {
      id: crypto.randomUUID(),
      name: label,
      scope,
      token_hash: sha256Hex(token),
      created_at: this.iso(),
      last_used_at: null,
      revoked_at: null,
    };
    this.db
      .prepare('INSERT INTO api_tokens (id, name, scope, token_hash, created_at, last_used_at, revoked_at) VALUES (@id, @name, @scope, @token_hash, @created_at, @last_used_at, @revoked_at)')
      .run(row);
    const { token_hash: _omit, ...view } = row;
    void _omit;
    return { token, view };
  }

  /** The active token row for a bearer token, or null; records last use (at most once a minute) */
  findToken(token: string | undefined | null): ApiTokenView | null {
    if (!token || !token.startsWith('blt_')) return null;
    const row = this.db.prepare('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(sha256Hex(token)) as ApiTokenRow | undefined;
    if (!row) return null;
    const now = this.now();
    if (!row.last_used_at || now - Date.parse(row.last_used_at) > 60_000) {
      row.last_used_at = this.iso(now);
      this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(row.last_used_at, row.id);
    }
    const { token_hash: _omit, ...view } = row;
    void _omit;
    return view;
  }

  isTokenActive(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM api_tokens WHERE id = ? AND revoked_at IS NULL').get(id);
  }

  listTokens(): ApiTokenView[] {
    return this.db.prepare('SELECT id, name, scope, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at').all() as ApiTokenView[];
  }

  revokeToken(id: string): boolean {
    return this.db.prepare('UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this.iso(), id).changes === 1;
  }
}
