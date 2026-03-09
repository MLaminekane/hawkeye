import { Outlet, Link, useLocation } from 'react-router-dom';
import { useState, useCallback } from 'react';

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

export function Layout() {
  const location = useLocation();
  const { isDark, toggle } = useTheme();

  const navLinks = [
    { to: '/', label: 'Sessions' },
    { to: '/live', label: 'Live' },
    { to: '/compare', label: 'Compare' },
    { to: '/settings', label: 'Settings' },
  ];

  return (
    <div className="relative min-h-screen bg-hawk-bg">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -left-24 top-12 h-64 w-64 rounded-full bg-hawk-orange/10 blur-3xl" />
        <div className="absolute right-[-70px] top-32 h-72 w-72 rounded-full bg-hawk-green/10 blur-3xl" />
      </div>

      <nav className="sticky top-0 z-50 border-b border-hawk-border-subtle bg-hawk-bg/75 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-hawk-orange text-xs font-bold text-black shadow-[0_0_0_3px_rgba(255,107,43,0.18)]">
              H
            </div>
            <span className="font-display text-base font-semibold tracking-wide text-hawk-text">
              Hawkeye
            </span>
          </Link>
          <div className="flex items-center gap-2 rounded-xl border border-hawk-border-subtle bg-hawk-surface/65 p-1 font-mono text-xs text-hawk-text3 shadow-sm">
            {navLinks.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className={`rounded-lg px-3 py-1.5 transition-all hover:text-hawk-text ${
                  location.pathname === link.to
                    ? 'bg-hawk-surface2 text-hawk-orange shadow-sm'
                    : ''
                }`}
              >
                {link.label}
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
        </div>
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Outlet />
      </main>
    </div>
  );
}
