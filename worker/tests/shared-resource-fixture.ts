import { validateNamed } from '../../contracts/unified-account/validate.ts'

// K04-01: test-only resource owner. No deployed route, database, bucket or download URL.
// The Host/BFF supplies its bearer server-side; browsers never receive central tokens.
export function sharedResourceFixture(
  resources: ReadonlyArray<{ id: string; tenantId: string; read: () => string }>,
  authOrigin: string,
  authFetch: (request: Request) => Promise<Response>,
) {
  const records = new Map(resources.map((resource) => [resource.id, { ...resource }]))
  const headers = { 'Cache-Control': 'no-store' }
  const reject = (status: number, code: string) =>
    Response.json({ error: { code } }, { status, headers })
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      match = /^\/resources\/([a-z0-9-]+)$/.exec(url.pathname),
      operation = url.searchParams.get('operation')
    if (
      request.method !== 'GET' ||
      !match ||
      !['VIEW', 'DOWNLOAD'].includes(operation ?? '') ||
      [...url.searchParams.keys()].length !== 1
    )
      return reject(400, 'INVALID_REQUEST')
    const authorization = request.headers.get('Authorization')
    if (!authorization) return reject(401, 'SESSION_REQUIRED')
    const resource = records.get(match[1])
    if (!resource) return reject(404, 'NOT_FOUND')
    // Resolve tenant from the resource owner, never from a requested scope or role.
    try {
      const response = await authFetch(
        new Request(authOrigin + '/api/v2/tenants/' + encodeURIComponent(resource.tenantId), {
          headers: { Authorization: authorization },
          redirect: 'manual',
        }),
      )
      if (response.status === 401) return reject(401, 'SESSION_REQUIRED')
      if (response.status === 404) return reject(404, 'NOT_FOUND')
      if (response.status === 403) return reject(403, 'ACCESS_DENIED')
      if (response.status !== 200) return reject(503, 'AUTH_UNAVAILABLE')
      const { data } = (await response.json()) as { data: { tenantId: string; status: string } }
      if (!validateNamed('TenantView', data) || data.tenantId !== resource.tenantId)
        return reject(503, 'AUTH_UNAVAILABLE')
      if (data.status !== 'ACTIVE') return reject(403, 'ACCESS_DENIED')
    } catch {
      return reject(503, 'AUTH_UNAVAILABLE')
    }
    // No paid feature/seat check. Read only after an authoritative membership check,
    // separately for every view/download; never issue an enduring public download URL.
    return new Response(resource.read(), {
      headers: {
        ...headers,
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition':
          (operation === 'DOWNLOAD' ? 'attachment' : 'inline') + '; filename="synthetic.txt"',
      },
    })
  }
}
