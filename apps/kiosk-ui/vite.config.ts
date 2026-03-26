import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/menu': 'http://127.0.0.1:8011',
      '/orders': 'http://127.0.0.1:8011',
      '/health': 'http://127.0.0.1:8011',
    },
  },
})
