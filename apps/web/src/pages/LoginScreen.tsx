import { useState } from 'react';
import type { SessionInfo } from '../hooks/useAuth';

interface LoginScreenProps {
  session: SessionInfo | null;
  onSetup: (password: string, setupCode?: string) => Promise<void>;
  onLogin: (password: string) => Promise<void>;
  error: string | null;
  setError: (error: string | null) => void;
}

const MIN_PASSWORD = 8;

/** First run: choose the admin password. Afterwards: log in (spec §8.2). */
export function LoginScreen({ session, onSetup, onLogin, error, setError }: LoginScreenProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setupCode, setSetupCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isSetup = session?.needsSetup ?? false;
  const needsCode = isSetup && (session?.setupCodeRequired ?? false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting || !password) return;
    if (isSetup) {
      if (password !== confirmPassword) return setError('Passwords do not match');
      if (password.length < MIN_PASSWORD) return setError(`Password must be at least ${MIN_PASSWORD} characters`);
      if (needsCode && !setupCode.trim()) return setError('Enter the setup code from the server log');
    }
    setIsSubmitting(true);
    setError(null);
    try {
      await (isSetup ? onSetup(password, needsCode ? setupCode.trim() : undefined) : onLogin(password));
    } catch {
      // error shown by the hook
    } finally {
      setIsSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2.5 bg-surface border border-[#2a2a2a] rounded-lg text-white text-sm placeholder-gray-600 focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent';

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0a0a]">
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-sm px-6">
          <div className="flex flex-col items-center mb-8">
            <img src="/icon.png" alt="BotLab" className="w-14 h-14 rounded-2xl mb-4" />
            <h1 className="text-2xl font-bold text-white">BotLab</h1>
            <p className="text-sm text-gray-500 mt-1">{isSetup ? 'First run: choose an admin password' : 'Sign in'}</p>
          </div>

          {error && (
            <div className="mb-4 bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-2.5">
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {session && !session.unlocked && (
            <div className="mb-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-4 py-2.5">
              <p className="text-sm text-yellow-300">The server is locked (master key problem). Sign in to see why, or check the server log.</p>
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            {isSetup && (
              <p className="text-sm text-gray-400">
                This password protects the web UI. Wallet keys are encrypted with the server's master key, not with this password.
              </p>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-1.5">Password</label>
              <input
                type="password"
                autoComplete={isSetup ? 'new-password' : 'current-password'}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                className={inputClass}
                autoFocus
                disabled={isSubmitting}
              />
            </div>
            {needsCode && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Setup code (printed in the server log)</label>
                <input
                  type="text"
                  autoComplete="one-time-code"
                  value={setupCode}
                  onChange={(e) => {
                    setSetupCode(e.target.value);
                    setError(null);
                  }}
                  placeholder="ABCD-EFGH"
                  className={inputClass}
                  disabled={isSubmitting}
                />
              </div>
            )}
            {isSetup && (
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-1.5">Confirm password</label>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    setError(null);
                  }}
                  className={inputClass}
                  disabled={isSubmitting}
                />
              </div>
            )}
            <button
              type="submit"
              disabled={isSubmitting || !password || (isSetup && !confirmPassword)}
              className="w-full py-2.5 text-sm font-medium text-white bg-accent rounded-lg hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isSubmitting ? 'Please wait...' : isSetup ? 'Set password' : 'Sign in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
