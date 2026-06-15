import { defineConfig, transformWithEsbuild } from 'vite';
import react from '@vitejs/plugin-react';

const dashboardSrc = new URL('./src/', import.meta.url).pathname;
const isDashboardJsSource = (id) => id.startsWith(dashboardSrc) && id.endsWith('.js');

export default defineConfig({
  plugins: [
    {
      name: 'trace-dashboard-transform',
      transform(_code, id) {
        if (process.env.HAWKEYE_VITE_TRACE === '1' && id.startsWith(dashboardSrc)) {
          console.error(`[vite:trace] ${id}`);
        }

        return null;
      },
    },
    {
      name: 'load-js-files-as-jsx',
      async transform(code, id) {
        if (!isDashboardJsSource(id)) {
          return null;
        }

        return transformWithEsbuild(code, id, {
          loader: 'jsx',
          jsx: 'automatic',
        });
      },
    },
    react(),
  ],
  optimizeDeps: {
    esbuildOptions: {
      loader: {
        '.js': 'jsx',
      },
    },
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
  },
  build: {
    target: 'esnext',
  },
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
  server: {
    port: 4242,
  },
});
