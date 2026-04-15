import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  // Read env from monorepo root so Admin fallback uses the same .env as backends.
  envDir: '../..',
  plugins: [react()],
  server: {
    proxy: {
      // Allow local dev UI (:5173) to reach dockerized nginx/api routes (:8080).
      '/api/core': 'http://127.0.0.1:8080',
      '/api/ai': 'http://127.0.0.1:8080',
      '/menu': 'http://127.0.0.1:8011',
      '/orders': 'http://127.0.0.1:8011',
      '/health': 'http://127.0.0.1:8011',
    },
  },
})
