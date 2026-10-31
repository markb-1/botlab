/**
 * Worker entry for the script typecheck (TypecheckRunner): runs the TypeScript compiler off the main
 * thread under V8 heap limits, so a pathological script cannot block the server's event loop or exhaust
 * its memory (spec §5.3; PROGRESS R144).
 */

import { parentPort } from 'worker_threads';
import { typecheckScript } from './typecheckScript';

parentPort?.on('message', (msg: { id: number; source: string }) => {
  try {
    parentPort!.postMessage({ id: msg.id, result: typecheckScript(msg.source) });
  } catch (err) {
    parentPort!.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
});
