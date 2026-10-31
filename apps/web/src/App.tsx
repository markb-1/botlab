import { HashRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Bots } from './pages/Bots';
import { BotCreate } from './pages/BotCreate';
import { BotDetail } from './pages/BotDetail';
import { BotTrades } from './pages/BotTrades';
import { Scripts } from './pages/Scripts';
import { ScriptEdit } from './pages/ScriptEdit';
import { ScriptNew } from './pages/ScriptNew';
import { Wallets } from './pages/Wallets';
import { Settings } from './pages/Settings';
import { LoginScreen } from './pages/LoginScreen';
import { Risk } from './pages/Risk';
import { Ledger } from './pages/Ledger';
import { Markets } from './pages/Markets';
import { Audit } from './pages/Audit';
import { Approvals } from './pages/Approvals';
import { ReauthDialog } from './components/ReauthDialog';
import { useAuth } from './hooks/useAuth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AppContent() {
  const { session, isLoading, error, setup, login, logout, setError } = useAuth();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0a0a]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-accent flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path d="M10 2L2 7l8 5 8-5-8-5zM2 13l8 5 8-5M2 17l8 5 8-5" />
            </svg>
          </div>
          <p className="text-sm text-gray-500">Loading...</p>
        </div>
      </div>
    );
  }

  // Auth gate: first-run setup or login
  if (!session?.authenticated) {
    return <LoginScreen session={session} onSetup={setup} onLogin={login} error={error} setError={setError} />;
  }

  // Authenticated — show main app
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <ReauthDialog />
        <Layout onLogout={logout} lockReason={session.unlocked ? null : session.lockReason ?? 'master key not loaded'}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/bots" element={<Bots />} />
            <Route path="/bots/new" element={<BotCreate />} />
            <Route path="/bots/:id" element={<BotDetail />} />
            <Route path="/bots/:id/trades" element={<BotTrades />} />
            <Route path="/scripts" element={<Scripts />} />
            <Route path="/scripts/new" element={<ScriptNew />} />
            <Route path="/scripts/:id" element={<ScriptEdit />} />
            <Route path="/wallets" element={<Wallets />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/risk" element={<Risk />} />
            <Route path="/ledger" element={<Ledger />} />
            <Route path="/markets" element={<Markets />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/approvals" element={<Approvals />} />
          </Routes>
        </Layout>
      </HashRouter>
    </QueryClientProvider>
  );
}

function App() {
  return <AppContent />;
}

export default App;
