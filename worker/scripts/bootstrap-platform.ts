import { getPlatformProxy } from 'wrangler'
import { fileURLToPath } from 'node:url'
import { bootstrapPlatform } from './platform-bootstrap.mjs'

// Only the worktree's local D1. No remote flag or production configuration accepted.
if (process.argv.length !== 3 || process.argv[2].startsWith('-'))
  throw new Error('Usage: bootstrap-platform.ts <registered-v2-user-id>')
const proxy = await getPlatformProxy<{ DB: D1Database; AUTH_ORIGIN: string }>({
  configPath: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)),
  remoteBindings: false,
})
try {
  if (proxy.env.AUTH_ORIGIN !== 'http://127.0.0.1:8787') throw new Error('Local bootstrap only')
  const result = await bootstrapPlatform(proxy.env.DB, process.argv[2])
  console.log('V2 platform administrator initialized:', result.userId)
} finally {
  await proxy.dispose()
}
