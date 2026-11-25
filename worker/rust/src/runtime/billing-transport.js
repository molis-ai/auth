const internalSecretHeader = 'X-Molis-Internal-Secret'
const secretFormat = /^[A-Za-z0-9_-]{43}$/u
const localBillingOrigin = 'http://127.0.0.1:8788'
const boundBillingOrigin = 'https://billing.internal'
const internalPaths = new Set([
  '/internal/v1/sessions/introspect',
  '/internal/v1/subjects/verify',
  '/internal/v1/platform/audit/authorize',
])
const orderId = String.raw`(?!\.{1,2}(?:/|$))[A-Za-z0-9_.-]{1,128}`
const billingReadPath = new RegExp(
  `^/api/v1/(?:catalog/plans|subscriptions|credits/(?:balance|ledger)|orders(?:/${orderId})?)$`,
  'u',
)
const billingWritePath = new RegExp(
  `^/api/v1/(?:orders(?:/${orderId}/(?:mock-pay|refund))?|entitlements/check)$`,
  'u',
)

function serviceError(status, code) {
  const requestId = crypto.randomUUID()
  return Response.json(
    { error: { code, message: code.replaceAll('_', ' ').toLowerCase() }, requestId },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Request-ID': requestId,
        ...(status === 405 ? { Allow: 'POST' } : {}),
      },
    },
  )
}

function sharedSecret(env) {
  const secret = env.MOLIS_INTERNAL_SECRET
  return typeof secret === 'string' && secretFormat.test(secret) ? secret : undefined
}

export function isLocalBillingTransport(env) {
  return (
    env.MOLIS_ENVIRONMENT === 'dev' &&
    Boolean(env.MOLIS_LOCAL_GENERATION) &&
    env.AUTH_ORIGIN === 'http://127.0.0.1:8787'
  )
}

export async function authBridgeTransport(request, env, authorize) {
  if (!internalPaths.has(new URL(request.url).pathname)) return serviceError(404, 'NOT_FOUND')
  const secret = sharedSecret(env)
  if (!secret) return serviceError(503, 'AUTH_UNAVAILABLE')
  const candidate = request.headers.get(internalSecretHeader) ?? ''
  const utf8 = new TextEncoder()
  if (
    !secretFormat.test(candidate) ||
    !crypto.subtle.timingSafeEqual(utf8.encode(candidate), utf8.encode(secret))
  )
    return serviceError(404, 'NOT_FOUND')
  if (request.method !== 'POST') return serviceError(405, 'METHOD_NOT_ALLOWED')
  try {
    return await authorize(request, env)
  } catch {
    return serviceError(503, 'AUTH_UNAVAILABLE')
  }
}

// Call from an authenticated server handler with a route, parsed query and JSON body.
// This transport accepts no incoming Request or browser header collection.
export async function billingFetch(
  env,
  { method, path, query, body, idempotencyKey, requestId, accessToken },
) {
  if (
    typeof path !== 'string' ||
    !(
      (method === 'GET' && billingReadPath.test(path)) ||
      (method === 'POST' && billingWritePath.test(path))
    ) ||
    (method === 'GET' && body !== undefined)
  )
    return serviceError(400, 'INVALID_REQUEST')
  const local = isLocalBillingTransport(env)
  const binding =
    env.MOLIS_ENVIRONMENT === 'test' || env.MOLIS_ENVIRONMENT === 'prod' ? env.BILLING : undefined
  const secret = sharedSecret(env)
  if (!secret || (!local && typeof binding?.fetch !== 'function'))
    return serviceError(503, 'BILLING_UNAVAILABLE')
  if (typeof accessToken !== 'string' || !secretFormat.test(accessToken))
    return serviceError(401, 'UNAUTHENTICATED')
  try {
    const url = new URL(local ? localBillingOrigin : boundBillingOrigin)
    url.pathname = path
    if (query !== undefined) url.search = new URLSearchParams(query).toString()
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
      [internalSecretHeader]: secret,
    })
    if (body !== undefined) headers.set('Content-Type', 'application/json')
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey)
    if (requestId !== undefined) headers.set('X-Request-ID', requestId)
    const request = new Request(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })
    const response = await (local ? fetch(request) : binding.fetch(request))
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
    if ((response.status >= 300 && response.status < 400) || contentType !== 'application/json')
      return serviceError(503, 'BILLING_UNAVAILABLE')
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return serviceError(503, 'BILLING_UNAVAILABLE')
  }
}
