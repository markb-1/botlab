import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
/** The API server (`npm run dev:server`); BOTLAB_PORT matches the server's port setting */
const apiTarget = process.env.BOTLAB_API_URL || `http://127.0.0.1:${process.env.BOTLAB_PORT || 3780}`;

// https://vite.dev/config/
export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    host: '127.0.0.1',
    // Same origin in dev: the browser talks to Vite, which forwards /api (incl. SSE) and /healthz to the server
    proxy: {
      '/api': { target: apiTarget },
      '/healthz': { target: apiTarget },
    },
  },
});
