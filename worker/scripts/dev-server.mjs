import { fileURLToPath } from 'node:url'
import { unstable_startWorker } from 'wrangler'
import { createDevOutbound } from './dev-proxy.mjs'
import { prepareLocalDevAccount } from './dev-account.mjs'
import { port } from './environment.mjs'

export async function startAuthWorker(config, name, settings) {
  const outbound = createDevOutbound(settings.outboundProxy ?? '')
  let worker
  try {
    worker = await unstable_startWorker({
      config,
      dev: {
        remote: false,
        server: { hostname: '127.0.0.1', port },
        inspector: false,
        watch: false,
        logLevel: 'warn',
        persist: fileURLToPath(
          new URL(
            name === 'dev' ? '../.wrangler/state' : '../.wrangler/state-test',
            import.meta.url,
          ),
        ),
        ...(outbound ? { outboundService: (request) => outbound.fetch(request) } : {}),
      },
    })
    await worker.ready
    const response = await worker.fetch(settings.platform.vars.AUTH_ORIGIN + '/api/v2/readiness', {
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok)
      throw new Error(
        'Auth D1 schema or browser client registration does not match this environment',
      )
    if (name === 'dev') await prepareLocalDevAccount(settings.previewAccount, config)
  } catch (error) {
    await worker?.dispose()
    await outbound?.close()
    throw error
  }

  await new Promise((resolve, reject) => {
    let stopping = false
    async function stop() {
      if (stopping) return
      stopping = true
      try {
        await worker.dispose()
        await outbound?.close()
        resolve()
      } catch (error) {
        reject(error)
      } finally {
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
      }
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
}
