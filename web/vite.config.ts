import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  base: command === 'serve' ? '/' : '/auth-ui/',
  build: { outDir: 'dist', sourcemap: false },
  // This server is for UI-only iteration. Full OAuth/cookie tests use root npm run dev on 8787.
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787', '/oauth2': 'http://127.0.0.1:8787' } },
}))
