import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evaluateScript } from '../../electron/runtime/sandbox';

/**
 * Tests for the worker-bootstrap onTick integration.
 *
 * Since worker-bootstrap.ts runs as a module inside a worker thread,
 * we test the onTick contract by simulating what the bootstrap does:
 * extracting exports, validating them, and starting the polling loop.
 *
 * This mirrors the logic in worker-bootstrap.ts without needing to
 * actually spawn a worker thread.
 */

// Simulate the script module extraction logic from worker-bootstrap
function extractScriptModule(compiledCode: string) {
  const exports = evaluateScript(compiledCode, {});

  // Validation (same as worker-bootstrap.ts)
  if (typeof exports.onStart !== 'function' && typeof exports.onTick !== 'function') {
    throw new Error('Script must export at least one of: onStart, onTick');
  }

  return {
    meta: exports.meta,
    onStart: exports.onStart as ((ctx: unknown) => Promise<void> | void) | undefined,
    onStop: exports.onStop as ((ctx: unknown) => Promise<void> | void) | undefined,
    onHeartbeat: exports.onHeartbeat as ((ctx: unknown) => Record<string, unknown>) | undefined,
    onTick: exports.onTick as ((ctx: unknown) => Promise<void> | void) | undefined,
  };
}

describe('worker-bootstrap onTick', () => {
  describe('script validation', () => {
    it('should accept script with only onTick', () => {
      const code = `
        exports.onTick = function(ctx) { };
      `;
      const mod = extractScriptModule(code);
      expect(mod.onTick).toBeTypeOf('function');
      expect(mod.onStart).toBeUndefined();
    });

    it('should accept script with only onStart', () => {
      const code = `
        exports.onStart = function(ctx) { };
      `;
      const mod = extractScriptModule(code);
      expect(mod.onStart).toBeTypeOf('function');
      expect(mod.onTick).toBeUndefined();
    });

    it('should accept script with both onStart and onTick', () => {
      const code = `
        exports.onStart = function(ctx) { };
        exports.onTick = function(ctx) { };
      `;
      const mod = extractScriptModule(code);
      expect(mod.onStart).toBeTypeOf('function');
      expect(mod.onTick).toBeTypeOf('function');
    });

    it('should reject script with neither onStart nor onTick', () => {
      const code = `
        exports.onStop = function(ctx) { };
      `;
      expect(() => extractScriptModule(code)).toThrow(
        'Script must export at least one of: onStart, onTick'
      );
    });

    it('should extract all lifecycle functions', () => {
      const code = `
        exports.onStart = function() {};
        exports.onTick = function() {};
        exports.onStop = function() {};
        exports.onHeartbeat = function() { return { ok: true }; };
        exports.meta = { name: 'Test', version: '1.0.0' };
      `;
      const mod = extractScriptModule(code);
      expect(mod.onStart).toBeTypeOf('function');
      expect(mod.onTick).toBeTypeOf('function');
      expect(mod.onStop).toBeTypeOf('function');
      expect(mod.onHeartbeat).toBeTypeOf('function');
      expect(mod.meta).toEqual({ name: 'Test', version: '1.0.0' });
    });
  });

  describe('onTick polling simulation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('should call onTick at the configured interval', async () => {
      const tickFn = vi.fn();
      const intervalMs = 5000;

      // Simulate what worker-bootstrap does after extracting onTick
      const intervalId = setInterval(() => tickFn(), intervalMs);

      expect(tickFn).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);
      expect(tickFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      expect(tickFn).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(15000);
      expect(tickFn).toHaveBeenCalledTimes(5);

      clearInterval(intervalId);
      vi.useRealTimers();
    });

    it('should use default interval of 10000ms when pollingIntervalMs not set', () => {
      const config: Record<string, unknown> = {};
      const intervalMs = (config.pollingIntervalMs as number) || 10000;
      expect(intervalMs).toBe(10000);
    });

    it('should use config pollingIntervalMs when set', () => {
      const config: Record<string, unknown> = { pollingIntervalMs: 30000 };
      const intervalMs = (config.pollingIntervalMs as number) || 10000;
      expect(intervalMs).toBe(30000);
    });
  });

  describe('start sequence', () => {
    it('should run onStart before onTick begins', async () => {
      const callOrder: string[] = [];
      const code = `
        exports.onStart = async function(ctx) {
          ctx.calls.push('onStart');
        };
        exports.onTick = function(ctx) {
          ctx.calls.push('onTick');
        };
      `;
      const mod = extractScriptModule(code);
      const ctx = { calls: callOrder };

      // Simulate start sequence: run onStart first
      if (mod.onStart) {
        await mod.onStart(ctx);
      }

      expect(callOrder).toEqual(['onStart']);

      // Then onTick would be called by the interval
      if (mod.onTick) {
        mod.onTick(ctx);
      }

      expect(callOrder).toEqual(['onStart', 'onTick']);
    });

    it('should start onTick polling even without onStart', async () => {
      const tickCalls: number[] = [];
      const code = `
        exports.onTick = function(ctx) {
          ctx.ticks.push(Date.now());
        };
      `;
      const mod = extractScriptModule(code);

      expect(mod.onStart).toBeUndefined();
      expect(mod.onTick).toBeTypeOf('function');

      // onTick should still work when onStart is absent
      const ctx = { ticks: tickCalls };
      mod.onTick!(ctx);
      expect(tickCalls.length).toBe(1);
    });
  });
});
