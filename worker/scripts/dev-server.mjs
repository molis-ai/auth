import { readFileSync, existsSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { fileURLToPath } from 'node:url'
import { unstable_startWorker } from 'wrangler'
import { createDevOutbound } from './dev-proxy.mjs'

const config = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url))
const varsFile = new URL('../.dev.vars', import.meta.url)
const vars = existsSync(varsFile) ? parseEnv(readFileSync(varsFile, 'utf8')) : {}
const args = process.argv.slice(2)
let port = 8787
if (args.length) {
  if (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))
    throw Error('Usage: node scripts/dev-server.mjs [--port 8787]')
  port = Number(args[1])
  if (port < 1 || port > 65535) throw Error('Invalid local port')
}
const outbound = createDevOutbound(process.env.AUTH_DEV_PROXY_URL ?? vars.AUTH_DEV_PROXY_URL ?? '')
let worker
try {
  worker = await unstable_startWorker({
    config,
    dev: {
      remote: false,
      server: { hostname: '127.0.0.1', port },
      inspector: false,
      watch: true,
      persist: fileURLToPath(new URL('../.wrangler/state', import.meta.url)),
      ...(outbound ? { outboundService: (request) => outbound.fetch(request) } : {}),
    },
  })
  await worker.ready
  console.log(
    `Auth local: http://127.0.0.1:${port} — outbound ${outbound ? 'proxy enabled (loopback direct)' : 'direct'}`,
  )
} catch (error) {
  await worker?.dispose()
  await outbound?.close()
  throw error
}
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  try {
    await worker.dispose()
    await outbound?.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
