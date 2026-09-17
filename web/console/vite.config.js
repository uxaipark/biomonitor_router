import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// dev: `npm run dev` on 5175, API/WS proxied to the router on 7300 (same origin in production —
// the router serves dist/ itself, see ROUTER_WEB_DIR).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    host: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7300', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7300', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 1200 },
})
