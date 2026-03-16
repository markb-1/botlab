/**
 * Error Resilience Tests: Invalid Data Handling
 *
 * Tests for handling malformed responses, missing fields,
 * and unexpected data formats from APIs.
 */

import { describe, it, expect } from 'vitest';

describe('Invalid Data Handling', () => {
  describe('Malformed JSON Responses', () => {
    it('should handle null response gracefully', () => {
      const parseResponse = (data: any): any[] => {
        if (data === null || data === undefined) {
          return [];
        }
        return Array.isArray(data) ? data : [];
      };

      expect(parseResponse(null)).toEqual([]);
      expect(parseResponse(undefined)).toEqual([]);
      expect(parseResponse([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it('should handle unexpected data types', () => {
      const parseArrayResponse = (data: any): any[] => {
        if (Array.isArray(data)) return data;
        if (typeof data === 'object' && data !== null) {
          // Maybe it's wrapped in an object
          if (Array.isArray(data.data)) return data.data;
          if (Array.isArray(data.results)) return data.results;
          if (Array.isArray(data.items)) return data.items;
        }
        return [];
      };

      expect(parseArrayResponse([1, 2, 3])).toEqual([1, 2, 3]);
      expect(parseArrayResponse({ data: [1, 2, 3] })).toEqual([1, 2, 3]);
      expect(parseArrayResponse({ results: [1, 2, 3] })).toEqual([1, 2, 3]);
      expect(parseArrayResponse('string')).toEqual([]);
      expect(parseArrayResponse(123)).toEqual([]);
    });

    it('should handle empty object response', () => {
      const isEmpty = (obj: any): boolean => {
        if (!obj) return true;
        if (Array.isArray(obj)) return obj.length === 0;
        if (typeof obj === 'object') return Object.keys(obj).length === 0;
        return false;
      };

      expect(isEmpty({})).toBe(true);
      expect(isEmpty([])).toBe(true);
      expect(isEmpty(null)).toBe(true);
      expect(isEmpty(undefined)).toBe(true);
      expect(isEmpty({ key: 'value' })).toBe(false);
      expect(isEmpty([1])).toBe(false);
    });
  });

  describe('Missing Required Fields', () => {
    it('should validate trade activity fields', () => {
      interface TradeActivity {
        timestamp: number;
        type: string;
        side: string;
        usdcSize: number;
        price: number;
        conditionId: string;
      }

      const requiredFields = ['timestamp', 'type', 'side', 'usdcSize', 'price', 'conditionId'];

      const validateActivity = (activity: any): { valid: boolean; missing: string[] } => {
        const missing = requiredFields.filter((f) => activity[f] === undefined || activity[f] === null);
        return { valid: missing.length === 0, missing };
      };

      const validActivity = {
        timestamp: 1704067200,
        type: 'TRADE',
        side: 'BUY',
        usdcSize: 100,
        price: 0.65,
        conditionId: 'abc123',
      };

      const invalidActivity = {
        timestamp: 1704067200,
        type: 'TRADE',
        // Missing: side, usdcSize, price, conditionId
      };

      expect(validateActivity(validActivity).valid).toBe(true);
      expect(validateActivity(invalidActivity).valid).toBe(false);
      expect(validateActivity(invalidActivity).missing).toContain('side');
      expect(validateActivity(invalidActivity).missing).toContain('usdcSize');
    });

    it('should validate market data fields', () => {
      const validateMarket = (market: any): boolean => {
        const requiredFields = ['conditionId', 'question', 'outcomes', 'outcomePrices'];
        return requiredFields.every((f) => market[f] !== undefined && market[f] !== null);
      };

      const validMarket = {
        conditionId: 'abc123',
        question: 'Will X happen?',
        outcomes: '["Yes","No"]',
        outcomePrices: '["0.65","0.35"]',
      };

      const invalidMarket = {
        conditionId: 'abc123',
        question: 'Will X happen?',
        // Missing outcomes and prices
      };

      expect(validateMarket(validMarket)).toBe(true);
      expect(validateMarket(invalidMarket)).toBe(false);
    });

    it('should provide default values for optional fields', () => {
      interface Position {
        size: number;
        avgPrice: number;
        currentValue: number;
        cashPnl: number;
        title?: string;
        outcome?: string;
      }

      const normalizePosition = (raw: any): Position => ({
        size: raw.size ?? 0,
        avgPrice: raw.avgPrice ?? 0,
        currentValue: raw.currentValue ?? 0,
        cashPnl: raw.cashPnl ?? 0,
        title: raw.title ?? 'Unknown Market',
        outcome: raw.outcome ?? 'Unknown',
      });

      const rawPosition = {
        size: 100,
        avgPrice: 0.65,
        // Missing other fields
      };

      const normalized = normalizePosition(rawPosition);

      expect(normalized.size).toBe(100);
      expect(normalized.currentValue).toBe(0);
      expect(normalized.title).toBe('Unknown Market');
    });
  });

  describe('Invalid Field Values', () => {
    it('should handle NaN in numeric fields', () => {
      const safeNumber = (value: any, defaultValue = 0): number => {
        const num = Number(value);
        return Number.isNaN(num) ? defaultValue : num;
      };

      expect(safeNumber(100)).toBe(100);
      expect(safeNumber('100')).toBe(100);
      expect(safeNumber(NaN)).toBe(0);
      expect(safeNumber('not-a-number')).toBe(0);
      expect(safeNumber(undefined)).toBe(0);
      expect(safeNumber(null)).toBe(0);
      expect(safeNumber('', 10)).toBe(0); // Empty string converts to 0
    });

    it('should handle invalid JSON strings in array fields', () => {
      const safeParseArray = (jsonString: string): any[] => {
        try {
          const parsed = JSON.parse(jsonString);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      };

      expect(safeParseArray('["Yes","No"]')).toEqual(['Yes', 'No']);
      expect(safeParseArray('invalid-json')).toEqual([]);
      expect(safeParseArray('')).toEqual([]);
      expect(safeParseArray('{}')).toEqual([]);
      expect(safeParseArray('null')).toEqual([]);
    });

    it('should handle invalid timestamp values', () => {
      const safeTimestamp = (value: any): number | null => {
        if (!value) return null;

        const num = Number(value);
        if (Number.isNaN(num)) return null;

        // Check if it's a reasonable timestamp (after 2020, before 2100)
        const minTimestamp = 1577836800; // 2020-01-01
        const maxTimestamp = 4102444800; // 2100-01-01

        // Handle milliseconds vs seconds
        let timestamp = num;
        if (num > 1e12) {
          timestamp = Math.floor(num / 1000);
        }

        if (timestamp < minTimestamp || timestamp > maxTimestamp) {
          return null;
        }

        return timestamp;
      };

      expect(safeTimestamp(1704067200)).toBe(1704067200);
      expect(safeTimestamp(1704067200000)).toBe(1704067200); // Milliseconds
      expect(safeTimestamp('1704067200')).toBe(1704067200);
      expect(safeTimestamp(0)).toBeNull();
      expect(safeTimestamp(-1)).toBeNull();
      expect(safeTimestamp('invalid')).toBeNull();
      expect(safeTimestamp(null)).toBeNull();
    });

    it('should handle invalid price values', () => {
      const validatePrice = (price: any): { valid: boolean; normalized: number } => {
        const num = Number(price);

        if (Number.isNaN(num)) {
          return { valid: false, normalized: 0 };
        }

        // Prices should be between 0 and 1 (or 0 and 100 for percentage)
        if (num < 0) {
          return { valid: false, normalized: 0 };
        }

        if (num > 1 && num <= 100) {
          // Probably a percentage, convert to decimal
          return { valid: true, normalized: num / 100 };
        }

        if (num > 100) {
          return { valid: false, normalized: 0 };
        }

        return { valid: true, normalized: num };
      };

      expect(validatePrice(0.65)).toEqual({ valid: true, normalized: 0.65 });
      expect(validatePrice(65)).toEqual({ valid: true, normalized: 0.65 }); // Percentage
      expect(validatePrice(-0.5)).toEqual({ valid: false, normalized: 0 });
      expect(validatePrice(150)).toEqual({ valid: false, normalized: 0 });
      expect(validatePrice('abc')).toEqual({ valid: false, normalized: 0 });
    });

    it('should handle invalid Ethereum addresses', () => {
      const isValidAddress = (address: any): boolean => {
        if (typeof address !== 'string') return false;
        return /^0x[a-fA-F0-9]{40}$/i.test(address);
      };

      expect(isValidAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe(true);
      expect(isValidAddress('0x123')).toBe(false);
      expect(isValidAddress('not-an-address')).toBe(false);
      expect(isValidAddress(null)).toBe(false);
      expect(isValidAddress(undefined)).toBe(false);
      expect(isValidAddress(123)).toBe(false);
    });
  });

  describe('Data Sanitization', () => {
    it('should sanitize string fields', () => {
      const sanitizeString = (value: any, maxLength = 500): string => {
        if (typeof value !== 'string') {
          return String(value ?? '');
        }
        return value.trim().substring(0, maxLength);
      };

      expect(sanitizeString('  hello world  ')).toBe('hello world');
      expect(sanitizeString(123)).toBe('123');
      expect(sanitizeString(null)).toBe('');
      expect(sanitizeString('a'.repeat(1000), 100)).toBe('a'.repeat(100));
    });

    it('should sanitize array fields', () => {
      const sanitizeArray = <T>(arr: any, validator: (item: any) => T | null): T[] => {
        if (!Array.isArray(arr)) return [];
        return arr.map(validator).filter((item): item is T => item !== null);
      };

      const validateNumber = (n: any): number | null => {
        // Filter out null, undefined, and non-numeric strings
        if (n === null || n === undefined) return null;
        const num = Number(n);
        return Number.isNaN(num) ? null : num;
      };

      expect(sanitizeArray([1, 2, 'invalid', 3], validateNumber)).toEqual([1, 2, 3]);
      expect(sanitizeArray('not-array', validateNumber)).toEqual([]);
      expect(sanitizeArray([null, undefined, 5], validateNumber)).toEqual([5]);
    });

    it('should remove unexpected fields from objects', () => {
      const allowedFields = ['id', 'name', 'value'];

      const sanitizeObject = (obj: any): Record<string, any> => {
        if (typeof obj !== 'object' || obj === null) return {};

        const sanitized: Record<string, any> = {};
        for (const field of allowedFields) {
          if (obj[field] !== undefined) {
            sanitized[field] = obj[field];
          }
        }
        return sanitized;
      };

      const input = {
        id: 1,
        name: 'Test',
        value: 100,
        malicious: '<script>alert("xss")</script>',
        extra: 'unwanted',
      };

      const sanitized = sanitizeObject(input);

      expect(sanitized).toEqual({ id: 1, name: 'Test', value: 100 });
      expect(sanitized).not.toHaveProperty('malicious');
      expect(sanitized).not.toHaveProperty('extra');
    });
  });

  describe('Batch Data Validation', () => {
    it('should filter out invalid items from batch', () => {
      interface ValidTrade {
        id: string;
        amount: number;
        timestamp: number;
      }

      const validateTrade = (trade: any): ValidTrade | null => {
        if (!trade.id || typeof trade.id !== 'string') return null;
        if (typeof trade.amount !== 'number' || trade.amount <= 0) return null;
        if (typeof trade.timestamp !== 'number' || trade.timestamp <= 0) return null;
        return trade as ValidTrade;
      };

      const trades = [
        { id: 'trade-1', amount: 100, timestamp: 1704067200 },
        { id: null, amount: 100, timestamp: 1704067200 }, // Invalid id
        { id: 'trade-2', amount: -50, timestamp: 1704067200 }, // Invalid amount
        { id: 'trade-3', amount: 200, timestamp: 1704067200 },
        { amount: 100, timestamp: 1704067200 }, // Missing id
      ];

      const validTrades = trades.map(validateTrade).filter((t): t is ValidTrade => t !== null);

      expect(validTrades.length).toBe(2);
      expect(validTrades[0].id).toBe('trade-1');
      expect(validTrades[1].id).toBe('trade-3');
    });

    it('should report validation statistics', () => {
      interface ValidationResult {
        total: number;
        valid: number;
        invalid: number;
        errors: string[];
      }

      const validateBatch = (items: any[]): ValidationResult => {
        const result: ValidationResult = {
          total: items.length,
          valid: 0,
          invalid: 0,
          errors: [],
        };

        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item.id) {
            result.errors.push(`Item ${i}: missing id`);
            result.invalid++;
          } else if (!item.value) {
            result.errors.push(`Item ${i}: missing value`);
            result.invalid++;
          } else {
            result.valid++;
          }
        }

        return result;
      };

      const items = [
        { id: 1, value: 'a' },
        { value: 'b' }, // Missing id
        { id: 2, value: 'c' },
        { id: 3 }, // Missing value
      ];

      const result = validateBatch(items);

      expect(result.total).toBe(4);
      expect(result.valid).toBe(2);
      expect(result.invalid).toBe(2);
      expect(result.errors.length).toBe(2);
    });
  });
});
