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
notify:
  telegram:
    enabled: false
    bot_token: ""                    # from BotFather; the TELEGRAM_BOT_TOKEN environment variable overrides it
    chat_id: ""                      # your private chat id; messages from any other chat are ignored
`;
