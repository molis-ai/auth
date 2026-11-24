import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import policy from '../contracts/unified-account/policy.json' with { type: 'json' }

const platformAuthorityPrefix = 'platform:'
const platformCapabilities = [...new Set(policy.permissions
  .map(({ authority }) => authority)
  .filter(authority => authority.startsWith(platformAuthorityPrefix))
  .map(authority => authority.slice(platformAuthorityPrefix.length)))]

export default defineConfig({
  plugins: [vue()],
  define: {
    __AUTH_PLATFORM_CAPABILITIES__: JSON.stringify(platformCapabilities),
  },
  // The HTML URLs and the files served by Cloudflare Assets use the same path.
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: false,
    rolldownOptions: {
      output: {
        entryFileNames: 'auth-ui/assets/[name]-[hash:8].js',
        chunkFileNames: 'auth-ui/assets/[name]-[hash:8].js',
        assetFileNames: 'auth-ui/assets/[name]-[hash:8].[ext]',
      },
    },
  },
  // This server is for UI-only iteration. Full same-origin cookie tests use root npm run dev on 8787.
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8787' } },
})
