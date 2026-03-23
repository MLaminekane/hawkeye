import { Outlet, Link, useLocation } from 'react-router-dom';
import { useState, useCallback, useEffect } from 'react';
import { hawkeyeWs } from '../api';

function useTheme() {
  const [isDark, setIsDark] = useState(() => !document.documentElement.classList.contains('light'));

  const toggle = useCallback(() => {
    const next = isDark ? 'light' : 'dark';
    document.documentElement.classList.remove('dark', 'light');
    document.documentElement.classList.add(next);
    localStorage.setItem('hawkeye-theme', next);
    setIsDark(next === 'dark');
  }, [isDark]);

  return { isDark, toggle };
}

// Module-level so badge persists across navigations
let globalBlockedCount = 0;

function useFirewallBadge() {
  const [blockedCount, setBlockedCount] = useState(globalBlockedCount);

  useEffect(() => {
    const unsub = hawkeyeWs.subscribe((msg) => {
      if (msg.type === 'action_stream') {
        if (msg.risk === 'critical' || msg.risk === 'high') {
          globalBlockedCount++;
          setBlockedCount(globalBlockedCount);
        }
      }
      if (msg.type === 'impact_preview' && (msg.impact.risk === 'critical' || msg.impact.risk === 'high')) {
        globalBlockedCount++;
        setBlockedCount(globalBlockedCount);
      }
    });
    return unsub;
  }, []);

  const clear = useCallback(() => {
    globalBlockedCount = 0;
    setBlockedCount(0);
  }, []);

  return { blockedCount, clear };
}

export function Layout() {
  const location = useLocation();
  const { isDark, toggle } = useTheme();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const { blockedCount, clear: clearBadge } = useFirewallBadge();

  // Clear badge when viewing the firewall page
  useEffect(() => {
    if (location.pathname === '/firewall') clearBadge();
  }, [location.pathname, clearBadge]);

  const navLinks = [
    { to: '/', label: 'Sessions' },
    { to: '/firewall', label: 'Firewall' },
    { to: '/compare', label: 'Compare' },
    { to: '/tasks', label: 'Tasks' },
    { to: '/swarm', label: 'Agents' },
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <div className="relative min-h-screen bg-hawk-bg">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-24 top-12 h-64 w-64 rounded-full bg-hawk-orange/10 blur-3xl" />
        <div className="absolute right-[-70px] top-32 h-72 w-72 rounded-full bg-hawk-green/10 blur-3xl" />
      </div>

      <nav className="sticky top-0 z-50 border-b border-hawk-border-subtle bg-hawk-bg/75 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 sm:py-3.5">
          <Link to="/" className="flex shrink-0 items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-hawk-orange text-xs font-bold text-black shadow-[0_0_0_3px_rgba(255,107,43,0.18)]">
              H
            </div>
            <span className="hidden font-display text-base font-semibold tracking-wide text-hawk-text sm:inline">
              Hawkeye-ai
            </span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden items-center gap-1.5 rounded-xl border border-hawk-border-subtle bg-hawk-surface/65 p-1 font-mono text-xs text-hawk-text3 shadow-sm md:flex">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`relative rounded-lg px-3 py-1.5 transition-all hover:text-hawk-text ${
                  location.pathname === link.to
                    ? 'bg-hawk-surface2 text-hawk-orange shadow-sm'
                    : ''
                }`}
              >
                {link.label}
                {link.to === '/firewall' && blockedCount > 0 && (
                  <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white shadow-sm">
                    {blockedCount > 99 ? '99+' : blockedCount}
                  </span>
                )}
              </Link>
            ))}
            <button
              onClick={toggle}
              className="ml-1 rounded-lg p-1.5 text-hawk-text3 transition-colors hover:bg-hawk-surface2 hover:text-hawk-text"
              title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {isDark ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
          </div>

          {/* Mobile: burger menu */}
          <div className="flex items-center gap-2 md:hidden">
            {/* Firewall badge for mobile */}
            {blockedCount > 0 && (
              <Link
                to="/firewall"
                className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-bold text-white"
              >
                {blockedCount > 99 ? '99+' : blockedCount}
              </Link>
            )}
            <button
              onClick={toggle}
              className="shrink-0 rounded-lg p-1.5 text-hawk-text3 transition-colors hover:bg-hawk-surface2 hover:text-hawk-text"
            >
              {isDark ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="shrink-0 rounded-lg p-1.5 text-hawk-text3 transition-colors hover:bg-hawk-surface2 hover:text-hawk-text"
              aria-label="Menu"
            >
              {mobileMenuOpen ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
              )}
            </button>
          </div>
        </div>

        {/* Mobile dropdown */}
        {mobileMenuOpen && (
          <div className="border-t border-hawk-border-subtle bg-hawk-surface/95 backdrop-blur-xl md:hidden">
            <div className="mx-auto flex max-w-6xl flex-col gap-0.5 px-4 py-2">
              {navLinks.map((link) => (
                <Link
                  key={link.to}
                  to={link.to}
                  onClick={() => setMobileMenuOpen(false)}
                  className={`flex items-center justify-between rounded-lg px-3 py-2.5 font-mono text-sm transition-all ${
                    location.pathname === link.to
                      ? 'bg-hawk-surface2 text-hawk-orange'
                      : 'text-hawk-text3 hover:bg-hawk-surface2 hover:text-hawk-text'
                  }`}
                >
                  {link.label}
                  {link.to === '/firewall' && blockedCount > 0 && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                      {blockedCount > 99 ? '99+' : blockedCount}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          </div>
        )}
      </nav>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
        <Outlet />
      </main>
    </div>
  );
}
