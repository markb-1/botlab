import { useState, type ReactNode } from 'react';
import { useLiveUpdates } from '../hooks/useLiveUpdates';
import { Link, useLocation } from 'react-router-dom';

interface LayoutProps {
  children: ReactNode;
  onLogout: () => void;
  /** Set when the server runs without its master key (wallets and bots unavailable) */
  lockReason: string | null;
}

const navItems = [
  {
    path: '/',
    label: 'Dashboard',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10-1a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1h-4a1 1 0 01-1-1v-5z" />
      </svg>
    ),
  },
  {
    path: '/bots',
    label: 'Bots',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  {
    path: '/scripts',
    label: 'Scripts',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
      </svg>
    ),
  },
  {
    path: '/ledger',
    label: 'Ledger',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 17v-6m4 6V7m4 10v-3M4 19h16M4 5h16" />
      </svg>
    ),
  },
  {
    path: '/markets',
    label: 'Markets',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 3v18h18M7 15l4-4 3 3 5-6" />
      </svg>
    ),
  },
  {
    path: '/risk',
    label: 'Risk',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 3l8 4v5c0 4.5-3.4 8.4-8 9-4.6-.6-8-4.5-8-9V7l8-4z" />
      </svg>
    ),
  },
  {
    path: '/agent',
    label: 'Agent',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 3v2m6-2v2M9 19v2m6-2v2M3 9h2m-2 6h2m14-6h2m-2 6h2M7 5h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2zm3 5h4v4h-4v-4z" />
      </svg>
    ),
  },
  {
    path: '/audit',
    label: 'Audit',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5h10M9 12h10M9 19h10M5 5h.01M5 12h.01M5 19h.01" />
      </svg>
    ),
  },
  {
    path: '/approvals',
    label: 'Approvals',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    path: '/wallets',
    label: 'Wallets',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 110-6h2.25A2.25 2.25 0 0021 6V4.5A2.25 2.25 0 0018.75 2.25H5.25A2.25 2.25 0 003 4.5v15A2.25 2.25 0 005.25 21.75h13.5A2.25 2.25 0 0021 19.5v-1.5a2.25 2.25 0 00-2.25-2.25H15a3 3 0 010-6h3.75A2.25 2.25 0 0021 12z" />
      </svg>
    ),
  },
];

const bottomItems = [
  {
    path: '/settings',
    label: 'Settings',
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
];

export function Layout({ children, onLogout, lockReason }: LayoutProps) {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  useLiveUpdates();

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  const renderNavItem = (item: (typeof navItems)[0]) => {
    const active = isActive(item.path);
    return (
      <Link
        key={item.path}
        to={item.path}
        onClick={() => setMenuOpen(false)}
        className={`flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          active ? 'bg-accent-muted text-accent' : 'text-gray-400 hover:text-gray-200 hover:bg-sidebar-hover'
        }`}
      >
        <span className={active ? 'text-accent' : 'text-gray-500'}>{item.icon}</span>
        {item.label}
      </Link>
    );
  };

  const sidebar = (
    <>
      {/* Logo */}
      <div className="h-14 flex items-center justify-between px-5 border-b border-[#1a1a1a]">
        <div className="flex items-center gap-2.5">
          <img src="/icon.png" alt="BotLab" className="w-7 h-7 rounded-lg" />
          <span className="text-white font-semibold text-sm tracking-tight">BotLab</span>
        </div>
        <button type="button" className="md:hidden text-gray-500 hover:text-gray-200 text-2xl leading-none" onClick={() => setMenuOpen(false)} aria-label="Close menu">
          ×
        </button>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <p className="px-4 mb-2 text-[10px] font-semibold uppercase tracking-widest text-gray-600">Navigation</p>
        {navItems.map(renderNavItem)}
      </nav>

      {/* Bottom nav */}
      <div className="px-3 pb-4 space-y-1 border-t border-[#1a1a1a] pt-3">
        {bottomItems.map(renderNavItem)}
        <button
          type="button"
          onClick={onLogout}
          className="w-full flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-200 hover:bg-sidebar-hover transition-colors"
        >
          Log out
        </button>
      </div>
    </>
  );

  const current = [...navItems, ...bottomItems].find((i) => isActive(i.path));

  return (
    <div className="flex h-screen overflow-hidden bg-[#0a0a0a]">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex w-[220px] flex-shrink-0 bg-sidebar flex-col border-r border-[#1a1a1a]">{sidebar}</aside>

      {/* Drawer (phones) */}
      {menuOpen && (
        <div className="md:hidden fixed inset-0 z-30 flex">
          <aside className="w-[240px] bg-sidebar flex flex-col border-r border-[#1a1a1a]">{sidebar}</aside>
          <button type="button" className="flex-1 bg-black/60" aria-label="Close menu" onClick={() => setMenuOpen(false)} />
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top bar (phones) */}
        <div className="md:hidden h-12 flex-shrink-0 flex items-center gap-3 px-4 border-b border-[#1a1a1a] bg-sidebar">
          <button type="button" onClick={() => setMenuOpen(true)} className="text-gray-300" aria-label="Open menu">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="text-white font-semibold text-sm">{current?.label ?? 'BotLab'}</span>
        </div>
        {lockReason && (
          <div className="flex-shrink-0 bg-yellow-500/10 border-b border-yellow-500/20 px-4 md:px-8 py-2 text-sm text-yellow-300">
            Server locked: {lockReason}. Bots and wallets are unavailable until the server starts with the right master key.
          </div>
        )}
        <div className="h-4 md:h-6 flex-shrink-0" />

        {/* Scrollable content */}
        <main className="flex-1 overflow-y-auto px-4 md:px-8 pb-8">{children}</main>
      </div>
    </div>
  );
}
