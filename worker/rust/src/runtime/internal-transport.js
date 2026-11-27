const internalSecretHeader = 'X-Molis-Internal-Secret'
const secretFormat = /^[A-Za-z0-9_-]{43}$/u
const services = new Map([
  ['BILLING', { localOrigin: 'http://127.0.0.1:8788', boundOrigin: 'https://billing.internal' }],
])
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const internalPaths = new Set([
  '/internal/v1/sessions/introspect',
  '/internal/v1/subjects/verify',
  '/internal/v1/platform/audit/authorize',
])
function validPath(path) {
  return (
    typeof path === 'string' &&
    path.startsWith('/api/v1/') &&
    path.length > '/api/v1/'.length &&
    !/[^A-Za-z0-9_./~-]/u.test(path) &&
    !path.includes('//') &&
    !path.split('/').some((segment) => segment === '.' || segment === '..')
  )
}

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

export function isLocalInternalTransport(env) {
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

// Only authenticated server code supplies these fields. Construct all outbound headers here.
export async function upstreamFetch(
  env,
  { service, method, path, query, body, contentType, idempotencyKey, requestId, accessToken },
) {
  const target = services.get(service)
  if (
    !target ||
    !validPath(path) ||
    !methods.has(method) ||
    (method === 'GET' && body !== undefined) ||
    (body !== undefined &&
      (typeof body !== 'string' ||
        typeof contentType !== 'string' ||
        contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json')) ||
    (query !== undefined && typeof query !== 'string')
  )
    return serviceError(400, 'INVALID_REQUEST')

  const local = isLocalInternalTransport(env)
  const binding =
    env.MOLIS_ENVIRONMENT === 'test' || env.MOLIS_ENVIRONMENT === 'prod' ? env[service] : undefined
  const secret = sharedSecret(env)
  if (!secret || (!local && typeof binding?.fetch !== 'function'))
    return serviceError(503, 'UPSTREAM_UNAVAILABLE')
  if (typeof accessToken !== 'string' || !secretFormat.test(accessToken))
    return serviceError(401, 'UNAUTHENTICATED')
  try {
    const url = new URL(local ? target.localOrigin : target.boundOrigin)
    url.pathname = path
    if (query !== undefined) url.search = '?' + query
    const headers = new Headers({
      Accept: 'application/json',
      Authorization: 'Bearer ' + accessToken,
      [internalSecretHeader]: secret,
    })
    if (body !== undefined) headers.set('Content-Type', contentType)
    if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey)
    if (requestId !== undefined) headers.set('X-Request-ID', requestId)
    const request = new Request(url, {
      method,
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    })
    const response = await (local ? fetch(request) : binding.fetch(request))
    const mime = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
    if ((response.status >= 300 && response.status < 400) || mime !== 'application/json')
      return serviceError(503, 'UPSTREAM_UNAVAILABLE')
    return new Response(response.body, {
      status: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return serviceError(503, 'UPSTREAM_UNAVAILABLE')
  }
}
