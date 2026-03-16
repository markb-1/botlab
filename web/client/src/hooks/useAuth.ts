import { useState, useEffect, useCallback } from 'react';
import { authApi } from '../lib/electronApi';

export interface AuthStatus {
  needsSetup: boolean;
  hasPassword: boolean;
  unlocked: boolean;
}

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Fetch auth status and attempt auto-unlock on mount
  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const s = await authApi.status();
        if (cancelled) return;

        // If already unlocked (shouldn't happen on fresh launch, but guard)
        if (s.unlocked) {
          setStatus(s);
          setIsLoading(false);
          return;
        }

        // Try auto-unlock (works for skipped-password setups)
        if (!s.needsSetup && !s.hasPassword) {
          const result = await authApi.autoUnlock();
          if (cancelled) return;
          if (result.unlocked) {
            setStatus({ ...s, unlocked: true });
            setIsLoading(false);
            return;
          }
        }

        setStatus(s);
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message || 'Failed to check auth status');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    checkAuth();
    return () => { cancelled = true; };
  }, []);

  const setup = useCallback(async (data: { password?: string; skip?: boolean }) => {
    setError(null);
    try {
      const result = await authApi.setup(data);
      if (result.unlocked) {
        setStatus((prev) => prev ? { ...prev, unlocked: true, needsSetup: false } : null);
      }
      return result;
    } catch (err: any) {
      const msg = err.message || 'Setup failed';
      setError(msg);
      throw err;
    }
  }, []);

  const unlock = useCallback(async (data: { password: string }) => {
    setError(null);
    try {
      const result = await authApi.unlock(data);
      if (result.unlocked) {
        setStatus((prev) => prev ? { ...prev, unlocked: true } : null);
      }
      return result;
    } catch (err: any) {
      const msg = err.message || 'Unlock failed';
      setError(msg);
      throw err;
    }
  }, []);

  return { status, isLoading, error, setup, unlock, setError };
}
