import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  base: command === 'serve' ? '/' : '/auth-ui/',
  build: { outDir: 'dist', sourcemap: false },
  // Development is opt-in and loopback only. For full cookie/redirect tests use the packaged Jar.
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8080', '/oauth2': 'http://127.0.0.1:8080' } },
}))
