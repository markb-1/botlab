/**
 * Backtest worker entry (spec §5.1): evaluates the script and runs the simulation off the main thread,
 * with the same sandbox as bot workers (no require/process, empty env, heap limits). BacktestEngine
 * terminates it on its overall timeout, so an infinite loop cannot freeze the app.
 */

import { parentPort as maybeParentPort, workerData } from 'worker_threads';
import { hardenWorkerRealm } from '../runtime/sandbox';
import { runBacktestSimulation, type SimulationInput } from './simulate';

if (!maybeParentPort) {
  throw new Error('backtest-worker must run inside a worker thread');
}
const parentPort = maybeParentPort;

hardenWorkerRealm();

runBacktestSimulation(workerData as SimulationInput)
  .then((output) => parentPort.postMessage({ type: 'result', output }))
  .catch((err: unknown) => parentPort.postMessage({ type: 'error', error: err instanceof Error ? err.message : String(err) }));
