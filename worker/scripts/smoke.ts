import assert from 'node:assert/strict'

// Deliberately loopback-only: cannot accidentally hit a live service with this script.
const origin = 'http://127.0.0.1:8787'
const health = await fetch(origin + '/api/v1/health')
assert.equal(health.status, 200)
assert.equal((await health.json()).data.status, 'UP')
for (const path of ['/login', '/console', '/complete', '/console/callback']) {
  const page = await fetch(origin + path)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('Content-Type')!, /text\/html/)
  const html = await page.text()
  const assets = [...html.matchAll(/(?:src|href)="(\/auth-ui\/assets\/[^\"]+)"/g)]
  assert.ok(assets.length > 0)
  for (const [, asset] of assets) {
    const result = await fetch(origin + asset)
    assert.equal(result.status, 200)
    assert.doesNotMatch(result.headers.get('Content-Type')!, /text\/html/)
  }
}
const api = await fetch(origin + '/api/v1/spaces', { headers: { Accept: 'text/html' } })
assert.equal(api.status, 401)
assert.equal((await api.json()).error.code, 'INVALID_TOKEN')
console.log(
  'PASS: real local workerd + D1 health + four page aliases + built assets + fail-closed API boundary',
)
