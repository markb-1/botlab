/**
 * BotLab admin CLI. Run from the repo with `npm run cli -- <command>` (tsx) or, built / in Docker,
 * `node dist/apps/server/src/cli.js <command>`. Paths follow the server: BOTLAB_DATA_DIR, else
 * `./data`, or the OS app-data dir with `--prod` (as `npm start` uses). `--data-dir <dir>` overrides.
 *
 *   migrate-key                       one-time: re-encrypt an old database's secrets with the master key
 *                                     (old password: prompt or BOTLAB_OLD_PASSWORD; --password <pw> works but
 *                                     is discouraged; asks for a new admin password if none would be set,
 *                                     or BOTLAB_NEW_ADMIN_PASSWORD)
 *   gen-key                           create <data dir>/master.key (never overwrites)
 *   set-password [--password <pw>]   set / reset the admin login password (logs out every session)
 *   token create --scope agent|readonly [--name <name>]
 *   token list
 *   token revoke <id>
 *
 * migrate-key refuses to run while the server is running on the same data dir (it rewrites every
 * secret); the other commands are safe while it runs. migrate-key uses the master key the server would
 * use (BOTLAB_MASTER_KEY, BOTLAB_MASTER_KEY_FILE or <data dir>/master.key) and creates
 * <data dir>/master.key if there is none.
 */

import dotenv from 'dotenv';
import readline from 'readline';
import { Writable } from 'stream';
import { initializeDatabase, closeDatabase } from '../../../packages/core/src/db/index';
import { AdminAuthStore, MIN_PASSWORD_LENGTH, type TokenScope } from '../../../packages/core/src/security/adminAuth';
import { isProduction, resolveDataDir } from './paths';
import { defaultKeyFile, generateKeyFile, loadMasterKey, MasterKeyError } from './masterKey';
import { lockHolder } from './instanceLock';
import { migrateKey, needsNewAdminPassword, needsPassword } from './migrateKey';
import fs from 'fs';
import path from 'path';

dotenv.config();

interface Args {
  command: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const command: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else command.push(a);
  }
  return { command, flags };
}

/** Reads a line without echoing it (falls back to a visible prompt when stdin is not a terminal) */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    let muted = false;
    const output = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    const rl = readline.createInterface({ input: process.stdin, output, terminal: !!process.stdin.isTTY });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = !!process.stdin.isTTY;
  });
}

