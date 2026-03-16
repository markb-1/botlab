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
import { UnlockScreen } from './pages/UnlockScreen';
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
  const { status, isLoading, error, setup, unlock, setError } = useAuth();

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0a0a0a]">
        <div className="drag-region fixed top-0 left-0 right-0 h-10 z-50" />
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

  // Auth gate: show unlock/setup screen if not unlocked
  if (!status?.unlocked) {
    return (
      <UnlockScreen
        status={status || { needsSetup: true, hasPassword: false, unlocked: false }}
        onSetup={setup}
        onUnlock={unlock}
        error={error}
        setError={setError}
      />
    );
  }

  // Authenticated — show main app
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <Layout>
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
