import { Buffer } from 'node:buffer'
import { PNG } from 'pngjs'
import { Failure, requireThat as ok, str } from '../shared/http.ts'
export async function avatar(value: unknown): Promise<string | null> {
  if (value === null || value === undefined) return null
  const input = str(value, 180000)
  ok(input.startsWith('data:image/png;base64,'), 400, 'INVALID_AVATAR')
  try {
    const raw = Buffer.from(input.slice(22), 'base64')
    ok(
      raw.length >= 33 &&
        raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
        raw.toString('ascii', 12, 16) === 'IHDR',
      400,
      'INVALID_AVATAR',
    )
    const w = raw.readUInt32BE(16),
      h = raw.readUInt32BE(20)
    ok(w > 0 && h > 0 && w <= 256 && h <= 256, 400, 'INVALID_AVATAR')
    // The synchronous decoder uses private Node zlib internals unavailable in workerd.
    // The streaming decoder uses the public createInflate API supported by both runtimes.
    const decoded = await new Promise<PNG>((resolve, reject) => {
      new PNG({ checkCRC: true }).parse(raw, (error, image) => {
        if (error) reject(error)
        else resolve(image)
      })
    })
    const clean = PNG.sync.write(decoded)
    ok(clean.length <= 135000, 400, 'INVALID_AVATAR')
    return 'data:image/png;base64,' + Buffer.from(clean).toString('base64')
  } catch {
    throw new Failure(400, 'INVALID_AVATAR')
  }
}
