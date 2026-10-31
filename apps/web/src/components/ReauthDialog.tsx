import { useEffect, useRef, useState } from 'react';
import { authApi, setReauthHandler } from '../lib/api';

/**
 * Password prompt for human-only admin actions (clear halt, config writes, ...) when the last password
 * check is older than 15 minutes (spec §8.2). The API client calls it on `reauth_required` and retries.
 */
export function ReauthDialog() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setReauthHandler(
      () =>
        new Promise<boolean>((resolve) => {
          resolver.current?.(false);
          resolver.current = resolve;
          setPassword('');
          setError(null);
          setOpen(true);
        })
    );
    return () => setReauthHandler(null);
  }, []);

  const finish = (ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpen(false);
    setPassword('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    try {
      await authApi.reauth({ password });
      finish(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong password');
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form onSubmit={submit} className="w-full max-w-sm bg-[#1a1a1a] border border-[#2a2a2a] rounded-xl p-6 space-y-4">
        <h3 className="text-lg font-medium text-white">Confirm your password</h3>
        <p className="text-sm text-gray-400">This action is reserved for the human admin and needs a password check within the last 15 minutes.</p>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <input
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full px-3 py-2.5 bg-surface border border-[#2a2a2a] rounded-lg text-white text-sm focus:outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => finish(false)} className="px-3 py-2 border border-[#333] rounded-lg text-sm text-gray-300 hover:bg-[#222]">
            Cancel
          </button>
          <button type="submit" disabled={busy || !password} className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50">
            {busy ? 'Checking...' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  );
}
