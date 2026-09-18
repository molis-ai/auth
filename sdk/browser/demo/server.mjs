// Loopback-only SDK exercise page, not a business backend or a production web server.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const issuer = new URL(process.env.AUTH_DEMO_ISSUER ?? 'http://localhost:41880')
const clientId = process.env.AUTH_DEMO_CLIENT_ID
const port = Number(process.env.AUTH_DEMO_PORT ?? 41980)
if (!clientId || issuer.pathname !== '/' || issuer.search || issuer.hash || issuer.username || issuer.password
    || !['http:', 'https:'].includes(issuer.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)
    || !Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Provide a registered client ID, loopback Auth origin and unprivileged demo port')
const origin = 'http://127.0.0.1:' + port
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/callback', ['index.html', 'text/html']],
  ['/demo.js', ['app.js', 'text/javascript']], ['/demo.css', ['style.css', 'text/css']],
  ['/sdk.js', ['../dist/index.js', 'text/javascript']],
])
const server = createServer(async (request, response) => {
  // Avoid treating this local demo as a host-header/open-proxy surface.
  if (request.headers.host !== '127.0.0.1:' + port) { response.writeHead(400); response.end(); return }
  response.setHeader('Cache-Control', 'no-store'); response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${issuer.origin}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`)
  if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
  const path = new URL(request.url, origin).pathname
  if (path === '/configuration') {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ issuer: issuer.origin, clientId, redirectUri: origin + '/callback', scopes: ['account'] })); return
  }
  const entry = files.get(path)
  if (!entry) { response.writeHead(404); response.end(); return }
  try {
    const body = await readFile(fileURLToPath(new URL(entry[0], import.meta.url)))
    response.setHeader('Content-Type', entry[1] + '; charset=utf-8'); response.end(body)
  } catch { response.writeHead(503); response.end('Build the browser SDK first.') }
})
server.listen(port, '127.0.0.1', () => process.stdout.write('SDK demo listening at ' + origin + '\n'))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
