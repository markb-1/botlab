/**
 * Worker Bootstrap - runs inside each worker thread.
 * Receives compiled script code via workerData, creates BotContext,
 * and manages the script lifecycle (start/stop/heartbeat).
 *
 * Sandbox (spec §5.1, limits in sandbox.ts): escape-hatch globals (process, fetch, ...) are deleted
 * before the script is evaluated; the script gets only module/exports/ctx.
 */

import { parentPort as maybeParentPort, workerData } from 'worker_threads';
import { createBotContext, handleRpcResponse } from './BotContextProxy';
import { evaluateScript, hardenWorkerGlobals } from './sandbox';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
  ScriptModule,
  RpcResponse,
} from '../sdk/types';

if (!maybeParentPort) {
  throw new Error('worker-bootstrap must run inside a worker thread');
}
const parentPort = maybeParentPort;
// Keep our own reference: the global is removed before the script runs
const proc = process;

// Extract data passed from main thread
const {
  compiledCode,
  botId,
  botName,
  config,
  walletAddress,
  proxyAddress,
} = workerData as {
  compiledCode: string;
  botId: string;
  botName: string;
  config: Record<string, unknown>;
  walletAddress: string;
  proxyAddress?: string;
};

// Create the BotContext
const ctx = createBotContext({
  botId,
  botName,
  config,
  walletAddress,
  proxyAddress,
});

// Load the compiled script module
let scriptModule: ScriptModule;

hardenWorkerGlobals();

try {
  // The compiled code should export { onStart?, onTick?, onStop?, onHeartbeat?, meta? }
  const exports = evaluateScript(compiledCode, ctx);

  if (typeof exports.onStart !== 'function' && typeof exports.onTick !== 'function') {
    throw new Error('Script must export at least one of: onStart, onTick');
  }

  scriptModule = {
    meta: exports.meta as ScriptModule['meta'],
    onStart: exports.onStart as ScriptModule['onStart'],
    onStop: exports.onStop as ScriptModule['onStop'],
    onHeartbeat: exports.onHeartbeat as ScriptModule['onHeartbeat'],
    onTick: exports.onTick as ScriptModule['onTick'],
  };
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  const msg: WorkerToMainMessage = { type: 'error', error: `Script load error: ${message}` };
  parentPort.postMessage(msg);
  proc.exit(1);
}

function send(msg: WorkerToMainMessage): void {
  parentPort.postMessage(msg);
}

// onTick runs one at a time (a tick still in flight skips the next interval). tick-start/tick-end
// let the main thread's watchdog see a tick that never settles, even if this thread is blocked.
let tickSeq = 0;
let tickInFlight = false;
async function runTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  const id = ++tickSeq;
  send({ type: 'tick-start', id });
  try {
    await scriptModule.onTick!(ctx);
  } finally {
    tickInFlight = false;
    send({ type: 'tick-end', id });
  }
}

// Handle messages from main process
parentPort.on('message', async (msg: MainToWorkerMessage) => {
  switch (msg.type) {
    case 'start':
      try {
        // Run onStart if defined (setup, logging, etc.)
        if (scriptModule.onStart) {
          await scriptModule.onStart(ctx);
        }

        // Start onTick polling loop if defined
        if (scriptModule.onTick) {
          const intervalMs = (config.pollingIntervalMs as number) || 10000;
          ctx.setInterval(runTick, intervalMs);
        }

        send({ type: 'started' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', error: `onStart failed: ${message}` });
      }
      break;

    case 'stop':
      try {
        if (scriptModule.onStop) {
          await scriptModule.onStop(ctx);
        }
        send({ type: 'stopped' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({ type: 'error', error: `onStop failed: ${message}` });
        send({ type: 'stopped' }); // Still signal stopped
      }
      break;

    case 'heartbeat':
      try {
        const metrics = scriptModule.onHeartbeat
          ? await scriptModule.onHeartbeat(ctx)
          : {};
        send({ type: 'heartbeat-result', metrics });
      } catch {
        send({ type: 'heartbeat-result', metrics: {} });
      }
      break;

    case 'rpc-response':
      handleRpcResponse(msg.response as RpcResponse);
      break;
  }
});

// Handle uncaught errors in the worker
proc.on('uncaughtException', (err) => {
  send({ type: 'error', error: `Uncaught: ${err.message}` });
});

proc.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  send({ type: 'error', error: `Unhandled rejection: ${msg}` });
});
