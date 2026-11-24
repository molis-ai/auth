import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  base: command === 'serve' ? '/' : '/auth-ui/',
  // The Worker caches generated files in this directory by their content-hashed names.
  publicDir: false,
  build: {
    outDir: 'dist',
    sourcemap: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash:8].js',
        chunkFileNames: 'assets/[name]-[hash:8].js',
        assetFileNames: 'assets/[name]-[hash:8].[ext]',
      },
    },
  },
  // This server is for UI-only iteration. Full same-origin cookie tests use root npm run dev on 8787.
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
}))
