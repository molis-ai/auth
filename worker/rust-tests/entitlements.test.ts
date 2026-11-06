import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'
import { sharedResourceFixture } from './shared-resource-fixture.ts'

test('AUTH-10 membership exit and entitlement union over real subscriptions and seats', async (suite) => {
  const origin = 'http://127.0.0.1:8787'
  const p = await getRustProxy({
    AUTH_ORIGIN: origin,
    UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
      environmentId: 'unified-local',
      kind: 'LOCAL',
      authOrigin: origin,
      deliveryMode: 'MOCK',
      providerMode: 'MOCK',
    }),
  })
  try {
    await initializeLocalRuntime(p)
    const db = p.env.DB
    for (const sql of readFileSync(
      new URL('../unified-account-local-seed.sql', import.meta.url),
      'utf8',
    )
      .replace(/--[^\n]*/g, '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(sql).run()
    async function call(
      path: string,
      body?: unknown,
      actor?: any,
      key = secret(),
      method = body === undefined ? 'GET' : 'POST',
      proof?: string,
    ) {
      const r = await p.fetch(
        new Request(origin + '/api/v2' + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            ...(actor ? { Authorization: 'Bearer ' + actor.accessToken } : {}),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      return { status: r.status, ...(await r.json()) }
    }
    function ok(r: any, schema?: string) {
      assert.equal(r.status, 200, JSON.stringify(r))
      if (schema) assert.ok(validateNamed(schema, r.data), schema + ' ' + JSON.stringify(r.data))
      return r.data
    }
    async function signup(address: string, email = false, club = false) {
      await db.prepare('DELETE FROM auth_rate_bucket').run()
      const proof = secret(),
        verifier = secret(),
        clientId = club ? 'molis-club-unified-local' : 'molis-work-unified-local'
      const redirectUri = `http://127.0.0.1:${club ? 3000 : 4207}/account/callback`
      const t = ok(
        await call('/auth/transactions', {
          clientId,
          redirectUri,
          state: secret(),
          purpose: email ? 'EMAIL_SIGNUP' : 'LOGIN',
          method: email ? 'EMAIL_CODE' : 'PHONE_OTP',
          codeChallenge: challenge(verifier),
          codeChallengeMethod: 'S256',
          initiatorChallenge: challenge(proof),
        }),
      )
      const path = '/auth/transactions/' + t.transactionId
      const d = ok(
        await call(
          path + '/challenges',
          { channel: email ? 'EMAIL' : 'SMS', address },
          undefined,
          secret(),
          'POST',
          proof,
        ),
      )
      const delivery = await db
        .prepare(
          'SELECT m.credential FROM auth_mock_delivery m JOIN auth_verification_challenge c ON c.delivery_id=m.delivery_id WHERE c.id=?',
        )
        .bind(d.challengeId)
        .first()
      const verified = ok(
        await call(
          path + '/challenges/' + d.challengeId + '/verify',
          { credential: delivery.credential },
          undefined,
          secret(),
          'POST',
          proof,
        ),
      )
      ok(
        await call(
          path + (email ? '/email-signup' : '/phone'),
          email
            ? {
                email: address,
                password: 'Entitlement-Fixture-Quasar-48',
                verificationProof: verified.verificationProof,
              }
            : { verificationProof: verified.verificationProof },
          undefined,
          secret(),
          'POST',
          proof,
        ),
      )
      const done = ok(await call(path + '/complete', {}, undefined, secret(), 'POST', proof))
      const tokens = ok(
        await call('/auth/token', {
          grantType: 'authorization_code',
          clientId,
          redirectUri,
          code: done.code,
          codeVerifier: verifier,
        }),
      )
      const me = ok(await call('/users/me', undefined, tokens))
      return { ...tokens, userId: me.user.userId }
    }
    const platform = await signup('+8613800000401'),
      owner = await signup('+8613800000402'),
      admin = await signup('+8613800000403'),
      alice = await signup('+8613800000404'),
      bob = await signup('+8613800000405'),
      outsider = await signup('+8613800000406')
    const aliceClub = await signup('+8613800000404', false, true)
    const reason = 'Isolated AUTH-10 fixture',
      date = (n: number) => new Date(n).toISOString()
    for (const permission of [
      'TENANT_CREATE',
      'TENANT_READ',
      'TENANT_STATUS',
      'CATALOG_WRITE',
      'SUBSCRIPTION_WRITE',
      'SUBSCRIPTION_READ',
      'AUDIT_READ',
    ]) {
      await db
        .prepare(
          "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES (?,?,'ACTIVE',?,?)",
        )
        .bind(platform.userId, permission, platform.userId, Date.now())
        .run()
    }
    for (const featureId of [
      'demo.personal',
      'demo.shared',
      'demo.seat',
      'demo.extra',
      'demo.beta',
      'demo.none',
      'demo.work',
      'demo.club',
    ]) {
      ok(
        await call(
          '/platform/catalog/features',
          {
            featureId,
            product:
              featureId === 'demo.work' ? 'WORK' : featureId === 'demo.club' ? 'CLUB' : 'SHARED',
            name: featureId + ' test only',
            reason,
          },
          platform,
        ),
        'Feature',
      )
    }
    for (const planVersion of [1, 2])
      ok(
        await call(
          '/platform/catalog/plans/demo.personal/versions',
          {
            planVersion,
            name: 'Personal fixture ' + planVersion,
            personalFeatureIds:
              planVersion === 1 ? ['demo.personal', 'demo.shared', 'demo.work', 'demo.club'] : [],
            seatTypes: [],
            reason,
          },
          platform,
        ),
        'PlanVersion',
      )
    ok(
      await call(
        '/platform/catalog/plans/demo.tenant/versions',
        {
          planVersion: 1,
          name: 'Tenant fixture',
          personalFeatureIds: [],
          seatTypes: [
            {
              seatTypeId: 'demo.standard',
              name: 'Standard fixture',
              featureIds: ['demo.seat', 'demo.shared'],
            },
            { seatTypeId: 'demo.extra', name: 'Extra fixture', featureIds: ['demo.extra'] },
            { seatTypeId: 'demo.beta', name: 'Beta fixture', featureIds: ['demo.beta'] },
          ],
          reason,
        },
        platform,
      ),
      'PlanVersion',
    )
    async function tenant(label: string) {
      return ok(
        await call(
          '/platform/tenants',
          { name: label, ownerUserId: owner.userId, reason },
          platform,
        ),
        'PlatformTenantView',
      )
    }
    const path = (t: any) => '/tenants/' + t.tenantId
    async function join(t: any, actor: any) {
      const invite = ok(
        await call(
          path(t) + '/invitations',
          { target: { kind: 'USER', value: actor.userId } },
          owner,
        ),
      )
      return ok(
        await call(
          '/invitations/' + invite.invitationId + '/accept',
          { expectedVersion: invite.version },
          actor,
        ),
      ).membership
    }
    async function role(t: any, m: any, value: string) {
      return ok(
        await call(
          path(t) + '/members/' + m.membershipId + '/role',
          { role: value, expectedVersion: m.version },
          owner,
          secret(),
          'PATCH',
        ),
        'Membership',
      )
    }
    async function subscription(ownerRef: any, extra: any = {}) {
      return ok(
        await call(
          '/platform/subscriptions',
          {
            owner: ownerRef,
            planId: ownerRef.kind === 'USER' ? 'demo.personal' : 'demo.tenant',
            planVersion: 1,
            startsAt: date(Date.now() - 60000),
            endsAt: date(Date.now() + 86400000),
            ...(ownerRef.kind === 'TENANT'
              ? { seatQuantities: { 'demo.standard': 4, 'demo.extra': 4, 'demo.beta': 4 } }
              : {}),
            ...extra,
            reason,
          },
          platform,
        ),
        'Subscription',
      )
    }
    async function personal(actor: any, extra: any = {}) {
      return subscription({ kind: 'USER', id: actor.userId }, extra)
    }
    async function team(t: any, extra: any = {}) {
      return subscription({ kind: 'TENANT', id: t.tenantId }, extra)
    }
    async function patch(s: any, extra: any) {
      return ok(
        await call(
          '/platform/subscriptions/' + s.subscriptionId,
          { ...extra, expectedVersion: s.version, reason },
          platform,
          secret(),
          'PATCH',
        ),
        'Subscription',
      )
    }
    async function pools(t: any) {
      return ok(await call(path(t) + '/seat-pools?limit=100', undefined, owner), 'SeatPoolPage')
        .items
    }
    async function assign(t: any, s: any, m: any, type = 'demo.standard', pool?: any) {
      const selected =
        pool ??
        (await pools(t)).find(
          (p: any) => p.subscriptionId === s.subscriptionId && p.seatTypeId === type,
        )
      return call(
        path(t) + '/seat-assignments',
        {
          subscriptionId: s.subscriptionId,
          seatTypeId: type,
          membershipId: m.membershipId,
          expectedVersion: selected.version,
        },
        owner,
      )
    }
    async function release(t: any, a: any) {
      return ok(
        await call(
          path(t) + '/seat-assignments/' + a.assignmentId + '/release',
          { expectedVersion: a.version },
          owner,
        ),
        'SeatMutationResult',
      )
    }
    async function list(t: any, state = 'current') {
      return ok(
        await call(path(t) + '/seat-assignments?state=' + state + '&limit=100', undefined, owner),
        'AssignmentPage',
      ).items
    }
    async function check(
      actor: any,
      scope: any,
      featureIds = [
        'demo.personal',
        'demo.shared',
        'demo.seat',
        'demo.extra',
        'demo.beta',
        'demo.none',
      ],
    ) {
      return call('/entitlements/check', { scope, featureIds }, actor)
    }
    const scope = (t: any) => ({ kind: 'TENANT', tenantId: t.tenantId }),
      personalScope = { kind: 'PERSONAL' }
    const decision = (r: any, id: string) => r.decisions.find((d: any) => d.featureId === id)
    async function leave(t: any, m: any, actor: any, key = secret()) {
      return call(path(t) + '/leave', { expectedVersion: m.version }, actor, key)
    }
    async function remove(t: any, m: any, actor = owner, key = secret()) {
      return call(
        path(t) + '/members/' + m.membershipId + '/remove',
        { expectedVersion: m.version },
        actor,
        key,
      )
    }

    await suite.test(
      'K04-01 / UAS-14/15/17/24/35: shared view/download contract with real Work and Club sessions',
      async (cases) => {
        const member = await signup('+8613800000491'),
          club = await signup('+8613800000491', false, true),
          stranger = await signup('+8613800000492'),
          t = await tenant('Synthetic shared alpha'),
          other = await tenant('Synthetic shared beta')
        let membership = await join(t, member)
        await join(other, member)
        let reads = 0,
          fault = ''
        const resource = sharedResourceFixture(
          [
            {
              id: 'alpha',
              tenantId: t.tenantId,
              read: () => {
                reads++
                return 'synthetic alpha content'
              },
            },
            {
              id: 'beta',
              tenantId: other.tenantId,
              read: () => {
                reads++
                return 'synthetic beta content'
              },
            },
          ],
          origin,
          async (request) => {
            assert.ok(
              [path(t), path(other)].some(
                (route) => new URL(request.url).pathname === '/api/v2' + route,
              ),
            )
            assert.equal(request.method, 'GET')
            assert.deepEqual([...request.headers.keys()], ['authorization'])
            if (fault === 'network') throw Error('Synthetic Auth outage')
            if (fault === 'server') return new Response(null, { status: 503 })
            const response = await p.fetch(request)
            if (!fault) return response
            const body = await response.json()
            if (fault === 'wrong-tenant') body.data.tenantId = other.tenantId
            if (fault === 'disabled') body.data.status = 'DISABLED'
            if (fault === 'malformed') delete body.data.membershipId
            return Response.json(body)
          },
        )
        async function access(actor: any, expected = 200, id = 'alpha', extra = '') {
          for (const operation of ['VIEW', 'DOWNLOAD']) {
            const before = reads
            const response = await resource(
              new Request(`http://resource.test/resources/${id}?operation=${operation}${extra}`, {
                headers: actor
                  ? {
                      Authorization: 'Bearer ' + actor.accessToken,
                      'X-User-Id': owner.userId,
                      'X-Tenant-Role': 'OWNER',
                    }
                  : {},
              }),
            )
            assert.equal(response.status, expected, await response.clone().text())
            assert.equal(response.headers.get('Cache-Control'), 'no-store')
            if (expected === 200) {
              assert.equal(await response.text(), `synthetic ${id} content`)
              assert.match(
                response.headers.get('Content-Disposition')!,
                operation === 'VIEW' ? /^inline;/ : /^attachment;/,
              )
              assert.equal(reads, before + 1)
            } else {
              assert.doesNotMatch(await response.text(), /synthetic (alpha|beta) content/)
              assert.equal(response.headers.get('Content-Disposition'), null)
              assert.equal(reads, before, 'Denied requests must not read payloads')
            }
          }
        }
        await cases.test(
          'no subscription or seat: both clients and all member roles may view/download',
          async () => {
            for (const actor of [member, club]) {
              assert.ok(ok(await check(actor, scope(t))).decisions.every((d: any) => !d.allowed))
              await access(actor)
            }
            membership = await role(t, membership, 'ADMIN')
            await access(member)
            membership = await role(t, membership, 'MEMBER')
            await access(owner)
          },
        )
        await cases.test(
          'anonymous, nonmember, forged scope/role, unknown resource and paid outsider fail closed',
          async () => {
            await access(undefined, 401)
            await access(stranger, 404)
            await access(member, 404, 'unknown')
            await access(member, 400, 'alpha', '&tenantId=' + other.tenantId)
            await access(stranger, 400, 'alpha', '&userId=' + member.userId)
            await personal(stranger)
            assert.ok(decision(ok(await check(stranger, personalScope)), 'demo.shared').allowed)
            await access(stranger, 404)
          },
        )
        await cases.test(
          'seat release, subscription expiry and disable do not remove basic member access',
          async () => {
            const sub = await team(t)
            const held = ok(await assign(t, sub, membership), 'SeatMutationResult')
            await access(club)
            await release(t, held.assignment)
            await access(club)
            const expired = await patch(sub, { endsAt: date(Date.now() - 1000) })
            await access(member)
            await patch(expired, { enabled: false })
            assert.ok(ok(await check(member, scope(t))).decisions.every((d: any) => !d.allowed))
            await access(club)
          },
        )
        await cases.test(
          'tenant disable blocks both operations even with personal subscription; restore rechecks membership',
          async () => {
            await personal(member)
            const now = ok(await call('/platform/tenants/' + t.tenantId, undefined, platform))
            const off = ok(
              await call(
                '/platform/tenants/' + t.tenantId + '/disable',
                { expectedVersion: now.version, reason },
                platform,
              ),
            )
            await access(member, 403)
            await access(club, 403)
            await access(member, 200, 'beta')
            assert.ok(decision(ok(await check(member, personalScope)), 'demo.shared').allowed)
            ok(
              await call(
                '/platform/tenants/' + t.tenantId + '/enable',
                { expectedVersion: off.version, reason },
                platform,
              ),
            )
            await access(club)
          },
        )
        await cases.test(
          'leave/remove revoke the next view and download in both clients; rejoin is explicit',
          async () => {
            ok(await leave(t, membership, club))
            await access(member, 404)
            await access(club, 404)
            await access(club, 200, 'beta')
            membership = await join(t, member)
            await access(member)
            ok(await remove(t, membership))
            await access(member, 404)
            await access(club, 404)
            membership = await join(t, member)
          },
        )
        await cases.test(
          'Auth outage, malformed/cross-tenant responses and revoked sessions never release content',
          async () => {
            for (fault of ['network', 'server', 'wrong-tenant', 'malformed', 'disabled'])
              await access(club, fault === 'disabled' ? 403 : 503)
            fault = ''
            ok(await call('/sessions/current/logout', {}, club))
            await access(club, 401)
            await access(member)
          },
        )
      },
    )
    await suite.test(
      'UAS-23/24/26: entitlement inputs and trusted product registration reject impersonation, unknown features and wrong products',
      async () => {
        assert.equal((await check(undefined, personalScope)).status, 401)
        for (const body of [
          { scope: personalScope, featureIds: [] },
          { scope: personalScope, featureIds: ['demo.shared', 'demo.shared'] },
          { scope: personalScope, featureIds: Array.from({ length: 101 }, (_, i) => 'demo.f' + i) },
          { scope: personalScope, featureIds: ['demo.shared'], subjectUserId: alice.userId },
          { scope: { kind: 'PERSONAL', userId: alice.userId }, featureIds: ['demo.shared'] },
          { scope: personalScope, featureIds: ['demo.shared'], product: 'CLUB' },
        ])
          assert.equal((await call('/entitlements/check', body, owner)).status, 400)
        for (const [actor, id] of [
          [owner, 'unknown'],
          [owner, 'demo.club'],
          [aliceClub, 'demo.work'],
        ] as const) {
          const r = await check(actor, personalScope, [id])
          assert.equal(r.status, 400)
          assert.equal(r.error.code, 'FEATURE_UNKNOWN')
        }
        ok(
          await check(owner, personalScope, ['demo.work', 'demo.shared']),
          'EntitlementCheckResult',
        )
        ok(
          await check(aliceClub, personalScope, ['demo.club', 'demo.shared']),
          'EntitlementCheckResult',
        )
        const registration = await db
          .prepare("SELECT * FROM auth_client_product WHERE client_id='molis-work-unified-local'")
          .first()
        assert.ok(registration)
        await db
          .prepare("DELETE FROM auth_client_product WHERE client_id='molis-work-unified-local'")
          .run()
        try {
          assert.equal(
            (await check(owner, personalScope, ['demo.shared'])).error.code,
            'POLICY_MISMATCH',
          )
        } finally {
          await db
            .prepare('INSERT INTO auth_client_product(client_id,product,version) VALUES (?,?,?)')
            .bind(registration.client_id, registration.product, registration.version)
            .run()
        }
      },
    )
    await suite.test(
      'UAS-17/23/24/33: personal and current-tenant sources form a union without cross-tenant grants or role privileges',
      async () => {
        const a = await tenant('Union alpha'),
          b = await tenant('Union beta'),
          ma = await join(a, alice),
          mb = await join(b, alice)
        const per = await personal(alice),
          sa = await team(a),
          sb = await team(b)
        const one = ok(await assign(a, sa, ma), 'SeatMutationResult'),
          two = ok(await assign(b, sb, mb, 'demo.beta'), 'SeatMutationResult')
        const pview = ok(await check(alice, personalScope), 'EntitlementCheckResult')
        assert.equal(decision(pview, 'demo.personal').allowed, true)
        assert.equal(decision(pview, 'demo.seat').allowed, false)
        assert.deepEqual(decision(pview, 'demo.shared').sources, [
          { kind: 'PERSONAL_SUBSCRIPTION', subscriptionId: per.subscriptionId },
        ])
        const alpha = ok(await check(alice, scope(a)), 'EntitlementCheckResult')
        assert.equal(decision(alpha, 'demo.personal').allowed, true)
        assert.equal(decision(alpha, 'demo.seat').allowed, true)
        assert.equal(decision(alpha, 'demo.beta').allowed, false)
        assert.deepEqual(
          decision(alpha, 'demo.shared')
            .sources.map((s: any) => s.kind)
            .sort(),
          ['PERSONAL_SUBSCRIPTION', 'TENANT_SEAT'],
        )
        assert.deepEqual(decision(alpha, 'demo.seat').sources, [
          {
            kind: 'TENANT_SEAT',
            subscriptionId: sa.subscriptionId,
            seatTypeId: 'demo.standard',
            assignmentId: one.assignment.assignmentId,
          },
        ])
        assert.ok(!JSON.stringify(alpha).includes(two.assignment.assignmentId))
        assert.ok(!JSON.stringify(alpha).includes(sb.subscriptionId))
        const beta = ok(await check(alice, scope(b)), 'EntitlementCheckResult')
        assert.equal(decision(beta, 'demo.beta').allowed, true)
        assert.equal(decision(beta, 'demo.seat').allowed, false)
        const ownerView = ok(await check(owner, scope(a)), 'EntitlementCheckResult')
        assert.ok(ownerView.decisions.every((d: any) => !d.allowed && d.sources.length === 0))
        assert.equal((await check(outsider, scope(a))).status, 404)
        assert.equal((await check(owner, { kind: 'TENANT', tenantId: 'missing' })).status, 404)
        const club = ok(
          await check(aliceClub, personalScope, ['demo.club', 'demo.shared']),
          'EntitlementCheckResult',
        )
        assert.ok(club.decisions.every((d: any) => d.allowed))
      },
    )
    await suite.test(
      'UAS-20/22/23/24/35: subscription, release, plan and tenant changes take effect on the next authoritative check',
      async () => {
        const t = await tenant('Live facts'),
          m = await join(t, bob)
        let per = await personal(bob),
          s = await team(t)
        const a = ok(await assign(t, s, m), 'SeatMutationResult')
        let view = ok(await check(bob, scope(t)), 'EntitlementCheckResult'),
          rev = view.revision
        per = await patch(per, { enabled: false })
        view = ok(await check(bob, scope(t)))
        assert.equal(decision(view, 'demo.personal').allowed, false)
        assert.equal(decision(view, 'demo.shared').allowed, true)
        assert.notEqual(view.revision, rev)
        rev = view.revision
        await release(t, a.assignment)
        view = ok(await check(bob, scope(t)))
        assert.equal(decision(view, 'demo.shared').allowed, false)
        assert.notEqual(view.revision, rev)
        per = await patch(per, { enabled: true, plan: { planId: 'demo.personal', planVersion: 2 } })
        assert.equal(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed, false)
        per = await patch(per, {
          plan: { planId: 'demo.personal', planVersion: 1 },
          endsAt: date(Date.now() - 1000),
        })
        assert.equal(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed, false)
        per = await patch(per, {
          startsAt: date(Date.now() + 60000),
          endsAt: date(Date.now() + 120000),
        })
        assert.equal(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed, false)
        per = await patch(per, {
          startsAt: date(Date.now() - 60000),
          endsAt: date(Date.now() + 86400000),
        })
        assert.equal(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed, true)
        const tNow = ok(await call('/platform/tenants/' + t.tenantId, undefined, platform))
        const off = ok(
          await call(
            '/platform/tenants/' + t.tenantId + '/disable',
            { expectedVersion: tNow.version, reason },
            platform,
          ),
        )
        assert.equal((await check(bob, scope(t))).error.code, 'TENANT_DISABLED')
        assert.equal(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed, true)
        ok(
          await call(
            '/platform/tenants/' + t.tenantId + '/enable',
            { expectedVersion: off.version, reason },
            platform,
          ),
        )
        s = await patch(s, { enabled: false })
        assert.equal(decision(ok(await check(bob, scope(t))), 'demo.seat').allowed, false)
      },
    )
    await suite.test(
      'UAS-23/24/38: validUntil never outlives the next activation, expiry or current login boundary',
      async () => {
        const n = Date.now(),
          futureStart = n + 60000
        const timed = await personal(outsider, {
          startsAt: date(futureStart),
          endsAt: date(n + 180000),
        })
        const future = ok(
          await check(outsider, personalScope, ['demo.personal']),
          'EntitlementCheckResult',
        )
        assert.equal(future.decisions[0].allowed, false)
        assert.ok(Date.parse(future.decisions[0].validUntil) <= futureStart)
        assert.ok(Date.parse(future.decisions[0].validUntil) > Date.parse(future.evaluatedAt))
        const live = await patch(timed, { startsAt: date(n - 1000), endsAt: date(n + 45000) })
        const active = ok(
          await check(outsider, personalScope, ['demo.personal']),
          'EntitlementCheckResult',
        )
        assert.equal(active.decisions[0].allowed, true)
        assert.ok(Date.parse(active.decisions[0].validUntil) <= Date.parse(live.endsAt))
        assert.notEqual(active.revision, future.revision)
        const me = ok(await call('/sessions/current', undefined, outsider), 'SessionView')
        for (const d of active.decisions) {
          assert.ok(Date.parse(d.validUntil) <= Date.parse(me.idleExpiresAt))
          assert.ok(Date.parse(d.validUntil) <= Date.parse(me.absoluteExpiresAt))
        }
      },
    )
    await suite.test(
      'UAS-23/24: clock-only activation and expiry change entitlement revisions without subscription writes',
      async () => {
        const clockUser = await signup('+8613800000499')
        const n = Date.now(),
          starts = n + 3000,
          ends = n + 6000
        const timed = await personal(clockUser, { startsAt: date(starts), endsAt: date(ends) })
        const before = ok(
          await check(clockUser, personalScope, ['demo.personal']),
          'EntitlementCheckResult',
        )
        assert.ok(
          Date.parse(before.evaluatedAt) < starts,
          'first observation precedes scheduled activation',
        )
        assert.equal(before.decisions[0].allowed, false)
        const waitUntil = (at: number) =>
          new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, at - Date.now())))
        await waitUntil(starts + 75)
        const active = ok(
          await check(clockUser, personalScope, ['demo.personal']),
          'EntitlementCheckResult',
        )
        assert.equal(active.decisions[0].allowed, true)
        assert.notEqual(active.revision, before.revision)
        await waitUntil(ends + 75)
        const expired = ok(
          await check(clockUser, personalScope, ['demo.personal']),
          'EntitlementCheckResult',
        )
        assert.equal(expired.decisions[0].allowed, false)
        assert.notEqual(expired.revision, active.revision)
        const unchanged = ok(
          await call('/platform/subscriptions/' + timed.subscriptionId, undefined, platform),
          'Subscription',
        )
        assert.equal(unchanged.version, timed.version)
        assert.equal(unchanged.startsAt, timed.startsAt)
        assert.equal(unchanged.endsAt, timed.endsAt)
      },
    )
    await suite.test(
      'UAS-14/19/22/26: leaving atomically releases all tenant types, cancels transfer and preserves personal/other-tenant facts',
      async () => {
        const t = await tenant('Leave all sources'),
          other = await tenant('Leave isolation'),
          m = await join(t, alice),
          otherM = await join(other, alice)
        let live = await team(t),
          expired = await team(t),
          disabled = await team(t)
        const assigned = [
          ok(await assign(t, live, m), 'SeatMutationResult').assignment,
          ok(await assign(t, expired, m, 'demo.extra'), 'SeatMutationResult').assignment,
          ok(await assign(t, disabled, m, 'demo.beta'), 'SeatMutationResult').assignment,
        ]
        expired = await patch(expired, { endsAt: date(Date.now() - 1000) })
        disabled = await patch(disabled, { enabled: false })
        const otherSub = await team(other),
          otherSeat = ok(await assign(other, otherSub, otherM), 'SeatMutationResult')
        const personalBefore = (
          await db
            .prepare('SELECT * FROM billing_subscription WHERE owner_user_id=? ORDER BY id')
            .bind(alice.userId)
            .all()
        ).results
        const tNow = ok(await call(path(t), undefined, owner))
        const transfer = ok(
          await call(
            path(t) + '/ownership-transfers',
            { targetMembershipId: m.membershipId, expectedVersion: tNow.version },
            owner,
          ),
        )
        const beforePools = await pools(t),
          key = secret()
        const responses = await Promise.all([leave(t, m, alice, key), leave(t, m, alice, key)])
        const ended = ok(responses[0], 'Membership')
        assert.deepEqual(ok(responses[1]), ended)
        assert.equal(ended.status, 'LEFT')
        assert.equal((await check(alice, scope(t))).status, 404)
        assert.ok(decision(ok(await check(alice, personalScope)), 'demo.personal').allowed)
        assert.equal((await list(t)).length, 0)
        const history = await list(t, 'history')
        assert.equal(history.length, 3)
        assert.ok(history.every((a: any) => a.endReason === 'MEMBER_LEFT' && a.status === 'ENDED'))
        assert.deepEqual(
          history.map((a: any) => a.assignmentId).sort(),
          assigned.map((a) => a.assignmentId).sort(),
        )
        for (const pool of await pools(t)) {
          const before = beforePools.find(
            (p: any) =>
              p.subscriptionId === pool.subscriptionId && p.seatTypeId === pool.seatTypeId,
          )
          assert.equal(pool.assignedCount, 0)
          assert.equal(pool.quantity, before.quantity)
          assert.equal(
            pool.version,
            before.version +
              (assigned.some(
                (a) => a.subscriptionId === pool.subscriptionId && a.seatTypeId === pool.seatTypeId,
              )
                ? 1
                : 0),
          )
        }
        assert.equal(
          (
            await db
              .prepare('SELECT status FROM auth_ownership_transfer WHERE id=?')
              .bind(transfer.transferId)
              .first()
          ).status,
          'CANCELLED',
        )
        assert.deepEqual(
          (
            await db
              .prepare('SELECT * FROM billing_subscription WHERE owner_user_id=? ORDER BY id')
              .bind(alice.userId)
              .all()
          ).results,
          personalBefore,
        )
        assert.equal((await list(other))[0].assignmentId, otherSeat.assignment.assignmentId)
        assert.equal(decision(ok(await check(alice, scope(other))), 'demo.seat').allowed, true)
        const newM = await join(t, alice)
        assert.notEqual(newM.membershipId, m.membershipId)
        assert.equal(newM.version, ended.version + 1)
        assert.deepEqual(ok(await leave(t, m, alice, key)), ended)
        assert.equal(ok(await call(path(t), undefined, alice)).membershipId, newM.membershipId)
        assert.equal((await list(t)).length, 0)
        assert.equal(decision(ok(await check(alice, scope(t))), 'demo.seat').allowed, false)
        assert.equal((await leave(t, m, alice)).status, 409)
        assert.equal(ok(await leave(t, newM, alice)).version, newM.version + 1)
      },
    )
    await suite.test(
      'UAS-14/16/26: owner handoff and administrator boundaries govern removal; same-key retries cannot remove a new membership',
      async () => {
        const t = await tenant('Removal authority'),
          ad = await role(t, await join(t, admin), 'ADMIN'),
          a = await join(t, alice),
          b = await join(t, bob)
        const ownerRow = ok(await call(path(t), undefined, owner)),
          ownerMembership = { membershipId: ownerRow.membershipId, version: 0 }
        assert.equal((await leave(t, ownerMembership, owner)).error.code, 'OWNER_TRANSFER_REQUIRED')
        assert.ok((await remove(t, ad, admin)).status >= 400)
        assert.ok((await remove(t, ownerMembership, admin)).status >= 400)
        assert.equal((await remove(t, a, bob)).status, 403)
        const s = await team(t)
        const held = ok(await assign(t, s, a), 'SeatMutationResult')
        const key = secret(),
          ended = ok(await remove(t, a, admin, key), 'Membership')
        assert.equal(ended.status, 'REMOVED')
        assert.deepEqual(ok(await remove(t, a, admin, key)), ended)
        assert.equal((await check(alice, scope(t))).status, 404)
        assert.equal(
          (await list(t, 'history')).find(
            (r: any) => r.assignmentId === held.assignment.assignmentId,
          ).endReason,
          'MEMBER_REMOVED',
        )
        const a2 = await join(t, alice)
        assert.deepEqual(ok(await remove(t, a, admin, key)), ended)
        assert.equal(ok(await call(path(t), undefined, alice)).membershipId, a2.membershipId)
        const demoted = await role(t, ad, 'MEMBER')
        assert.equal((await remove(t, a, admin, key)).status, 403)
        const adminLeft = ok(await leave(t, demoted, admin), 'Membership')
        assert.equal(adminLeft.status, 'LEFT')
        const ownerNow = ok(await call(path(t), undefined, owner)),
          handoff = ok(
            await call(
              path(t) + '/ownership-transfers',
              { targetMembershipId: b.membershipId, expectedVersion: ownerNow.version },
              owner,
            ),
          )
        const accepted = ok(
          await call(
            '/ownership-transfers/' + handoff.transferId + '/accept',
            { expectedVersion: handoff.version },
            bob,
          ),
        )
        assert.equal(accepted.previousOwner.role, 'MEMBER')
        const prior = accepted.previousOwner
        assert.equal(ok(await leave(t, prior, owner), 'Membership').status, 'LEFT')
        assert.equal((await leave(t, accepted.owner, bob)).error.code, 'OWNER_TRANSFER_REQUIRED')
      },
    )
    await suite.test(
      'UAS-14/18/26: failed membership or seat writes roll back every release, membership, revision, audit and receipt',
      async () => {
        const t = await tenant('Exit fault'),
          m = await join(t, bob),
          s = await team(t)
        ok(await assign(t, s, m), 'SeatMutationResult')
        ok(await assign(t, s, m, 'demo.extra'), 'SeatMutationResult')
        const snapshot = async () => ({
          member: await db
            .prepare('SELECT * FROM auth_tenant_membership WHERE id=?')
            .bind(m.membershipId)
            .first(),
          seats: (
            await db
              .prepare('SELECT * FROM billing_seat_assignment WHERE tenant_id=? ORDER BY id')
              .bind(t.tenantId)
              .all()
          ).results,
          pools: await pools(t),
          tenant: await db
            .prepare('SELECT * FROM auth_managed_tenant WHERE space_id=?')
            .bind(t.tenantId)
            .first(),
          user: await db
            .prepare('SELECT * FROM billing_user_revision WHERE user_id=?')
            .bind(bob.userId)
            .first(),
          audit: (await db.prepare('SELECT count(*) n FROM auth_management_audit').first()).n,
          identityAudit: (await db.prepare('SELECT count(*) n FROM auth_audit_event').first()).n,
        })
        const before = await snapshot(),
          key = secret()
        for (const [name, trigger] of [
          [
            'fail_member_exit',
            `CREATE TRIGGER fail_member_exit BEFORE UPDATE OF status ON auth_tenant_membership WHEN OLD.id='${m.membershipId}' BEGIN SELECT RAISE(ABORT,'Injected membership failure'); END`,
          ],
          [
            'fail_bulk_release',
            `CREATE TRIGGER fail_bulk_release BEFORE UPDATE OF status ON billing_seat_assignment WHEN OLD.membership_id='${m.membershipId}' BEGIN SELECT RAISE(ABORT,'Injected seat release failure'); END`,
          ],
        ]) {
          await db.prepare(trigger).run()
          try {
            assert.equal((await remove(t, m, owner, key)).status, 503)
          } finally {
            await db.prepare('DROP TRIGGER ' + name).run()
          }
          assert.deepEqual(await snapshot(), before)
          assert.equal(
            await db
              .prepare('SELECT * FROM auth_management_result WHERE idempotency_key_hash=?')
              .bind(hash(key))
              .first(),
            null,
          )
        }
        assert.equal(ok(await remove(t, m, owner, key), 'Membership').status, 'REMOVED')
        assert.equal((await list(t)).length, 0)
      },
    )
    await suite.test(
      'UAS-14/18/26: assignment competing with removal leaves no allocation attached to an ended membership',
      async () => {
        for (const mode of ['remove', 'leave']) {
          const t = await tenant('Exit race ' + mode),
            m = await join(t, alice),
            s = await team(t)
          const pool = (await pools(t)).find(
            (p: any) => p.subscriptionId === s.subscriptionId && p.seatTypeId === 'demo.standard',
          )
          const results = await Promise.all([
            assign(t, s, m, 'demo.standard', pool),
            mode === 'remove' ? remove(t, m) : leave(t, m, alice),
          ])
          assert.equal(results[1].status, 200, JSON.stringify(results))
          assert.ok([200, 404, 409].includes(results[0].status), JSON.stringify(results))
          assert.equal(
            (
              await db
                .prepare(
                  "SELECT count(*) n FROM billing_seat_assignment WHERE membership_id=? AND status='ASSIGNED'",
                )
                .bind(m.membershipId)
                .first()
            ).n,
            0,
          )
          assert.equal((await check(alice, scope(t))).status, 404)
          assert.ok((await pools(t)).every((p: any) => p.assignedCount === 0))
        }
      },
    )
    await suite.test(
      'UAS-14/23/24/26/35: tenant disable and revoked sessions prevent exit/replay and entitlement reads',
      async () => {
        const t = await tenant('Exit disabled tenant'),
          m = await join(t, bob),
          s = await team(t)
        const held = ok(await assign(t, s, m), 'SeatMutationResult')
        let tNow = ok(await call('/platform/tenants/' + t.tenantId, undefined, platform))
        tNow = ok(
          await call(
            '/platform/tenants/' + t.tenantId + '/disable',
            { expectedVersion: tNow.version, reason },
            platform,
          ),
        )
        assert.equal((await leave(t, m, bob)).error.code, 'TENANT_DISABLED')
        assert.equal((await remove(t, m)).error.code, 'TENANT_DISABLED')
        assert.equal((await check(bob, scope(t))).error.code, 'TENANT_DISABLED')
        assert.equal(
          (
            await db
              .prepare('SELECT status FROM billing_seat_assignment WHERE id=?')
              .bind(held.assignment.assignmentId)
              .first()
          ).status,
          'ASSIGNED',
        )
        ok(
          await call(
            '/platform/tenants/' + t.tenantId + '/enable',
            { expectedVersion: tNow.version, reason },
            platform,
          ),
        )
        const bobClub = await signup('+8613800000405', false, true),
          key = secret()
        const ended = ok(await leave(t, m, bobClub, key), 'Membership')
        assert.equal(ended.status, 'LEFT')
        ok(await call('/sessions/current/logout', {}, bobClub))
        assert.equal((await leave(t, m, bobClub, key)).status, 401)
        assert.equal((await check(bobClub, personalScope, ['demo.shared'])).status, 401)
        assert.ok(decision(ok(await check(bob, personalScope)), 'demo.personal').allowed)
      },
    )
  } finally {
    await p.dispose()
  }
})
