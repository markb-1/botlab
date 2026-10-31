// A runner stand-in for tests/agent/scheduler.test.ts: ignores SIGTERM and the server's abort message (like a hung
// runner), and starts a grandchild (like the SDK's Claude Code process) that must die with it.
const { spawn } = require('child_process');

process.on('SIGTERM', () => undefined);
process.on('message', () => undefined);
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
process.send({ type: 'log', text: `grandchild ${grandchild.pid}` });
process.send({ type: 'usage', tokensIn: 10, tokensOut: 1, costUsd: 0.02, estimated: true });
setInterval(() => undefined, 1000);
