import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'
import { unstable_dev } from 'wrangler'

test('real workerd: avatar round-trip and invalid image rejection', async () => {
  const runtime = await unstable_dev(
    fileURLToPath(new URL('./fixtures/avatar-worker.ts', import.meta.url)),
    {
      config: fileURLToPath(new URL('./fixtures/wrangler.jsonc', import.meta.url)),
      ip: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
      local: true,
      logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false },
    },
  )
  const fixture = (size: number) => {
    const png = new PNG({ width: size, height: size })
    png.data.fill(160)
    return PNG.sync.write(png)
  }
  const dataUrl = (bytes: Buffer) => 'data:image/png;base64,' + bytes.toString('base64')
  async function request(value: unknown) {
    return runtime.fetch('/', {
      method: 'POST',
      body: JSON.stringify(value),
      headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    for (const size of [1, 128, 256]) {
      const result = await request(dataUrl(fixture(size)))
      assert.equal(result.status, 200, await result.clone().text())
      const image = ((await result.json()) as { avatar: string }).avatar
      const decoded = PNG.sync.read(Buffer.from(image.split(',')[1], 'base64'))
      assert.equal(decoded.width, size)
      assert.equal(decoded.height, size)
      assert.ok(decoded.data.every((value) => value === 160))
    }
    const corrupt = fixture(128)
    corrupt[29] ^= 1 // IHDR CRC
    const brokenEnd = fixture(128)
    brokenEnd[brokenEnd.length - 1] ^= 1
    for (const invalid of [
      dataUrl(corrupt),
      dataUrl(brokenEnd),
      dataUrl(fixture(257)),
      dataUrl(fixture(128).subarray(0, 40)),
      'data:image/jpeg;base64,AA==',
      'data:image/png;base64,bad',
    ]) {
      const result = await request(invalid)
      assert.equal(result.status, 400)
      assert.match(await result.text(), /INVALID_AVATAR/)
    }
    assert.equal((await request(null)).status, 200)
  } finally {
    await runtime.stop()
  }
})
