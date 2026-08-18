import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const serverUrl = process.env.AGENTMESH_SERVER_URL ?? 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxying keeps the browser on one origin in development, so CORS and
    // websocket auth behave the same as they do behind a reverse proxy.
    proxy: {
      '/api': { target: serverUrl, changeOrigin: true },
      '/ws': { target: serverUrl.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
