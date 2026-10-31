#!/usr/bin/env node
// preinstall: refuse unsupported Node versions with a clear message (cross-platform, no dependencies).
// better-sqlite3 (the only native dependency) has no build for Node 25+ yet, and npm 11 (bundled with
// newer Node) skips dependency install scripts by default, so `npm install` would leave no native binary.
// Override (at your own risk): BOTLAB_SKIP_NODE_CHECK=1 npm install

const MIN = [22, 12];
const MAX_MAJOR_EXCLUSIVE = 25;

const [major, minor] = process.versions.node.split('.').map(Number);
const tooOld = major < MIN[0] || (major === MIN[0] && minor < MIN[1]);
const tooNew = major >= MAX_MAJOR_EXCLUSIVE;

if ((tooOld || tooNew) && process.env.BOTLAB_SKIP_NODE_CHECK !== '1') {
  const lines = [
    '',
    `BotLab needs Node.js >= ${MIN.join('.')} and < ${MAX_MAJOR_EXCLUSIVE} (Node 22 LTS recommended); this is Node ${process.versions.node}.`,
    tooNew ? `Node ${major} is not supported yet: better-sqlite3 does not build against it.` : `Node ${process.versions.node} is too old.`,
    '',
    'Install Node 22 and run npm install again:',
    '  macOS (Homebrew):  brew install node@22 && brew link --overwrite --force node@22',
    '  nvm / fnm:         nvm install && nvm use      (reads .nvmrc)',
    '  Windows:           winget install OpenJS.NodeJS.LTS  (or nvm-windows: nvm install 22 && nvm use 22)',
    '',
  ];
  console.error(lines.join('\n'));
  process.exit(1);
}
