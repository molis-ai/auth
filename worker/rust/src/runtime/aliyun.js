// Interpret Aliyun's wire responses here. Rust owns Auth errors and transaction state.
const encode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

function rpcResult(action, response, raw) {
  if (response.status === 429) return { outcome: 'rate_limited', reply: 'rate_limited' }
  if (response.status >= 500) return { outcome: 'upstream_error' }
  if (!response.ok && response.status !== 400) return { outcome: 'http_error' }

  let data
  try {
    data = JSON.parse(raw)
  } catch {
    return { outcome: 'invalid_response' }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { outcome: 'invalid_response' }
  }

  const { Code: code } = data
  if (action === 'CheckSmsVerifyCode' && code === 'isv.ValidateFail') {
    return { outcome: 'success', verification_result: 'mismatch', reply: 'invalid_credentials' }
  }
  if (code === 'BUSINESS_LIMIT_CONTROL' || code === 'FREQUENCY_FAIL') {
    return {
      outcome: 'rate_limited',
      reply: action === 'SingleSendMail' ? undefined : 'rate_limited',
    }
  }
  if (!response.ok) return { outcome: 'http_error' }

  if (action === 'SingleSendMail') {
    if (code != null) return { outcome: 'provider_error' }
    const ids = [data.RequestId, data.EnvId]
    if (!ids.every((id) => typeof id === 'string' && id.length > 0)) {
      return { outcome: 'invalid_response' }
    }
  } else if (code !== 'OK' || data.Success !== true) {
    return { outcome: 'provider_error' }
  }
  if (action === 'CheckSmsVerifyCode') {
    const verdict = data.Model?.VerifyResult
    if (verdict !== 'PASS' && verdict !== 'UNKNOWN') {
      return { outcome: 'invalid_response', reply: 'mismatch' }
    }
    const verification = verdict === 'PASS' ? 'match' : 'mismatch'
    return { outcome: 'success', verification_result: verification, reply: verification }
  }
  return { outcome: 'success', reply: 'accepted' }
}

async function readBody(response) {
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
  return new TextDecoder().decode(all)
}

const signingKeys = new Map()
const MAX_SIGNING_KEYS = 4

async function signingKey(secret) {
  const cached = signingKeys.get(secret)
  if (cached) return cached
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret + '&'),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  if (signingKeys.size >= MAX_SIGNING_KEYS) signingKeys.delete(signingKeys.keys().next().value)
  signingKeys.set(secret, key)
  return key
}

export async function aliyunRpc(keyId, keySecret, action, input, requestId, environment) {
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
  const key = await signingKey(keySecret)
  const signature = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.sign('HMAC', key, bytes.encode('POST&%2F&' + encode(canonical))),
      ),
    ),
  )
  const url =
    action === 'SingleSendMail' ? 'https://dm.aliyuncs.com/' : 'https://dypnsapi.aliyuncs.com/'
  const body = canonical + '&Signature=' + encode(signature)
  const signal = AbortSignal.timeout(10000)
  const started = performance.now()
  let response
  let result
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'manual',
      signal,
    })
    if (response.status === 429) {
      void response.body?.cancel().catch(() => {})
      result = rpcResult(action, response, '')
    } else {
      result = rpcResult(action, response, await readBody(response))
    }
  } catch {
    result = {
      outcome: signal.aborted ? 'timeout' : response ? 'invalid_response' : 'network_error',
    }
  }

  console.log(
    JSON.stringify({
      schema: 1,
      service: 'molis-auth',
      env: ['prod', 'test', 'dev'].includes(environment) ? environment : 'unknown',
      event: 'auth.aliyun.request',
      request_id: requestId,
      action,
      provider: 'aliyun',
      outcome: result.outcome === 'success' ? 'success' : 'failed',
      error_code: result.outcome === 'success' ? 'none' : result.outcome.toUpperCase(),
      duration_ms: Math.round(performance.now() - started),
      ...(response && { http_status: response.status }),
      ...(result.verification_result && { verification_result: result.verification_result }),
    }),
  )
  if (!result.reply) throw Error('upstream')
  return result.reply
}
