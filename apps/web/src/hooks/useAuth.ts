import { useState, useEffect, useCallback } from 'react';
import { authApi, closeEvents, setUnauthenticatedHandler, type SessionInfo } from '../lib/api';

export type { SessionInfo };

/** Session state for the app shell: first-run setup, login, logout (spec §8.2). */
export function useAuth() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSession(await authApi.session());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach the server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // A request answered 401 (session expired or revoked): back to the login screen
    setUnauthenticatedHandler(() => {
      closeEvents();
      setSession((prev) => (prev ? { ...prev, authenticated: false, scope: null, recentAuth: false } : prev));
    });
    return () => setUnauthenticatedHandler(null);
  }, [refresh]);

  const run = useCallback(async (fn: () => Promise<SessionInfo>, fallback: string) => {
    setError(null);
    try {
      setSession(await fn());
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
      throw err;
    }
  }, []);

  const setup = useCallback((password: string) => run(() => authApi.setup({ password }), 'Setup failed'), [run]);
  const login = useCallback((password: string) => run(() => authApi.login({ password }), 'Login failed'), [run]);

  const logout = useCallback(async () => {
    closeEvents();
    try {
      await authApi.logout();
    } finally {
      await refresh();
    }
  }, [refresh]);

  return { session, isLoading, error, setError, setup, login, logout, refresh };
}
