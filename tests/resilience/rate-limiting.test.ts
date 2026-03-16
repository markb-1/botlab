/**
 * Error Resilience Tests: Rate Limiting
 *
 * Tests for handling API rate limits, backoff strategies,
 * and request throttling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Rate Limiting Resilience', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Rate Limit Detection', () => {
    it('should identify 429 Too Many Requests responses', () => {
      const isRateLimited = (statusCode: number): boolean => statusCode === 429;

      expect(isRateLimited(429)).toBe(true);
      expect(isRateLimited(200)).toBe(false);
      expect(isRateLimited(500)).toBe(false);
      expect(isRateLimited(403)).toBe(false);
    });

    it('should parse Retry-After header (seconds)', () => {
      const parseRetryAfter = (header: string | null): number => {
        if (!header) return 60; // Default 60 seconds

        // Check if it's a number (seconds)
        const seconds = parseInt(header, 10);
        if (!isNaN(seconds)) return seconds;

        // Check if it's a date
        const date = new Date(header);
        if (!isNaN(date.getTime())) {
          return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
        }

        return 60;
      };

      expect(parseRetryAfter('120')).toBe(120);
      expect(parseRetryAfter('30')).toBe(30);
      expect(parseRetryAfter(null)).toBe(60);
      expect(parseRetryAfter('')).toBe(60);
    });

    it('should parse X-RateLimit headers', () => {
      interface RateLimitInfo {
        limit: number;
        remaining: number;
        reset: number;
      }

      const parseRateLimitHeaders = (headers: Record<string, string>): RateLimitInfo | null => {
        const limit = parseInt(headers['x-ratelimit-limit'], 10);
        const remaining = parseInt(headers['x-ratelimit-remaining'], 10);
        const reset = parseInt(headers['x-ratelimit-reset'], 10);

        if (isNaN(limit) || isNaN(remaining) || isNaN(reset)) {
          return null;
        }

        return { limit, remaining, reset };
      };

      const headers = {
        'x-ratelimit-limit': '100',
        'x-ratelimit-remaining': '25',
        'x-ratelimit-reset': '1704067200',
      };

      const info = parseRateLimitHeaders(headers);

      expect(info).not.toBeNull();
      expect(info?.limit).toBe(100);
      expect(info?.remaining).toBe(25);
      expect(info?.reset).toBe(1704067200);

      expect(parseRateLimitHeaders({})).toBeNull();
    });

    it('should detect approaching rate limit', () => {
      const isApproachingLimit = (remaining: number, limit: number, threshold = 0.1): boolean => {
        return remaining / limit <= threshold;
      };

      expect(isApproachingLimit(5, 100)).toBe(true); // 5% remaining
      expect(isApproachingLimit(10, 100)).toBe(true); // 10% remaining (at threshold)
      expect(isApproachingLimit(50, 100)).toBe(false); // 50% remaining
      expect(isApproachingLimit(0, 100)).toBe(true); // 0% remaining
    });
  });

  describe('Request Throttling', () => {
    it('should implement token bucket rate limiter', () => {
      class TokenBucket {
        private tokens: number;
        private lastRefill: number;

        constructor(
          private capacity: number,
          private refillRate: number // tokens per second
        ) {
          this.tokens = capacity;
          this.lastRefill = Date.now();
        }

        private refill(): void {
          const now = Date.now();
          const elapsed = (now - this.lastRefill) / 1000;
          const tokensToAdd = elapsed * this.refillRate;
          this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
          this.lastRefill = now;
        }

        tryConsume(tokens = 1): boolean {
          this.refill();
          if (this.tokens >= tokens) {
            this.tokens -= tokens;
            return true;
          }
          return false;
        }

        getAvailableTokens(): number {
          this.refill();
          return Math.floor(this.tokens);
        }

        getWaitTime(tokens = 1): number {
          this.refill();
          if (this.tokens >= tokens) return 0;
          return ((tokens - this.tokens) / this.refillRate) * 1000;
        }
      }

      const bucket = new TokenBucket(10, 1); // 10 capacity, 1 token/second

      // Initially full
      expect(bucket.getAvailableTokens()).toBe(10);

      // Consume tokens
      expect(bucket.tryConsume(5)).toBe(true);
      expect(bucket.getAvailableTokens()).toBe(5);

      // Consume more
      expect(bucket.tryConsume(5)).toBe(true);
      expect(bucket.getAvailableTokens()).toBe(0);

      // No more tokens
      expect(bucket.tryConsume(1)).toBe(false);

      // Wait for refill
      vi.advanceTimersByTime(3000); // 3 seconds
      expect(bucket.getAvailableTokens()).toBe(3);
    });

    it('should implement sliding window rate limiter', () => {
      class SlidingWindowLimiter {
        private requests: number[] = [];

        constructor(
          private maxRequests: number,
          private windowMs: number
        ) {}

        private cleanup(): void {
          const cutoff = Date.now() - this.windowMs;
          this.requests = this.requests.filter((t) => t > cutoff);
        }

        canMakeRequest(): boolean {
          this.cleanup();
          return this.requests.length < this.maxRequests;
        }

        recordRequest(): boolean {
          if (!this.canMakeRequest()) return false;
          this.requests.push(Date.now());
          return true;
        }

        getRequestCount(): number {
          this.cleanup();
          return this.requests.length;
        }

        getWaitTime(): number {
          this.cleanup();
          if (this.requests.length < this.maxRequests) return 0;

          const oldestRequest = this.requests[0];
          return Math.max(0, oldestRequest + this.windowMs - Date.now());
        }
      }

      const limiter = new SlidingWindowLimiter(5, 60000); // 5 requests per minute

      // Make 5 requests
      for (let i = 0; i < 5; i++) {
        expect(limiter.recordRequest()).toBe(true);
      }

      // 6th request should fail
      expect(limiter.canMakeRequest()).toBe(false);

      // Wait for window to slide
      vi.advanceTimersByTime(60000);
      expect(limiter.canMakeRequest()).toBe(true);
    });

    it('should queue requests when rate limited', async () => {
      class RequestQueue {
        private queue: Array<{ resolve: () => void; timestamp: number }> = [];
        private processing = false;
        private minInterval: number;

        constructor(requestsPerSecond: number) {
          this.minInterval = 1000 / requestsPerSecond;
        }

        async enqueue<T>(fn: () => Promise<T>): Promise<T> {
          return new Promise((resolve, reject) => {
            this.queue.push({
              resolve: async () => {
                try {
                  resolve(await fn());
                } catch (e) {
                  reject(e);
                }
              },
              timestamp: Date.now(),
            });
            this.processQueue();
          });
        }

        private async processQueue(): Promise<void> {
          if (this.processing || this.queue.length === 0) return;
          this.processing = true;

          while (this.queue.length > 0) {
            const item = this.queue.shift()!;
            await item.resolve();
            if (this.queue.length > 0) {
              await new Promise((r) => setTimeout(r, this.minInterval));
            }
          }

          this.processing = false;
        }

        getQueueLength(): number {
          return this.queue.length;
        }
      }

      const queue = new RequestQueue(2); // 2 requests per second

      let completed = 0;
      const mockRequest = async () => {
        completed++;
        return completed;
      };

      // Queue multiple requests
      const promises = [
        queue.enqueue(mockRequest),
        queue.enqueue(mockRequest),
        queue.enqueue(mockRequest),
      ];

      // First request processes immediately
      await vi.advanceTimersByTimeAsync(0);
      expect(completed).toBeGreaterThanOrEqual(1);

      // Wait for all to complete
      await vi.runAllTimersAsync();
      await Promise.all(promises);
      expect(completed).toBe(3);
    });
  });

  describe('Backoff Strategies', () => {
    it('should implement fixed backoff', () => {
      const fixedBackoff = (delay: number) => () => delay;

      const getDelay = fixedBackoff(5000);

      expect(getDelay()).toBe(5000);
      expect(getDelay()).toBe(5000);
      expect(getDelay()).toBe(5000);
    });

    it('should implement linear backoff', () => {
      const linearBackoff = (baseDelay: number, increment: number) => {
        let attempt = 0;
        return () => {
          attempt++;
          return baseDelay + increment * (attempt - 1);
        };
      };

      const getDelay = linearBackoff(1000, 500);

      expect(getDelay()).toBe(1000); // Attempt 1
      expect(getDelay()).toBe(1500); // Attempt 2
      expect(getDelay()).toBe(2000); // Attempt 3
      expect(getDelay()).toBe(2500); // Attempt 4
    });

    it('should implement exponential backoff with max cap', () => {
      const exponentialBackoff = (baseDelay: number, maxDelay: number) => {
        let attempt = 0;
        return () => {
          attempt++;
          const delay = baseDelay * Math.pow(2, attempt - 1);
          return Math.min(delay, maxDelay);
        };
      };

      const getDelay = exponentialBackoff(1000, 30000);

      expect(getDelay()).toBe(1000); // 1s
      expect(getDelay()).toBe(2000); // 2s
      expect(getDelay()).toBe(4000); // 4s
      expect(getDelay()).toBe(8000); // 8s
      expect(getDelay()).toBe(16000); // 16s
      expect(getDelay()).toBe(30000); // 30s (capped)
      expect(getDelay()).toBe(30000); // Still capped
    });

    it('should implement decorrelated jitter backoff', () => {
      // AWS-style decorrelated jitter
      const decorrelatedJitter = (baseDelay: number, maxDelay: number) => {
        let prevDelay = baseDelay;
        return () => {
          const delay = Math.min(maxDelay, Math.random() * prevDelay * 3);
          prevDelay = Math.max(baseDelay, delay);
          return Math.round(delay);
        };
      };

      const getDelay = decorrelatedJitter(1000, 30000);

      // Run multiple times to verify variability
      const delays = Array.from({ length: 10 }, () => getDelay());

      // All delays should be within bounds
      for (const delay of delays) {
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(30000);
      }
    });
  });

  describe('Per-Endpoint Rate Limiting', () => {
    it('should track rate limits per endpoint', () => {
      class EndpointRateLimiter {
        private limiters: Map<string, { remaining: number; reset: number }> = new Map();

        updateLimit(endpoint: string, remaining: number, resetTimestamp: number): void {
          this.limiters.set(endpoint, { remaining, reset: resetTimestamp });
        }

        canRequest(endpoint: string): boolean {
          const limiter = this.limiters.get(endpoint);
          if (!limiter) return true;

          // Check if reset time has passed
          if (Date.now() / 1000 > limiter.reset) {
            return true;
          }

          return limiter.remaining > 0;
        }

        getWaitTime(endpoint: string): number {
          const limiter = this.limiters.get(endpoint);
          if (!limiter || this.canRequest(endpoint)) return 0;

          return Math.max(0, limiter.reset * 1000 - Date.now());
        }

        getAllLimits(): Map<string, { remaining: number; reset: number }> {
          return new Map(this.limiters);
        }
      }

      const limiter = new EndpointRateLimiter();
      const now = Math.floor(Date.now() / 1000);

      limiter.updateLimit('/api/trades', 50, now + 60);
      limiter.updateLimit('/api/markets', 0, now + 30);

      expect(limiter.canRequest('/api/trades')).toBe(true);
      expect(limiter.canRequest('/api/markets')).toBe(false);
      expect(limiter.canRequest('/api/unknown')).toBe(true);

      // Wait for reset
      vi.advanceTimersByTime(31000);
      expect(limiter.canRequest('/api/markets')).toBe(true);
    });

    it('should prioritize requests by endpoint importance', () => {
      interface QueuedRequest {
        endpoint: string;
        priority: number;
        timestamp: number;
      }

      const priorityQueue: QueuedRequest[] = [];

      const enqueue = (endpoint: string, priority: number): void => {
        priorityQueue.push({ endpoint, priority, timestamp: Date.now() });
        priorityQueue.sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority; // Higher priority first
          return a.timestamp - b.timestamp; // FIFO for same priority
        });
      };

      enqueue('/api/trades', 1); // Low priority
      enqueue('/api/positions', 3); // High priority
      enqueue('/api/markets', 2); // Medium priority
      enqueue('/api/status', 3); // High priority

      expect(priorityQueue[0].endpoint).toBe('/api/positions'); // Highest priority, first added
      expect(priorityQueue[1].endpoint).toBe('/api/status'); // Highest priority, second added
      expect(priorityQueue[2].endpoint).toBe('/api/markets'); // Medium
      expect(priorityQueue[3].endpoint).toBe('/api/trades'); // Low
    });
  });

  describe('Rate Limit Recovery', () => {
    it('should gradually increase request rate after recovery', () => {
      class AdaptiveRateLimiter {
        private currentRate: number;
        private maxRate: number;
        private minRate: number;
        private rampUpFactor: number;

        constructor(maxRate: number, minRate: number, rampUpFactor = 1.5) {
          this.maxRate = maxRate;
          this.minRate = minRate;
          this.currentRate = maxRate;
          this.rampUpFactor = rampUpFactor;
        }

        onRateLimitHit(): void {
          this.currentRate = this.minRate;
        }

        onSuccessfulRequest(): void {
          if (this.currentRate < this.maxRate) {
            this.currentRate = Math.min(this.maxRate, this.currentRate * this.rampUpFactor);
          }
        }

        getCurrentRate(): number {
          return this.currentRate;
        }

        getInterval(): number {
          return 1000 / this.currentRate;
        }
      }

      const limiter = new AdaptiveRateLimiter(10, 1); // Max 10/s, min 1/s

      expect(limiter.getCurrentRate()).toBe(10);

      // Hit rate limit
      limiter.onRateLimitHit();
      expect(limiter.getCurrentRate()).toBe(1);

      // Successful requests ramp up
      limiter.onSuccessfulRequest();
      expect(limiter.getCurrentRate()).toBe(1.5);

      limiter.onSuccessfulRequest();
      expect(limiter.getCurrentRate()).toBeCloseTo(2.25);

      // Eventually reaches max
      for (let i = 0; i < 20; i++) {
        limiter.onSuccessfulRequest();
      }
      expect(limiter.getCurrentRate()).toBe(10);
    });

    it('should track rate limit statistics', () => {
      interface RateLimitStats {
        totalRequests: number;
        rateLimitedRequests: number;
        totalWaitTime: number;
        averageWaitTime: number;
      }

      class RateLimitTracker {
        private stats: RateLimitStats = {
          totalRequests: 0,
          rateLimitedRequests: 0,
          totalWaitTime: 0,
          averageWaitTime: 0,
        };

        recordRequest(wasRateLimited: boolean, waitTime = 0): void {
          this.stats.totalRequests++;
          if (wasRateLimited) {
            this.stats.rateLimitedRequests++;
            this.stats.totalWaitTime += waitTime;
            this.stats.averageWaitTime =
              this.stats.totalWaitTime / this.stats.rateLimitedRequests;
          }
        }

        getStats(): RateLimitStats {
          return { ...this.stats };
        }

        getRateLimitedPercentage(): number {
          if (this.stats.totalRequests === 0) return 0;
          return (this.stats.rateLimitedRequests / this.stats.totalRequests) * 100;
        }
      }

      const tracker = new RateLimitTracker();

      // Simulate some requests
      tracker.recordRequest(false);
      tracker.recordRequest(false);
      tracker.recordRequest(true, 5000);
      tracker.recordRequest(false);
      tracker.recordRequest(true, 3000);

      const stats = tracker.getStats();

      expect(stats.totalRequests).toBe(5);
      expect(stats.rateLimitedRequests).toBe(2);
      expect(tracker.getRateLimitedPercentage()).toBe(40);
      expect(stats.averageWaitTime).toBe(4000);
    });
  });
});
