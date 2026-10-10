import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('@supabase')) return 'supabase'
          if (id.includes('node_modules/react') || id.includes('react-router')) return 'react'
          return undefined
        },
      },
    },
  },
})
