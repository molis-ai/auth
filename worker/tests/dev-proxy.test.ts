import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createDevOutbound } from '../scripts/dev-proxy.mjs'
import { getRustProxy } from '../scripts/local-runtime.mjs'

const cookies = ['first=one; Path=/', 'second=two; Expires=Wed, 21 Oct 2030 07:28:00 GMT']
const cookieHeaders = cookies.map((value): [string, string] => ['Set-Cookie', value])

test('development proxy is opt-in and rejects invalid configuration', () => {
  assert.equal(createDevOutbound(''), undefined)
  for (const address of [
    '7993',
    'socks5://localhost:7993',
    'http://localhost:7993/path',
    'http://localhost:7993?secret=x',
  ])
    assert.throws(() => createDevOutbound(address), /AUTH_DEV_PROXY_URL/)
})

test('outbound uses CONNECT, preserves POST, does not follow redirects, and bypasses loopback', async () => {
  let connections = 0
  const sockets = new Set()
  const proxy = http.createServer()
  proxy.on('connect', (req, socket) => {
    connections++
    assert.equal(req.url, 'google-fixture.invalid:80')
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    let data = ''
    socket.on('data', (chunk) => {
      data += chunk.toString()
      if (!data.includes('credential=synthetic')) return
      assert.match(data, /^POST \/token HTTP\/1.1/)
      assert.match(data, /content-type: application\/x-www-form-urlencoded/i)
      socket.end(
        [
          'HTTP/1.1 302 Found',
          'Location: https://must-not-follow.invalid/',
          ...cookies.map((value) => `Set-Cookie: ${value}`),
          'Content-Length: 2',
          'Connection: close',
          '',
          'ok',
        ].join('\r\n'),
      )
    })
  })
  const local = http.createServer((req, res) => {
    res.end('local-direct')
  })
  proxy.listen(0, '127.0.0.1')
  local.listen(0, '127.0.0.1')
  await Promise.all([once(proxy, 'listening'), once(local, 'listening')])
  const outbound = createDevOutbound('http://127.0.0.1:' + proxy.address().port)
  try {
    const response = await outbound.fetch(
      new Request('http://google-fixture.invalid/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'credential=synthetic',
      }),
    )
    assert.equal(response.status, 302)
    assert.deepEqual(response.headers.getSetCookie(), cookies)
    assert.equal(await response.text(), 'ok')
    assert.equal(connections, 1)
    const direct = await outbound.fetch(
      new Request('http://127.0.0.1:' + local.address().port + '/'),
    )
    assert.equal(await direct.text(), 'local-direct')
    assert.equal(connections, 1)
  } finally {
    await outbound.close()
    for (const socket of sockets) socket.destroy()
    proxy.close()
    local.close()
    await Promise.all([once(proxy, 'close'), once(local, 'close')])
  }
})

test('isolated runtime preserves repeated cookies in assets, outbound, and dispatched headers', async (t) => {
  const assets = {
    '/headers': new Headers(cookieHeaders),
    '/pairs': cookieHeaders,
    '/record': { 'X-Asset-Type': 'fixture' },
    '/empty': undefined,
  }
  const proxy = await getRustProxy(
    {},
    () => new Response('outbound', { headers: cookieHeaders }),
    (request: Request) => ({
      status: 200,
      headers: assets[new URL(request.url).pathname as keyof typeof assets],
      arrayBuffer: () => new Response('asset').arrayBuffer(),
    }),
    {
      passwordKdf: false,
      fixtureEntrypoint: `export default {
        fetch(request, env) {
          const path = new URL(request.url).pathname
          if (path === '/outbound') return fetch('https://outbound-fixture.invalid/')
          if (path === '/echo') return Response.json(request.headers.get('Set-Cookie'))
          return env.ASSETS.fetch(request)
        },
      }`,
    },
  )
  t.after(() => proxy.dispose())
  const request = (path: string, init?: RequestInit) =>
    proxy.fetch(new Request('http://127.0.0.1' + path, init))

  for (const path of ['/headers', '/pairs', '/outbound']) {
    const response = await request(path)
    assert.equal(response.status, 200, path)
    assert.deepEqual(response.headers.getSetCookie(), cookies, path)
    assert.equal(await response.text(), path === '/outbound' ? 'outbound' : 'asset')
  }

  const record = await request('/record')
  assert.equal(record.headers.get('X-Asset-Type'), 'fixture')
  assert.equal(await record.text(), 'asset')
  const empty = await request('/empty')
  assert.equal(await empty.text(), 'asset')

  const echoed = await request('/echo', { headers: cookieHeaders })
  assert.equal(await echoed.json(), cookies.join(', '))
})

test('proxy failure is bounded and never exposes credentials or falls back to direct', async () => {
  const proxy = http.createServer()
  let connections = 0
  proxy.on('connect', (_request, socket) => {
    connections++
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const outbound = createDevOutbound('http://127.0.0.1:' + proxy.address().port)
  try {
    const response = await outbound.fetch(
      new Request('https://unreachable-fixture.invalid/token', {
        method: 'POST',
        body: 'client_secret=synthetic-private',
      }),
    )
    assert.equal(response.status, 502)
    assert.doesNotMatch(
      await response.text(),
      /synthetic-private|client_secret|unreachable-fixture/,
    )
    assert.equal(connections, 1)
  } finally {
    await outbound.close()
    proxy.close()
    await once(proxy, 'close')
  }
})
