import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-09 real seat allocation, release, reassignment and subscription capacity', async (suite) => {
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
                password: 'Seat-Fixture-Quasar-48',
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
    const platform = await signup('+8613800000301'),
      owner = await signup('+8613800000302'),
      admin = await signup('+8613800000303'),
      alice = await signup('+8613800000304'),
      bob = await signup('+8613800000305'),
      outsider = await signup('+8613800000306')
    const ownerClub = await signup('+8613800000302', false, true)
    const reason = 'Isolated AUTH-09 acceptance fixture',
      date = (n: number) => new Date(n).toISOString()
    for (const permission of [
      'TENANT_CREATE',
      'TENANT_READ',
      'TENANT_STATUS',
      'CATALOG_WRITE',
      'SUBSCRIPTION_WRITE',
      'SUBSCRIPTION_READ',
      'AUDIT_READ',
    ])
      await db
        .prepare(
          "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES (?,?,'ACTIVE',?,?)",
        )
        .bind(platform.userId, permission, platform.userId, Date.now())
        .run()
    async function createTenant(name: string, user: any) {
      return ok(
        await call('/platform/tenants', { name, ownerUserId: user.userId, reason }, platform),
        'PlatformTenantView',
      )
    }
    const tenant = await createTenant('Seat Alpha', owner),
      otherTenant = await createTenant('Seat Beta', outsider)
    const base = '/tenants/' + tenant.tenantId
    async function join(actor: any) {
      const i = ok(
        await call(base + '/invitations', { target: { kind: 'USER', value: actor.userId } }, owner),
      )
      return ok(
        await call(
          '/invitations/' + i.invitationId + '/accept',
          { expectedVersion: i.version },
          actor,
        ),
      ).membership
    }
    let adminMember = await join(admin)
    const aliceMember = await join(alice),
      bobMember = await join(bob)
    const ownerMember = ok(await call(base, undefined, owner)),
      foreignMember = ok(await call('/tenants/' + otherTenant.tenantId, undefined, outsider))
    async function role(m: any, role: string) {
      return ok(
        await call(
          base + '/members/' + m.membershipId + '/role',
          { role, expectedVersion: m.version },
          owner,
          secret(),
          'PATCH',
        ),
        'Membership',
      )
    }
    adminMember = await role(adminMember, 'ADMIN')
    ok(
      await call(
        '/platform/catalog/features',
        { featureId: 'demo.seat', product: 'SHARED', name: 'Seat test feature', reason },
        platform,
      ),
      'Feature',
    )
    ok(
      await call(
        '/platform/catalog/plans/demo.seats/versions',
        {
          planVersion: 1,
          name: 'Seat fixture only',
          personalFeatureIds: [],
          seatTypes: [
            { seatTypeId: 'demo.standard', name: 'Standard test seat', featureIds: ['demo.seat'] },
            { seatTypeId: 'demo.other', name: 'Other test seat', featureIds: ['demo.seat'] },
          ],
          reason,
        },
        platform,
      ),
      'PlanVersion',
    )
    async function subscription(quantity = 1, tenantId = tenant.tenantId) {
      return ok(
        await call(
          '/platform/subscriptions',
          {
            owner: { kind: 'TENANT', id: tenantId },
            planId: 'demo.seats',
            planVersion: 1,
            startsAt: date(Date.now() - 60000),
            endsAt: date(Date.now() + 86400000),
            seatQuantities: { 'demo.standard': quantity },
            reason,
          },
          platform,
        ),
        'Subscription',
      )
    }
    async function getSub(s: any) {
      return ok(
        await call('/platform/subscriptions/' + s.subscriptionId, undefined, platform),
        'Subscription',
      )
    }
    async function patch(s: any, body: any) {
      return call(
        '/platform/subscriptions/' + s.subscriptionId,
        { ...body, expectedVersion: s.version, reason },
        platform,
        secret(),
        'PATCH',
      )
    }
    async function pool(s: any, type = 'demo.standard') {
      // All fixture subscriptions fit in one contract-bounded page.
      const rows = ok(
        await call(base + '/seat-pools?limit=100', undefined, owner),
        'SeatPoolPage',
      ).items
      return rows.find((p: any) => p.subscriptionId === s.subscriptionId && p.seatTypeId === type)
    }
    function assignBody(s: any, m: any, p: any) {
      return {
        subscriptionId: s.subscriptionId,
        seatTypeId: p.seatTypeId,
        membershipId: m.membershipId,
        expectedVersion: p.version,
      }
    }
    async function assign(s: any, m: any, actor = owner, key = secret(), p?: any) {
      return call(base + '/seat-assignments', assignBody(s, m, p ?? (await pool(s))), actor, key)
    }
    async function release(a: any, actor = owner, key = secret()) {
      return call(
        base + '/seat-assignments/' + a.assignmentId + '/release',
        { expectedVersion: a.version },
        actor,
        key,
      )
    }
    async function reassign(a: any, m: any, actor = owner, key = secret()) {
      return call(
        base + '/seat-assignments/' + a.assignmentId + '/reassign',
        { targetMembershipId: m.membershipId, expectedVersion: a.version },
        actor,
        key,
      )
    }
    async function list(state = 'current', actor = owner, extra = '') {
      return call(
        base + '/seat-assignments?state=' + state + '&limit=100' + extra,
        undefined,
        actor,
      )
    }
    const bySub = (rows: any[], s: any) => rows.filter((a) => a.subscriptionId === s.subscriptionId)

    await suite.test(
      'UAS-18/26/33: managers assign seats within their tenant; platform authority, IDs and input cannot bypass membership',
      async () => {
        const s = await subscription(2),
          p = await pool(s),
          b = assignBody(s, aliceMember, p)
        assert.equal((await call(base + '/seat-assignments', b, alice)).status, 403)
        assert.equal((await call(base + '/seat-assignments', b, platform)).status, 404)
        assert.equal((await call(base + '/seat-assignments', b, outsider)).status, 404)
        assert.equal(
          (
            await call(
              base + '/seat-assignments',
              { ...b, membershipId: foreignMember.membershipId },
              owner,
            )
          ).status,
          404,
        )
        const foreignSub = await subscription(1, otherTenant.tenantId)
        assert.equal(
          (
            await call(
              base + '/seat-assignments',
              { ...b, subscriptionId: foreignSub.subscriptionId },
              owner,
            )
          ).status,
          404,
        )
        assert.equal(
          (await call(base + '/seat-assignments', { ...b, userId: outsider.userId }, owner)).status,
          400,
        )
        const key = secret(),
          results = await Promise.all([
            call(base + '/seat-assignments', b, admin, key),
            call(base + '/seat-assignments', b, admin, key),
          ])
        const first = ok(results[0], 'SeatMutationResult')
        assert.deepEqual(ok(results[1], 'SeatMutationResult'), first)
        assert.equal(first.assignment.userId, alice.userId)
        assert.equal(first.assignment.membershipId, aliceMember.membershipId)
        assert.equal(first.assignment.status, 'ASSIGNED')
        assert.equal(first.pool.assignedCount, 1)
        assert.equal(first.pool.availableCount, 1)
        assert.equal(first.pool.version, p.version + 1)
        assert.equal((await assign(s, aliceMember)).status, 409)
        assert.equal(
          (
            await call(
              base + '/seat-assignments',
              { ...b, membershipId: bobMember.membershipId },
              admin,
              key,
            )
          ).error.code,
          'IDEMPOTENCY_CONFLICT',
        )
        const second = ok(await assign(s, bobMember, ownerClub), 'SeatMutationResult')
        assert.equal(second.pool.assignedCount, 2)
        assert.equal((await assign(s, ownerMember)).status, 409)
        assert.equal((await release(first.assignment, alice)).status, 403)
        assert.equal(
          (
            await call(
              '/tenants/' +
                otherTenant.tenantId +
                '/seat-assignments/' +
                first.assignment.assignmentId +
                '/release',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          404,
        )
        const released = ok(await release(first.assignment, admin), 'SeatMutationResult')
        assert.equal(released.assignment.endReason, 'RELEASED')
        assert.equal(released.pool.assignedCount, 1)
      },
    )
    await suite.test(
      'UAS-18/21/26: a full pool reassigns atomically; duplicates and retries never create extra allocation',
      async () => {
        const s = await subscription(),
          first = ok(await assign(s, aliceMember), 'SeatMutationResult')
        assert.equal((await reassign(first.assignment, aliceMember)).status, 400)
        const key = secret(),
          results = await Promise.all([
            reassign(first.assignment, bobMember, admin, key),
            reassign(first.assignment, bobMember, admin, key),
          ])
        const moved = ok(results[0], 'SeatReassignResult')
        assert.deepEqual(ok(results[1], 'SeatReassignResult'), moved)
        assert.equal(moved.endedAssignment.assignmentId, first.assignment.assignmentId)
        assert.equal(moved.endedAssignment.endReason, 'REASSIGNED')
        assert.equal(moved.endedAssignment.status, 'ENDED')
        assert.notEqual(moved.assignment.assignmentId, first.assignment.assignmentId)
        assert.equal(moved.assignment.userId, bob.userId)
        assert.equal(moved.pool.assignedCount, 1)
        assert.equal(moved.pool.availableCount, 0)
        assert.equal(moved.pool.version, first.pool.version + 1)
        assert.notEqual(moved.entitlementRevision, first.entitlementRevision)
        assert.equal((await release(first.assignment)).status, 409)
        const releaseKey = secret(),
          ended = ok(await release(moved.assignment, owner, releaseKey), 'SeatMutationResult')
        assert.deepEqual(ok(await release(moved.assignment, owner, releaseKey)), ended)
        assert.equal((await release(moved.assignment)).status, 409)
        assert.equal(ended.pool.assignedCount, 0)
        const again = ok(await assign(s, aliceMember), 'SeatMutationResult')
        assert.notEqual(again.assignment.assignmentId, first.assignment.assignmentId)
        const two = await subscription(2),
          a = ok(await assign(two, aliceMember), 'SeatMutationResult'),
          b = ok(await assign(two, bobMember), 'SeatMutationResult')
        assert.equal((await reassign(a.assignment, bobMember)).status, 409)
        assert.equal(bySub(ok(await list()).items, two).length, 2)
        assert.equal(bySub(ok(await list('history')).items, two).length, 0)
        assert.equal((await pool(two)).version, b.pool.version)
      },
    )
    await suite.test(
      'UAS-18/26/33: current/history scope and opaque cursors cannot expose another member or filter',
      async () => {
        const current = ok(await list('current', alice), 'AssignmentPage').items
        const history = ok(await list('history', alice), 'AssignmentPage').items
        assert.ok(current.length)
        assert.ok(history.length)
        assert.ok(current.every((a: any) => a.userId === alice.userId && a.status === 'ASSIGNED'))
        assert.ok(history.every((a: any) => a.userId === alice.userId && a.status === 'ENDED'))
        assert.ok(
          ok(await list('current', admin), 'AssignmentPage').items.some(
            (a: any) => a.userId === bob.userId,
          ),
        )
        assert.equal((await list('current', outsider)).status, 404)
        assert.equal((await list('current', alice, '&userId=' + bob.userId)).status, 400)
        assert.equal((await list('anything', owner)).status, 400)
        assert.equal((await list('current', owner, '&state=history')).status, 400)
        const first = ok(
          await call(base + '/seat-assignments?state=current&limit=1', undefined, admin),
          'AssignmentPage',
        )
        assert.ok(first.nextCursor)
        const next = ok(
          await call(
            base + '/seat-assignments?state=current&limit=1&cursor=' + first.nextCursor,
            undefined,
            admin,
          ),
          'AssignmentPage',
        )
        assert.notEqual(first.items[0].assignmentId, next.items[0].assignmentId)
        assert.equal(
          (
            await call(
              base + '/seat-assignments?state=history&limit=1&cursor=' + first.nextCursor,
              undefined,
              admin,
            )
          ).status,
          400,
        )
        assert.equal(
          (
            await call(
              base + '/seat-assignments?state=current&limit=1&cursor=' + first.nextCursor,
              undefined,
              alice,
            )
          ).status,
          400,
        )
        adminMember = await role(adminMember, 'MEMBER')
        assert.equal(
          (
            await call(
              base + '/seat-assignments?state=current&limit=1&cursor=' + first.nextCursor,
              undefined,
              admin,
            )
          ).status,
          400,
        )
        assert.ok(
          ok(await list('current', admin)).items.every((a: any) => a.userId === admin.userId),
        )
        adminMember = await role(adminMember, 'ADMIN')
      },
    )
    await suite.test(
      'UAS-19/20/22/36: expired, disabled or scheduled subscriptions keep allocations and allow release only',
      async () => {
        for (const state of ['EXPIRED', 'DISABLED', 'SCHEDULED']) {
          let s = await subscription(),
            first = ok(await assign(s, aliceMember), 'SeatMutationResult')
          const n = Date.now(),
            changes =
              state === 'DISABLED'
                ? { enabled: false }
                : state === 'EXPIRED'
                  ? { endsAt: date(n - 1000) }
                  : { startsAt: date(n + 3600000), endsAt: date(n + 7200000) }
          s = ok(await patch(s, changes), 'Subscription')
          assert.equal(s.status, state)
          assert.equal((await assign(s, bobMember)).status, 409)
          assert.equal((await reassign(first.assignment, bobMember)).status, 409)
          assert.equal((await pool(s)).assignedCount, 1)
          const ended = ok(await release(first.assignment), 'SeatMutationResult')
          assert.equal(ended.pool.assignedCount, 0)
          assert.equal(ended.assignment.status, 'ENDED')
          s = ok(
            await patch(s, {
              enabled: true,
              startsAt: date(n - 60000),
              endsAt: date(n + 86400000),
            }),
          )
          assert.equal((await pool(s)).assignedCount, 0)
          const second = ok(await assign(s, bobMember), 'SeatMutationResult')
          assert.notEqual(second.assignment.assignmentId, first.assignment.assignmentId)
          const rows = bySub(ok(await list('history')).items, s)
          assert.equal(rows.length, 1)
          assert.equal(rows[0].assignmentId, first.assignment.assignmentId)
        }
      },
    )
    await suite.test(
      'UAS-18/21/26: inactive target membership or account cannot receive seats while its retained allocation remains releasable',
      async () => {
        for (const invalid of ['LEFT', 'DISABLED']) {
          const held = await subscription(),
            target = await subscription(2)
          const beneficiary = ok(await assign(held, aliceMember), 'SeatMutationResult')
          const source = ok(await assign(target, bobMember), 'SeatMutationResult')
          const membership = await db
            .prepare('SELECT * FROM auth_tenant_membership WHERE id=?')
            .bind(aliceMember.membershipId)
            .first()
          const account = await db
            .prepare('SELECT status FROM auth_user WHERE id=?')
            .bind(alice.userId)
            .first()
          try {
            // Fixture only: simulate an invalid beneficiary with a retained assignment.
            if (invalid === 'LEFT') {
              await db
                .prepare(
                  "UPDATE auth_tenant_membership SET status='LEFT',ended_at=?,version=version+1 WHERE id=?",
                )
                .bind(Date.now(), aliceMember.membershipId)
                .run()
            } else {
              await db
                .prepare("UPDATE auth_user SET status='DISABLED' WHERE id=?")
                .bind(alice.userId)
                .run()
            }
            assert.equal((await assign(target, aliceMember)).status, 409)
            assert.equal((await reassign(source.assignment, aliceMember)).status, 409)
            const retained = bySub(ok(await list()).items, target)
            assert.equal(retained.length, 1)
            assert.equal(retained[0].assignmentId, source.assignment.assignmentId)
            const released = ok(await release(beneficiary.assignment, admin), 'SeatMutationResult')
            assert.equal(released.assignment.endReason, 'RELEASED')
            assert.equal(released.pool.assignedCount, 0)
          } finally {
            await db
              .prepare('UPDATE auth_tenant_membership SET status=?,ended_at=?,version=? WHERE id=?')
              .bind(
                membership.status,
                membership.ended_at,
                membership.version,
                aliceMember.membershipId,
              )
              .run()
            await db
              .prepare('UPDATE auth_user SET status=? WHERE id=?')
              .bind(account.status, alice.userId)
              .run()
          }
        }
      },
    )
    await suite.test(
      'UAS-19/21/22/36/37: AUTH-08 capacity and type changes require actual releases and never revive retired history',
      async () => {
        let s = await subscription(2),
          a = ok(await assign(s, aliceMember), 'SeatMutationResult'),
          b = ok(await assign(s, bobMember), 'SeatMutationResult')
        const expiry = s.endsAt
        assert.equal(
          (await patch(s, { seatQuantities: { 'demo.standard': 1 } })).error.code,
          'CAPACITY_CONFLICT',
        )
        assert.equal(
          (await patch(s, { seatQuantities: { 'demo.other': 2 } })).error.code,
          'CAPACITY_CONFLICT',
        )
        ok(await release(a.assignment), 'SeatMutationResult')
        s = ok(await patch(s, { seatQuantities: { 'demo.standard': 1 } }), 'Subscription')
        assert.equal(s.endsAt, expiry)
        assert.equal((await pool(s)).assignedCount, 1)
        s = ok(await patch(s, { endsAt: date(Date.now() - 1000) }))
        assert.equal(s.status, 'EXPIRED')
        assert.equal((await patch(s, { seatQuantities: {} })).error.code, 'CAPACITY_CONFLICT')
        s = ok(
          await call(
            '/platform/subscriptions/' + s.subscriptionId + '/renew',
            { endsAt: date(Date.now() + 86400000), expectedVersion: s.version, reason },
            platform,
          ),
        )
        const current = bySub(ok(await list()).items, s)
        assert.equal(current.length, 1)
        assert.equal(current[0].assignmentId, b.assignment.assignmentId)
        ok(await release(b.assignment), 'SeatMutationResult')
        s = ok(await patch(s, { seatQuantities: { 'demo.other': 2 } }))
        assert.equal(await pool(s), undefined)
        s = ok(await patch(s, { seatQuantities: { 'demo.standard': 1 } }))
        assert.equal((await pool(s)).assignedCount, 0)
        assert.equal(bySub(ok(await list('history')).items, s).length, 2)
        assert.equal(bySub(ok(await list()).items, s).length, 0)
      },
    )
    await suite.test(
      'UAS-18/19/26/37: concurrent last-seat allocation and allocation versus AUTH-08 reduction cannot overbook',
      async () => {
        const s = await subscription(),
          p = await pool(s)
        const races = await Promise.all([
          assign(s, aliceMember, owner, secret(), p),
          assign(s, bobMember, admin, secret(), p),
        ])
        assert.deepEqual(races.map((r) => r.status).sort(), [200, 409])
        assert.equal((await pool(s)).assignedCount, 1)
        const s2 = await subscription(),
          p2 = await pool(s2)
        const competing = await Promise.all([
          assign(s2, aliceMember, owner, secret(), p2),
          patch(s2, { seatQuantities: { 'demo.standard': 0 } }),
        ])
        assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409])
        const live = await pool(s2)
        assert.ok(live.assignedCount <= live.quantity)
        if (competing[0].status === 200) assert.equal(live.quantity, 1)
        else assert.equal(live.assignedCount, 0)
        const s3 = await subscription(),
          p3 = await pool(s3)
        const typeRace = await Promise.all([
          assign(s3, bobMember, owner, secret(), p3),
          patch(s3, { seatQuantities: { 'demo.other': 1 } }),
        ])
        assert.deepEqual(typeRace.map((r) => r.status).sort(), [200, 409])
        const assignments = bySub(ok(await list()).items, s3)
        if (typeRace[0].status === 200) assert.equal(assignments.length, 1)
        else assert.equal(assignments.length, 0)
      },
    )
    await suite.test(
      'UAS-18/21/26: reassignment failure rolls back old binding, new binding, pool, revision, audit and receipt',
      async () => {
        const s = await subscription(),
          first = ok(await assign(s, aliceMember), 'SeatMutationResult')
        const snapshot = async () => ({
          rows: (
            await db
              .prepare('SELECT * FROM billing_seat_assignment WHERE subscription_id=? ORDER BY id')
              .bind(s.subscriptionId)
              .all()
          ).results,
          pool: await pool(s),
          revision: (
            await db
              .prepare('SELECT entitlement_revision FROM auth_managed_tenant WHERE space_id=?')
              .bind(tenant.tenantId)
              .first()
          ).entitlement_revision,
          userRevisions: (
            await db.prepare('SELECT * FROM billing_user_revision ORDER BY user_id').all()
          ).results,
          audit: (await db.prepare('SELECT count(*) n FROM auth_management_audit').first()).n,
        })
        const before = await snapshot(),
          key = secret()
        await db
          .prepare(
            `CREATE TRIGGER fail_reassign BEFORE INSERT ON billing_seat_assignment WHEN NEW.subscription_id='${s.subscriptionId}' BEGIN SELECT RAISE(ABORT,'Injected seat insertion failure'); END`,
          )
          .run()
        try {
          assert.equal((await reassign(first.assignment, bobMember, owner, key)).status, 503)
        } finally {
          await db.prepare('DROP TRIGGER fail_reassign').run()
        }
        assert.deepEqual(await snapshot(), before)
        assert.equal(
          await db
            .prepare('SELECT * FROM auth_management_result WHERE idempotency_key_hash=?')
            .bind(hash(key))
            .first(),
          null,
        )
        const moved = ok(
          await reassign(first.assignment, bobMember, owner, key),
          'SeatReassignResult',
        )
        assert.equal(moved.pool.assignedCount, 1)
        const beforeRelease = await snapshot(),
          releaseKey = secret()
        await db
          .prepare(
            "CREATE TRIGGER fail_seat_audit BEFORE INSERT ON auth_management_audit BEGIN SELECT RAISE(ABORT,'Injected seat audit failure'); END",
          )
          .run()
        try {
          assert.equal((await release(moved.assignment, owner, releaseKey)).status, 503)
        } finally {
          await db.prepare('DROP TRIGGER fail_seat_audit').run()
        }
        assert.deepEqual(await snapshot(), beforeRelease)
        ok(await release(moved.assignment, owner, releaseKey), 'SeatMutationResult')
        const audits = ok(
          await call(base + '/audit-events?limit=100', undefined, owner),
          'AuditEventPage',
        ).items
        assert.ok(
          audits.some(
            (a: any) =>
              a.target.id === moved.assignment.assignmentId ||
              a.target.id === first.assignment.assignmentId,
          ),
        )
        const raw = JSON.stringify(
          (await db.prepare('SELECT * FROM auth_management_audit').all()).results,
        )
        for (const value of [owner.accessToken, admin.accessToken, '+8613800000302'])
          assert.ok(!raw.includes(value))
      },
    )
    await suite.test(
      'UAS-26/33/35: demotion, tenant disable and logout reject reads or mutation replay without undoing preserved seats',
      async () => {
        const s = await subscription(2),
          p = await pool(s),
          b = assignBody(s, aliceMember, p),
          key = secret()
        const result = ok(
          await call(base + '/seat-assignments', b, admin, key),
          'SeatMutationResult',
        )
        adminMember = await role(adminMember, 'MEMBER')
        assert.equal((await call(base + '/seat-assignments', b, admin, key)).status, 403)
        adminMember = await role(adminMember, 'ADMIN')
        assert.deepEqual(ok(await call(base + '/seat-assignments', b, admin, key)), result)
        let t = ok(await call('/platform/tenants/' + tenant.tenantId, undefined, platform))
        t = ok(
          await call(
            '/platform/tenants/' + tenant.tenantId + '/disable',
            { expectedVersion: t.version, reason },
            platform,
          ),
        )
        assert.equal((await list('current', owner)).error.code, 'TENANT_DISABLED')
        assert.equal((await list('history', alice)).error.code, 'TENANT_DISABLED')
        assert.equal((await release(result.assignment)).error.code, 'TENANT_DISABLED')
        assert.equal(
          (await call(base + '/seat-assignments', b, admin, key)).error.code,
          'TENANT_DISABLED',
        )
        ok(
          await call(
            '/platform/tenants/' + tenant.tenantId + '/enable',
            { expectedVersion: t.version, reason },
            platform,
          ),
        )
        assert.equal((await pool(s)).assignedCount, 1)
        const p2 = await pool(s),
          b2 = assignBody(s, bobMember, p2),
          key2 = secret()
        ok(await call(base + '/seat-assignments', b2, ownerClub, key2), 'SeatMutationResult')
        ok(await call('/sessions/current/logout', {}, ownerClub))
        assert.equal((await call(base + '/seat-assignments', b2, ownerClub, key2)).status, 401)
        assert.equal((await pool(s)).assignedCount, 2)
        const exited = ok(
          await call(base + '/leave', { expectedVersion: aliceMember.version }, alice),
          'Membership',
        )
        assert.equal(exited.status, 'LEFT')
        assert.equal((await pool(s)).assignedCount, 1)
        assert.ok(
          ok(await list('current', owner)).items.every((a: any) => a.userId !== alice.userId),
        )
        assert.ok(
          ok(await list('history', owner)).items.some(
            (a: any) => a.userId === alice.userId && a.endReason === 'MEMBER_LEFT',
          ),
        )
        assert.equal((await list('current', alice)).status, 404)
      },
    )
  } finally {
    await p.dispose()
  }
})
