// Development transport only. Never imported into the deployed Worker bundle.
import { Agent, ProxyAgent, fetch } from 'undici'
import { Response } from 'miniflare'

export function createDevOutbound(value = '') {
  const address = value.trim()
  if (!address) return undefined
  let url
  try {
    url = new URL(address)
  } catch {
    throw Error('AUTH_DEV_PROXY_URL must be an HTTP(S) proxy URL')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash)
    throw Error('AUTH_DEV_PROXY_URL must be an HTTP(S) proxy URL without a path, query or fragment')
  const proxy = new ProxyAgent(address)
  const direct = new Agent()
  return {
    async fetch(request) {
      const target = new URL(request.url)
      const local =
        target.hostname === 'localhost' ||
        target.hostname.endsWith('.localhost') ||
        target.hostname === '[::1]' ||
        /^127\./.test(target.hostname)
      try {
        const response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
          dispatcher: local ? direct : proxy,
          redirect: 'manual',
          signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        })
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers),
        })
      } catch {
        // Do not include URLs, authorization headers, form bodies or proxy credentials.
        console.error('AUTH_DEV_OUTBOUND_FAILED: check proxy availability and routing')
        return new Response('Local development outbound request failed', { status: 502 })
      }
    },
    async close() {
      await Promise.all([proxy.close(), direct.close()])
    },
  }
}
