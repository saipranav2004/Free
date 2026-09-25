import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// ---------------------------------------------------------------------------
// Source maps are OFF for production builds
// ---------------------------------------------------------------------------
// This used to be `sourcemap: true`, which shipped 85 .map files alongside the
// bundle, each one carrying `sourcesContent`: the ORIGINAL source of every
// module, comments and all. DevTools resolves them automatically, so the
// Sources panel on the deployed console showed the complete src/ tree, exactly
// as it looks on a developer's machine. For a privileged-access console that is
// a genuine disclosure, not a cosmetic one: the comments in this codebase
// describe route guards, token handling and enforcement boundaries, and reading
// them is a free head start for anyone probing the API behind it.
//
// Minification alone does not fix this. A map is what turns the minified bundle
// back into readable, correctly-named, fully-commented source, so the map is
// the thing that has to go.
//
// Set VITE_SOURCEMAP=true to build WITH maps when you genuinely need to debug a
// production bundle. Do not leave it on for a deployed build. nginx.conf also
// refuses any .map request outright, so a stale map left in an image from an
// earlier build is still not reachable.
const withSourcemaps = String(process.env.VITE_SOURCEMAP || '').toLowerCase() === 'true'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    sourcemap: withSourcemaps,
    rollupOptions: {
      output: {
        // Keep vendor deps in a separate chunk so app-code changes don't
        // invalidate the (much larger, much more stable) node_modules chunk
        // on every deploy.
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
})
