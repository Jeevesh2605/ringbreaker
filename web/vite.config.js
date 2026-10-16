import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, /api is proxied to the Express server, so the browser sees one origin (no CORS).
// A deployed UI points at the API with VITE_API_URL instead (see src/lib/api.js).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
});
