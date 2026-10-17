import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor':  ['react', 'react-dom', 'react-router-dom'],
          'socket-vendor': ['socket.io-client'],
          // Its own chunk (~288kB): only someone who takes over a browser ever needs
          // it, so it stays out of the main bundle for everyone else.
          //
          // Pinned to noVNC 1.5.x deliberately. 1.6.0 publishes CommonJS containing a
          // top-level await — which is invalid in CJS — and declares no main/module/
          // exports fields at all, so rollup fails the build outright. Worth knowing:
          // the TYPECHECK passed on 1.6.0; only running the build caught it.
          'vnc-vendor':    ['@novnc/novnc/lib/rfb'],
        },
      },
    },
  },
})
