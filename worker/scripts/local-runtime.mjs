import { Miniflare, Response, convertV4MiniflareOptions } from 'miniflare'
import { fileURLToPath } from 'node:url'
import { readFileSync, readdirSync } from 'node:fs'

export async function getRustProxy(bindings, outbound, assets, { passwordKdf = true } = {}) {
  const base = {
    modulesRoot: fileURLToPath(new URL('../rust/build/', import.meta.url)),
    modules: [
      { type: 'ESModule', path: fileURLToPath(new URL('../rust/build/index.js', import.meta.url)) },
      {
        type: 'CompiledWasm',
        path: fileURLToPath(new URL('../rust/build/index_bg.wasm', import.meta.url)),
      },
    ],
    compatibilityDate: '2026-09-19',
    d1Databases: { DB: 'rust-isolated-test' },
    durableObjects: passwordKdf ? { PASSWORD_KDF: { className: 'PasswordKdf', useSQLite: true } } : {},
    ...(assets
      ? {
          serviceBindings: {
            ASSETS: async (request) => {
              const result = await assets(request)
              return new Response(await result.arrayBuffer(), {
                status: result.status,
                headers: Object.fromEntries(result.headers),
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
        headers: Object.fromEntries(r.headers),
      })
    },
  }
  const options = (bindings) => convertV4MiniflareOptions({ d1Persist: false, ...base, bindings })
  const mf = new Miniflare(options(bindings))
  const db = await mf.getD1Database('DB')
  return {
    env: { DB: db, PASSWORD_KDF: passwordKdf ? await mf.getDurableObjectNamespace('PASSWORD_KDF') : undefined },
    async fetch(request, env) {
      return mf.dispatchFetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? await request.arrayBuffer() : undefined,
        redirect: 'manual',
      })
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
