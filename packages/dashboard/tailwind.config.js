/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        hawk: {
          bg: 'var(--hawk-bg)',
          surface: 'var(--hawk-surface)',
          surface2: 'var(--hawk-surface2)',
          surface3: 'var(--hawk-surface3)',
          border: 'var(--hawk-border)',
          'border-subtle': 'var(--hawk-border-subtle)',
          orange: '#ff5f1f',
          green: '#22c55e',
          amber: '#f0a830',
          red: '#ef4444',
          cyan: '#06b6d4',
          purple: '#a78bfa',
          text: 'var(--hawk-text)',
          text2: 'var(--hawk-text2)',
          text3: 'var(--hawk-text3)',
        },
      },
      fontFamily: {
        mono: ['IBM Plex Mono', 'monospace'],
        display: ['Outfit', 'sans-serif'],
        body: ['Instrument Sans', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
