import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI lives in web/ and builds to web/dist, which the API server serves at http://localhost:5178.
// npm run web:dev runs Vite with hot reload and forwards /api to a running server (npm run ui).
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: { port: 5179, proxy: { '/api': 'http://127.0.0.1:5178' } },
});
