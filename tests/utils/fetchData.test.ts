/**
 * Utility Function Tests: fetchData
 *
 * Tests for the fetchData utility including retry logic,
 * timeout handling, and error responses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosError } from 'axios';

// Mock axios
vi.mock('axios', async () => {
  const actual = await vi.importActual('axios');
  return {
    ...actual,
    default: {
      get: vi.fn(),
      isAxiosError: (error: any) => error?.isAxiosError === true,
    },
  };
});

// Import after mocking
import fetchData from '../../packages/core/src/utils/fetchData';

const mockedAxios = vi.mocked(axios);

describe('fetchData Utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Successful Requests', () => {
    it('should return data on successful request', async () => {
      const mockData = { result: 'success', items: [1, 2, 3] };
      mockedAxios.get.mockResolvedValueOnce({ data: mockData });

      const resultPromise = fetchData('https://api.example.com/data');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockData);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.objectContaining({
          timeout: 10000,
          headers: expect.objectContaining({
            'User-Agent': expect.any(String),
          }),
        })
      );
    });

    it('should handle empty array response', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: [] });

      const resultPromise = fetchData('https://api.example.com/empty');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual([]);
    });

    it('should handle null response', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: null });

      const resultPromise = fetchData('https://api.example.com/null');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toBeNull();
    });
  });

  describe('Retry Logic', () => {
    it('should retry on network timeout (ETIMEDOUT)', async () => {
      const networkError = new Error('timeout') as AxiosError;
      networkError.code = 'ETIMEDOUT';
      (networkError as any).isAxiosError = true;

      const mockData = { success: true };

      mockedAxios.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: mockData });

      const resultPromise = fetchData('https://api.example.com/retry');

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockData);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should retry on connection reset (ECONNRESET)', async () => {
      const networkError = new Error('connection reset') as AxiosError;
      networkError.code = 'ECONNRESET';
      (networkError as any).isAxiosError = true;

      const mockData = { recovered: true };

      mockedAxios.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: mockData });

      const resultPromise = fetchData('https://api.example.com/reset');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockData);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should retry on connection refused (ECONNREFUSED)', async () => {
      const networkError = new Error('connection refused') as AxiosError;
      networkError.code = 'ECONNREFUSED';
      (networkError as any).isAxiosError = true;

      const mockData = { reconnected: true };

      mockedAxios.get
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: mockData });

      const resultPromise = fetchData('https://api.example.com/refused');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockData);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('should use exponential backoff for retries', async () => {
      const networkError = new Error('timeout') as AxiosError;
      networkError.code = 'ETIMEDOUT';
      (networkError as any).isAxiosError = true;

      const mockData = { success: true };

      mockedAxios.get
        .mockRejectedValueOnce(networkError)
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: mockData });

      const resultPromise = fetchData('https://api.example.com/backoff');

      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result).toEqual(mockData);
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('should fail after max retries (3 attempts)', async () => {
      const networkError = new Error('persistent timeout') as AxiosError;
      networkError.code = 'ETIMEDOUT';
      (networkError as any).isAxiosError = true;

      mockedAxios.get.mockRejectedValue(networkError);

      const resultPromise = fetchData('https://api.example.com/fail');
      vi.runAllTimersAsync();

      await expect(resultPromise).rejects.toThrow('persistent timeout');
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });
  });

  describe('Non-Retryable Errors', () => {
    it('should not retry on 400 Bad Request', async () => {
      const httpError = new Error('Bad Request') as AxiosError;
      httpError.response = { status: 400, data: { error: 'Invalid params' } } as any;
      (httpError as any).isAxiosError = true;

      mockedAxios.get.mockRejectedValue(httpError);

      await expect(fetchData('https://api.example.com/bad')).rejects.toThrow('Bad Request');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 404 Not Found', async () => {
      const httpError = new Error('Not Found') as AxiosError;
      httpError.response = { status: 404, data: { error: 'Resource not found' } } as any;
      (httpError as any).isAxiosError = true;

      mockedAxios.get.mockRejectedValue(httpError);

      await expect(fetchData('https://api.example.com/notfound')).rejects.toThrow('Not Found');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('should not retry on 500 Internal Server Error', async () => {
      const httpError = new Error('Internal Server Error') as AxiosError;
      httpError.response = { status: 500, data: { error: 'Server error' } } as any;
      (httpError as any).isAxiosError = true;

      mockedAxios.get.mockRejectedValue(httpError);

      await expect(fetchData('https://api.example.com/error')).rejects.toThrow('Internal Server Error');
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('Request Configuration', () => {
    it('should set correct timeout (10 seconds)', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const resultPromise = fetchData('https://api.example.com/timeout');
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeout: 10000 })
      );
    });

    it('should set User-Agent header', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const resultPromise = fetchData('https://api.example.com/agent');
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': expect.stringContaining('Mozilla'),
          }),
        })
      );
    });

    it('should force IPv4 (family: 4)', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: {} });

      const resultPromise = fetchData('https://api.example.com/ipv4');
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(mockedAxios.get).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ family: 4 })
      );
    });
  });
});
