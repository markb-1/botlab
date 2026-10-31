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

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
/** Spec §7.1: no scheduled agent runs between 00:00 and 07:00 local time */
export const AGENT_QUIET_START_MIN = 0;
export const AGENT_QUIET_END_MIN = 7 * 60;
const outsideQuietHours = (t: string): boolean => minutesOf(t) >= AGENT_QUIET_END_MIN;
const runTime = z
  .string()
  .regex(HHMM, 'must be HH:MM (24 h)')
  .refine(outsideQuietHours, { message: 'no scheduled agent runs between 00:00 and 07:00 (spec §7.1)' });

/** Models the runner may use (spec §7.1); the default is the cheaper one */
export const AGENT_MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'] as const;

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
  /**
   * The scheduled agent (spec §7.1, chunk 4b). Off by default. Needs ANTHROPIC_API_KEY in the server's
   * environment (never in a file or the database). Times are in `timezone`.
   */
  agent: z
    .strictObject({
      enabled: z.boolean().default(false),
      model: z.enum(AGENT_MODELS).default('claude-sonnet-5-5'),
      /** Model turns per run (the runner stops the run beyond this) */
      max_turns: z.number().int().min(5).max(500).default(80),
      schedule: z
        .strictObject({
          /** Daily review */
          review: runTime.default('07:30'),
          /** Cycles (scan → research → forecast → act) */
          cycles: z.array(runTime).max(12).default(['11:30', '15:30', '19:30', '23:30']),
        })
        .prefault({}),
      /** Event-triggered maintenance runs: rules_changed on a held market, bot halt, reconciliation mismatch */
      events: z
        .strictObject({
          enabled: z.boolean().default(true),
          max_per_day: z.number().int().min(0).max(4).default(4),
          debounce_minutes: z.number().int().min(30).max(24 * 60).default(30),
        })
        .prefault({}),
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
agent:                               # scheduled AI agent (spec §7.1); needs ANTHROPIC_API_KEY in the environment
  enabled: false                     # off until you switch it on (paper bots only; see README "Running the agent")
  model: claude-sonnet-5-5           # or claude-opus-5-5 (about 2x the cost)
  max_turns: 80                      # model turns per run; cost per run: limits.yaml agent.max_run_cost_usd
  schedule:                          # local times in \`timezone\`; nothing between 00:00 and 07:00
    review: "07:30"
    cycles: ["11:30", "15:30", "19:30", "23:30"]
  events:                            # maintenance runs on rules changes (held market), bot halts, reconciliation mismatches
    enabled: true
    max_per_day: 4                   # at most 4 (spec)
    debounce_minutes: 30             # at most one per 30 minutes
notify:
  telegram:
    enabled: false
    bot_token: ""                    # from BotFather; the TELEGRAM_BOT_TOKEN environment variable overrides it
    chat_id: ""                      # your private chat id; messages from any other chat are ignored
`;
