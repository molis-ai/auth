// RPC transport only. Rust owns verification decisions and transaction state.
const encode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
export async function aliyunRpc(keyId, keySecret, action, input) {
  if (!['SendSmsVerifyCode', 'CheckSmsVerifyCode', 'SingleSendMail'].includes(action))
    throw Error('upstream')
  const params = {
    ...JSON.parse(input),
    Action: action,
    Version: action === 'SingleSendMail' ? '2015-11-23' : '2017-05-25',
    Format: 'JSON',
    AccessKeyId: keyId,
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    SignatureNonce: crypto.randomUUID(),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  }
  const canonical = Object.keys(params)
    .sort()
    .map((k) => encode(k) + '=' + encode(String(params[k])))
    .join('&')
  const bytes = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    bytes.encode(keySecret + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign('HMAC', key, bytes.encode('POST&%2F&' + encode(canonical))),
      ),
    ),
  )
  const response = await fetch(
    action === 'SingleSendMail' ? 'https://dm.aliyuncs.com/' : 'https://dypnsapi.aliyuncs.com/',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: canonical + '&Signature=' + encode(signature),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    },
  )
  if (!response.body) throw Error('upstream')
  const reader = response.body.getReader()
  let size = 0
  const chunks = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 32768) {
      await reader.cancel()
      throw Error('upstream')
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    all.set(chunk, offset)
    offset += chunk.length
  }
  const raw = new TextDecoder().decode(all)
  if (!response.ok) {
    const result = JSON.parse(raw)
    const expected =
      response.status === 400 &&
      ((action === 'CheckSmsVerifyCode' && result.Code === 'isv.ValidateFail') ||
        ['BUSINESS_LIMIT_CONTROL', 'FREQUENCY_FAIL'].includes(result.Code))
    if (!expected) throw Error('upstream')
  }
  return raw
}
