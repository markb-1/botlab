import { z } from 'zod';

/**
 * server.yaml schema (spec §3, §11). Deployment/notification settings, human-owned.
 *
 * NOTE: spec §4.3/§5.1 also put `start_halted_after_crash` and `script_fetch_allowlist` in
 * server.yaml; they still live in limits.yaml under `server:` (see PROGRESS Decision R37).
 */

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const DEFAULT_TIMEZONE = 'Europe/Dublin';

export const ServerSchema = z.strictObject({
  /** IANA time zone for the daily digest */
  timezone: z.string().min(1).refine(isValidTimeZone, { message: 'must be a valid IANA time zone (e.g. Europe/Dublin)' }).default(DEFAULT_TIMEZONE),
  /** Local time (in `timezone`) of the daily digest, HH:MM 24 h */
  digest_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24 h)')
    .default('08:00'),
  /**
   * HTTP server (spec §8.2). Read at server start (a change needs a restart); the environment variables
   * BOTLAB_HOST / BOTLAB_PORT / BOTLAB_ALLOWED_HOSTS override these.
   */
  http: z
    .strictObject({
      /** Interface to bind. 127.0.0.1 = this machine only; a Tailscale IP for the home server. Never public. */
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(3780),
      /**
       * Extra Host names the UI may be reached by (DNS-rebinding protection). IP addresses, localhost and
       * *.ts.net (Tailscale MagicDNS) are always allowed. A leading dot allows subdomains (".example.lan").
       */
      allowed_hosts: z.array(z.string().min(1)).default([]),
    })
    .prefault({}),
  /** Order-book recorder (spec §10) */
  recorder: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Seconds between snapshots of every watched token */
      interval_seconds: z.number().int().min(10).max(3600).default(60),
      /** Cap on tokens snapshotted per cycle (disk use, §10) */
      max_tokens: z.number().int().min(1).max(2000).default(200),
    })
    .prefault({}),
  notify: z
    .strictObject({
      telegram: z
        .strictObject({
          enabled: z.boolean().default(false),
          /** Bot token from BotFather; TELEGRAM_BOT_TOKEN overrides it */
          bot_token: z.string().default(''),
          /** The admin chat; messages from any other chat are ignored. Numbers are accepted and stored as text. */
          chat_id: z
            .union([z.string(), z.number().int()])
            .transform((v) => String(v).trim())
            .default(''),
        })
        .prefault({}),
    })
    .prefault({}),
});

export type ServerConfig = z.infer<typeof ServerSchema>;

export const DEFAULT_SERVER_YAML = `# BotLab server settings (spec §3, §11). Human-owned.
# Copy to server.yaml (or start the app once and it is created with these defaults).
timezone: Europe/Dublin              # time zone of the daily digest
digest_time: "08:00"                 # local time (HH:MM) of the daily digest
http:                                # web UI / API server (restart to apply; BOTLAB_HOST / BOTLAB_PORT override)
  host: 127.0.0.1                    # this machine only; use the Tailscale IP on the home server; never public
  port: 3780
  allowed_hosts: []                  # extra host names for the UI (IPs, localhost and *.ts.net always work)
recorder:                            # order-book snapshots for backtests (top 10 levels)
  enabled: true
  interval_seconds: 60
  max_tokens: 200                    # tokens per cycle: bot scopes, active forecasts, held, watchlist
notify:
  telegram:
    enabled: false
    bot_token: ""                    # from BotFather; the TELEGRAM_BOT_TOKEN environment variable overrides it
    chat_id: ""                      # your private chat id; messages from any other chat are ignored
`;
