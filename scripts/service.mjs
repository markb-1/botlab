#!/usr/bin/env node
/**
 * `npm run service:install` / `npm run service:uninstall` (spec §15.1).
 *
 * Windows: registers the built server (`dist/apps/server/src/main.js --production`) as the Windows
 * service "BotLab" with NSSM (https://nssm.cc; `winget install NSSM.NSSM`): delayed auto-start at boot
 * without a login, restart on crash, logs in <data dir>\logs, and a graceful stop — NSSM sends Ctrl+C
 * (SIGINT), so the server writes its clean-shutdown marker. Run from an elevated (Administrator)
 * PowerShell after `npm run build`.
 *
 * Why not node-windows: its wrapper stops the server with TerminateProcess (no SIGINT), so every service
 * stop would look like a crash and the next start would be halted (spec §4.3).
 *
 * The service runs as LocalSystem by default, whose %APPDATA% is not yours, so the data dir, config
 * dir and master key file are fixed to your user's paths at install time.
 *
 * macOS / Linux: prints launchd / systemd instructions with the paths filled in.
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE = 'BotLab';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(repo, 'dist', 'apps', 'server', 'src', 'main.js');
const action = process.argv[2];

function appDataDir() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'BotLab');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'BotLab');
  return path.join(os.homedir(), '.local', 'share', 'botlab');
}

const dataDir = path.resolve(process.env.BOTLAB_DATA_DIR || appDataDir());
const configDir = path.resolve(process.env.BOTLAB_CONFIG_DIR || path.join(dataDir, 'config'));
const keyFile = path.resolve(process.env.BOTLAB_MASTER_KEY_FILE || path.join(dataDir, 'master.key'));

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

function requireBuild() {
  if (!fs.existsSync(entry)) fail(`The server is not built (${entry} missing). Run \`npm run build\` first.`);
}

function ensureKey() {
  if (process.env.BOTLAB_MASTER_KEY) {
    console.log('Note: BOTLAB_MASTER_KEY is set in this shell, but the service reads the key from a file.');
  }
  if (fs.existsSync(keyFile)) return;
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`Generated a new master key: ${keyFile}\nBack it up somewhere safe (password manager): without it, wallet keys cannot be decrypted.`);
}

function nssmPath() {
  if (process.env.NSSM) return process.env.NSSM;
  const r = spawnSync('where', ['nssm'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function nssm(bin, args, { allowFail = false } = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  // nssm writes UTF-16 on some versions; strip NULs for readable output
  const out = `${r.stdout || ''}${r.stderr || ''}`.replace(/\0/g, '').trim();
  if (r.status !== 0 && !allowFail) fail(`nssm ${args.join(' ')} failed${out ? `:\n${out}` : ''}\n(Run this from an elevated PowerShell: right-click → Run as Administrator.)`);
  return out;
}

function windowsInstall() {
  requireBuild();
  const bin = nssmPath();
  if (!bin) {
    fail(
      'NSSM (the Non-Sucking Service Manager) is required to run BotLab as a Windows service.\n' +
        'Install it, then run this again from an elevated PowerShell:\n\n' +
        '  winget install NSSM.NSSM        (or download from https://nssm.cc and add nssm.exe to PATH,\n' +
        '                                   or set $env:NSSM = "C:\\path\\to\\nssm.exe")'
    );
  }
  ensureKey();
  const logs = path.join(dataDir, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const env = [`NODE_ENV=production`, `BOTLAB_DATA_DIR=${dataDir}`, `BOTLAB_CONFIG_DIR=${configDir}`, `BOTLAB_MASTER_KEY_FILE=${keyFile}`];
  if (process.env.BOTLAB_HOST) env.push(`BOTLAB_HOST=${process.env.BOTLAB_HOST}`);
  if (process.env.BOTLAB_PORT) env.push(`BOTLAB_PORT=${process.env.BOTLAB_PORT}`);

  nssm(bin, ['stop', SERVICE], { allowFail: true });
  nssm(bin, ['remove', SERVICE, 'confirm'], { allowFail: true });
  nssm(bin, ['install', SERVICE, process.execPath]);
  const set = (...args) => nssm(bin, ['set', SERVICE, ...args]);
  // Quoted: the repo path may contain spaces (C:\Users\First Last\...)
  set('AppParameters', `"${entry}" --production`);
  set('DisplayName', 'BotLab trading server');
  set('Description', 'BotLab: bots, risk engine and web UI (http://127.0.0.1:3780 by default)');
  set('AppDirectory', repo);
  set('AppEnvironmentExtra', ...env);
  // Graceful stop: Ctrl+C first (SIGINT → clean shutdown marker), up to 25 s
  set('AppStopMethodSkip', '0');
  set('AppStopMethodConsole', '25000');
  set('AppStopMethodWindow', '2000');
  set('AppStopMethodThreads', '2000');
  set('AppKillProcessTree', '1');
  // Restart after a crash (the server starts halted after an unclean exit; clear it in the UI)
  set('AppExit', 'Default', 'Restart');
  set('AppRestartDelay', '10000');
  set('AppThrottle', '30000');
  // Logs with rotation (10 MB)
  set('AppStdout', path.join(logs, 'service.log'));
  set('AppStderr', path.join(logs, 'service.log'));
  set('AppRotateFiles', '1');
  set('AppRotateOnline', '1');
  set('AppRotateBytes', '10485760');
  // Start at boot without a login; delayed so the network (Tailscale) is up
  set('Start', 'SERVICE_DELAYED_AUTO_START');
  nssm(bin, ['start', SERVICE], { allowFail: true });
  console.log(`
Installed and started the "${SERVICE}" Windows service.
  Server:      ${entry}
  Data dir:    ${dataDir}
  Config dir:  ${configDir}
  Master key:  ${keyFile}
  Logs:        ${path.join(logs, 'service.log')}

Check:   nssm status ${SERVICE}    (or services.msc)   ·   http://127.0.0.1:${process.env.BOTLAB_PORT || 3780}/healthz
Stop:    nssm stop ${SERVICE}      Remove: npm run service:uninstall
Power:   set "Sleep" to Never (Settings → System → Power) and set Windows Update active hours;
         an update reboot is handled like a power cut (resting orders expire, BotLab restarts halted).
After \`git pull\` + \`npm run build\`, restart the service: nssm restart ${SERVICE}
`);
}

function windowsUninstall() {
  const bin = nssmPath();
  if (!bin) fail('NSSM not found on PATH (set $env:NSSM to nssm.exe).');
  nssm(bin, ['stop', SERVICE], { allowFail: true });
  nssm(bin, ['remove', SERVICE, 'confirm']);
  console.log(`Removed the "${SERVICE}" service. Data, config and the master key in ${dataDir} were left in place.`);
}

function macInstructions(uninstall) {
  const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.botlab.server.plist');
  if (uninstall) {
    console.log(`launchctl bootout gui/$(id -u) ${plist}\nrm ${plist}`);
    return;
  }
  console.log(`BotLab runs as a launchd agent on macOS (starts at login). Create ${plist}:

<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.botlab.server</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${entry}</string><string>--production</string>
  </array>
  <key>WorkingDirectory</key><string>${repo}</string>
  <key>EnvironmentVariables</key><dict>
    <key>BOTLAB_MASTER_KEY_FILE</key><string>${keyFile}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(dataDir, 'logs', 'server.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(dataDir, 'logs', 'server.log')}</string>
</dict></plist>

Then:  mkdir -p "${path.join(dataDir, 'logs')}" && launchctl bootstrap gui/$(id -u) ${plist}
launchd stops it with SIGTERM (graceful). Generate the key first if needed: npm run cli -- gen-key --prod`);
}

function linuxInstructions(uninstall) {
  const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'botlab.service');
  if (uninstall) {
    console.log(`systemctl --user disable --now botlab && rm ${unit}`);
    return;
  }
  console.log(`BotLab runs as a systemd user service on Linux. Create ${unit}:

[Unit]
Description=BotLab trading server
After=network-online.target

[Service]
WorkingDirectory=${repo}
ExecStart=${process.execPath} ${entry} --production
Environment=BOTLAB_MASTER_KEY_FILE=${keyFile}
Environment=TZ=Europe/Dublin
Restart=on-failure
RestartSec=10
TimeoutStopSec=30
KillSignal=SIGTERM

[Install]
WantedBy=default.target

Then:  systemctl --user daemon-reload && systemctl --user enable --now botlab
       loginctl enable-linger $USER     # keep it running without a login session
(Or use Docker: see README.) Generate the key first if needed: npm run cli -- gen-key --prod`);
}

if (action !== 'install' && action !== 'uninstall') fail('Usage: node scripts/service.mjs install|uninstall');
if (process.platform === 'win32') {
  if (action === 'install') windowsInstall();
  else windowsUninstall();
} else if (process.platform === 'darwin') {
  if (action === 'install') requireBuild();
  macInstructions(action === 'uninstall');
} else {
  if (action === 'install') requireBuild();
  linuxInstructions(action === 'uninstall');
}
