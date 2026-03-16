import { describe, it, expect } from 'vitest';
import {
  generateSalt,
  deriveEncryptionKey,
  hashForVerification,
  verifyPassword,
  FALLBACK_PASSWORD,
} from '../../electron/security/passwordManager';

describe('passwordManager', () => {
  describe('generateSalt()', () => {
    it('should return a 64-char hex string (32 bytes)', () => {
      const salt = generateSalt();
      expect(salt).toHaveLength(64);
      expect(salt).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique salts', () => {
      const salts = new Set(Array.from({ length: 10 }, () => generateSalt()));
      expect(salts.size).toBe(10);
    });
  });

  describe('deriveEncryptionKey()', () => {
    it('should return a 64-char hex string (256-bit key)', () => {
      const salt = generateSalt();
      const key = deriveEncryptionKey('test-password', salt);
      expect(key).toHaveLength(64);
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for same password and salt', () => {
      const salt = generateSalt();
      const key1 = deriveEncryptionKey('my-password', salt);
      const key2 = deriveEncryptionKey('my-password', salt);
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different passwords', () => {
      const salt = generateSalt();
      const key1 = deriveEncryptionKey('password-a', salt);
      const key2 = deriveEncryptionKey('password-b', salt);
      expect(key1).not.toBe(key2);
    });

    it('should produce different keys for different salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const key1 = deriveEncryptionKey('same-password', salt1);
      const key2 = deriveEncryptionKey('same-password', salt2);
      expect(key1).not.toBe(key2);
    });

    it('should handle empty password', () => {
      const salt = generateSalt();
      const key = deriveEncryptionKey('', salt);
      expect(key).toHaveLength(64);
    });

    it('should handle special characters in password', () => {
      const salt = generateSalt();
      const key = deriveEncryptionKey('p@$$w0rd!#%^&*()', salt);
      expect(key).toHaveLength(64);
    });

    it('should handle unicode password', () => {
      const salt = generateSalt();
      const key = deriveEncryptionKey('密码🔐', salt);
      expect(key).toHaveLength(64);
    });
  });

  describe('hashForVerification()', () => {
    it('should return a 64-char hex string', () => {
      const salt = generateSalt();
      const hash = hashForVerification('password', salt);
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should be deterministic for same inputs', () => {
      const salt = generateSalt();
      const hash1 = hashForVerification('password', salt);
      const hash2 = hashForVerification('password', salt);
      expect(hash1).toBe(hash2);
    });

    it('should differ from encryption key for same password/salt', () => {
      const salt = generateSalt();
      const hash = hashForVerification('password', salt);
      const key = deriveEncryptionKey('password', salt);
      expect(hash).not.toBe(key);
    });

    it('should produce different hashes for different passwords', () => {
      const salt = generateSalt();
      const hash1 = hashForVerification('password-a', salt);
      const hash2 = hashForVerification('password-b', salt);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('verifyPassword()', () => {
    it('should return true for correct password', () => {
      const salt = generateSalt();
      const hash = hashForVerification('correct-password', salt);
      expect(verifyPassword('correct-password', hash, salt)).toBe(true);
    });

    it('should return false for incorrect password', () => {
      const salt = generateSalt();
      const hash = hashForVerification('correct-password', salt);
      expect(verifyPassword('wrong-password', hash, salt)).toBe(false);
    });

    it('should return false for empty password when original was not empty', () => {
      const salt = generateSalt();
      const hash = hashForVerification('my-password', salt);
      expect(verifyPassword('', hash, salt)).toBe(false);
    });

    it('should verify fallback password', () => {
      const salt = generateSalt();
      const hash = hashForVerification(FALLBACK_PASSWORD, salt);
      expect(verifyPassword(FALLBACK_PASSWORD, hash, salt)).toBe(true);
    });

    it('should fail for wrong salt', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const hash = hashForVerification('password', salt1);
      expect(verifyPassword('password', hash, salt2)).toBe(false);
    });
  });

  describe('FALLBACK_PASSWORD', () => {
    it('should be a non-empty string', () => {
      expect(FALLBACK_PASSWORD).toBeTruthy();
      expect(typeof FALLBACK_PASSWORD).toBe('string');
    });
  });
});
