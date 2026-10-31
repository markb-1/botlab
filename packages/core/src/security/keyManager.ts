/**
 * Simple in-memory key holder.
 * The encryption key is derived from the user's password (or fallback)
 * by passwordManager and set here after authentication.
 */
export class KeyManager {
  private encryptionKey: string | null = null;

  /**
   * Set the encryption key (called after successful auth).
   */
  setKey(key: string): void {
    this.encryptionKey = key;
  }

  /**
   * Get the current encryption key.
   * Throws if auth hasn't completed yet.
   */
  getKey(): string {
    if (!this.encryptionKey) {
      throw new Error('Encryption key not set. Complete authentication first.');
    }
    return this.encryptionKey;
  }

  /**
   * Check if the key has been set (auth completed).
   */
  isReady(): boolean {
    return this.encryptionKey !== null;
  }

  /**
   * Clear the key (for lock/logout).
   */
  clear(): void {
    this.encryptionKey = null;
  }
}

export const keyManager = new KeyManager();
