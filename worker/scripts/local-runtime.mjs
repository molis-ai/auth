import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { compatibilityDate } from './environment.mjs'

export async function getRustProxy(
  bindings,
  outbound,
  assets,
  {
    passwordKdf = true,
    fixtureEntrypoint,
    handleStructuredLogs,
    buildDirectory = fileURLToPath(new URL('../rust/build/', import.meta.url)),
  } = {},
) {
  const base = {
    modulesRoot: buildDirectory,
    modules: [
      ...(fixtureEntrypoint
        ? [
            {
              type: 'ESModule',
              path: join(buildDirectory, 'fixture.js'),
              contents: fixtureEntrypoint,
            },
          ]
        : []),
      { type: 'ESModule', path: join(buildDirectory, 'index.js') },
      {
        type: 'CompiledWasm',
        path: join(buildDirectory, 'index_bg.wasm'),
      },
    ],
    compatibilityDate,
    handleStructuredLogs,
    d1Databases: { DB: 'rust-isolated-test' },
    durableObjects: passwordKdf
      ? { PASSWORD_KDF: { className: 'PasswordKdf', useSQLite: true } }
      : {},
    ...(assets
      ? {
          serviceBindings: {
            ASSETS: async (request) => {
              const result = await assets(request)
              return new Response(await result.arrayBuffer(), {
                status: result.status,
                headers: result.headers,
              })
            },
          },
        }
      : {}),
    outboundService: async (request) => {
      if (!outbound) throw new Error('Unexpected external fetch in isolated test')
      const r = await outbound(request)
      return new Response(await r.arrayBuffer(), {
        status: r.status,
        headers: r.headers,
      })
    },
  }
  const options = (bindings) => convertV4MiniflareOptions({ d1Persist: false, ...base, bindings })
  const mf = new Miniflare(options(bindings))
  const db = await mf.getD1Database('DB')
  return {
    env: {
      DB: db,
      PASSWORD_KDF: passwordKdf ? await mf.getDurableObjectNamespace('PASSWORD_KDF') : undefined,
    },
    async fetch(request) {
      return mf.dispatchFetch(request.url, {
        method: request.method,
        headers: [...request.headers.entries()],
        body: request.body ? await request.arrayBuffer() : undefined,
        redirect: 'manual',
      })
    },
    scheduled: async () =>
      (await mf.getWorker()).scheduled({ cron: '0 * * * *', scheduledTime: Date.now() }),
    async updateBindings(updates) {
      bindings = { ...bindings, ...updates }
      await mf.setOptions(options(bindings))
      return mf.getD1Database('DB')
    },
    dispose: () => mf.dispose(),
  }
}

// Ephemeral workerd + D1 only: no remote bindings or persistent user data.
export async function initializeLocalRuntime(proxy, seed = true) {
  const files = readdirSync(new URL('../migrations/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const sources = files.map((name) => new URL('../migrations/' + name, import.meta.url))
  if (seed) sources.push(new URL('../local-seed.sql', import.meta.url))
  for (const file of sources) {
    for (const sql of readFileSync(file, 'utf8')
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await proxy.env.DB.prepare(sql).run()
    }
  }
}
