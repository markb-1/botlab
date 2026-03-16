import { useState } from 'react';
import type { AuthStatus } from '../hooks/useAuth';

interface UnlockScreenProps {
  status: AuthStatus;
  onSetup: (data: { password?: string; skip?: boolean }) => Promise<any>;
  onUnlock: (data: { password: string }) => Promise<any>;
  error: string | null;
  setError: (error: string | null) => void;
}

export function UnlockScreen({ status, onSetup, onUnlock, error, setError }: UnlockScreenProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSetup = status.needsSetup;

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onSetup({ password });
    } catch {
      // Error is set by the hook
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSkip = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onSetup({ skip: true });
    } catch {
      // Error is set by the hook
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || !password) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onUnlock({ password });
    } catch {
      // Error is set by the hook
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0a0a]">
      {/* Drag region for window title bar */}
      <div className="drag-region fixed top-0 left-0 right-0 h-10 z-50" />

      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm px-6">
          {/* Logo */}
          <div className="flex flex-col items-center mb-8">
            <img src="./icon.png" alt="BotLab" className="w-14 h-14 rounded-2xl mb-4" />
            <h1 className="text-2xl font-bold text-white">BotLab</h1>
            <p className="text-sm text-gray-500 mt-1">
              {isSetup ? 'Set up your vault' : 'Welcome back'}
            </p>
          </div>

          {/* Error message */}
          {error && (
            <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {isSetup ? (
            /* Setup mode */
            <form onSubmit={handleSetup} className="space-y-4">
              <div>
                <p className="text-sm text-gray-400 mb-4">
                  Protect your wallet keys with a password. This password encrypts your private keys locally.
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  placeholder="Enter a password"
                  className="w-full px-3 py-2.5 bg-surface border border-[#2a2a2a] rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Confirm Password
                </label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => { setConfirmPassword(e.target.value); setError(null); }}
                  placeholder="Confirm your password"
                  className="w-full px-3 py-2.5 bg-surface border border-[#2a2a2a] rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  disabled={isSubmitting}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !password || !confirmPassword}
                className="w-full py-2.5 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? 'Setting up...' : 'Set Password'}
              </button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={handleSkip}
                  disabled={isSubmitting}
                  className="text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                >
                  Skip for now
                </button>
                <p className="text-xs text-gray-600 mt-1">
                  Your keys will be encrypted with a default key
                </p>
              </div>
            </form>
          ) : (
            /* Unlock mode */
            <form onSubmit={handleUnlock} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(null); }}
                  placeholder="Enter your password"
                  className="w-full px-3 py-2.5 bg-surface border border-[#2a2a2a] rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent"
                  autoFocus
                  disabled={isSubmitting}
                />
              </div>

              <button
                type="submit"
                disabled={isSubmitting || !password}
                className="w-full py-2.5 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? 'Unlocking...' : 'Unlock'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