function usage(): never {
  console.log(`Usage: npm run cli -- <command> [--prod] [--data-dir <dir>]
  migrate-key            (old password prompted, or BOTLAB_OLD_PASSWORD)
  gen-key
  set-password [--password <pw>]
  token create --scope agent|readonly [--name <name>]
  token list
  token revoke <id>`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.prod) process.env.NODE_ENV = 'production';
  const dataDir = typeof flags['data-dir'] === 'string' ? path.resolve(flags['data-dir']) : resolveDataDir();
  const production = isProduction();
  const [cmd, sub] = command;
  if (!cmd) usage();

  if (cmd === 'gen-key') {
    const file = process.env.BOTLAB_MASTER_KEY_FILE ? path.resolve(process.env.BOTLAB_MASTER_KEY_FILE) : defaultKeyFile(dataDir);
    if (fs.existsSync(file)) {
      console.log(`A master key already exists: ${file} (not overwritten)`);
      return;
    }
    generateKeyFile(file);
    console.log(`Generated a new master key: ${file}\nBack it up: without it, wallet keys and exchange credentials in the database cannot be decrypted.`);
    return;
  }

  const dbFile = path.join(dataDir, 'botlab.db');
  if (!fs.existsSync(dbFile) && cmd !== 'set-password') {
    throw new Error(`No database at ${dbFile} (use --data-dir, or --prod for the npm start / service location)`);
  }
  const db = initializeDatabase(dbFile);
  try {
    const auth = new AdminAuthStore(db);
    switch (cmd) {
      case 'migrate-key': {
        const holder = lockHolder(dataDir);
        if (holder) throw new Error(`The BotLab server (pid ${holder.pid}) is running on ${dataDir}: stop it first`);
        const master = loadMasterKey({ dataDir, production: false, log: (m) => console.warn(m) });
        // Old password: hidden prompt or BOTLAB_OLD_PASSWORD; --password works but lands in shell history
        let oldPassword = process.env.BOTLAB_OLD_PASSWORD || undefined;
        if (typeof flags.password === 'string') {
          console.warn('Note: --password is visible in your shell history and process list; prefer the prompt or BOTLAB_OLD_PASSWORD.');
          oldPassword = flags.password;
        }
        if (!oldPassword && needsPassword(db)) oldPassword = await promptHidden('Old BotLab password: ');
        let newAdminPassword = process.env.BOTLAB_NEW_ADMIN_PASSWORD || undefined;
        if (!newAdminPassword && needsNewAdminPassword(db, oldPassword)) {
          if (!process.stdin.isTTY) throw new Error('No admin password would be set: set BOTLAB_NEW_ADMIN_PASSWORD or run this in a terminal');
          console.log(`Choose the admin login password for the web UI (at least ${MIN_PASSWORD_LENGTH} characters).`);
          newAdminPassword = await promptHidden('New admin password: ');
          if ((await promptHidden('Repeat: ')) !== newAdminPassword) throw new Error('Passwords do not match');
        }
        const r = await migrateKey(db, master.key, { oldPassword, newAdminPassword });
        if (r.status === 'already-migrated') console.log('Already using this master key: nothing to do.');
        else if (r.status === 'nothing-to-do') console.log('No password-derived key in this database: master key recorded, nothing to re-encrypt.');
        else {
          console.log(`Re-encrypted ${r.reencrypted.length} secret(s) with the master key${master.file ? ` (${master.file})` : ''}: ${r.reencrypted.join(', ') || 'none'}`);
          if (r.adminPassword === 'old') console.log('Your old password is now the admin login password.');
          else if (r.adminPassword === 'new') console.log('The new admin login password is set.');
        }
        if (!production && master.source === 'generated') console.log('Start the server with the same data dir so it uses this key.');
        break;
      }
      case 'set-password': {
        let password = typeof flags.password === 'string' ? flags.password : undefined;
        if (!password) {
          password = await promptHidden('New admin password: ');
          const again = await promptHidden('Repeat: ');
          if (again !== password) throw new Error('Passwords do not match');
        }
        if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters`);
        await auth.setAdminPassword(password);
        auth.deleteAllSessions();
        console.log('Admin password set; every browser session was logged out.');
        break;
      }
      case 'token': {
        if (sub === 'create') {
          const scope = flags.scope;
          if (scope !== 'agent' && scope !== 'readonly') throw new Error('--scope agent|readonly is required');
          const { token, view } = auth.createToken(typeof flags.name === 'string' ? flags.name : scope, scope as TokenScope);
          console.log(`Created ${view.scope} token "${view.name}" (id ${view.id}). It is shown only once:\n\n  ${token}\n`);
          console.log('Use it as an HTTP header: Authorization: Bearer <token>');
        } else if (sub === 'list') {
          const rows = auth.listTokens();
          if (rows.length === 0) console.log('No API tokens.');
          for (const t of rows) console.log(`${t.id}  ${t.scope.padEnd(8)}  ${t.name}  created ${t.created_at}${t.last_used_at ? `  last used ${t.last_used_at}` : ''}${t.revoked_at ? `  REVOKED ${t.revoked_at}` : ''}`);
        } else if (sub === 'revoke') {
          const id = command[2];
          if (!id) usage();
          console.log(auth.revokeToken(id) ? `Revoked ${id}` : `No active token ${id}`);
        } else usage();
        break;
      }
      default:
        usage();
    }
  } finally {
    closeDatabase(db);
  }
}

main().catch((err) => {
  console.error(err instanceof MasterKeyError || err instanceof Error ? `Error: ${err.message}` : err);
  process.exit(1);
});
