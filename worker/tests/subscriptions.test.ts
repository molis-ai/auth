import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-08 real catalog and subscription lifecycle with isolated identity mock', async (suite) => {
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
                password: 'Subscription-Fixture-Quasar-48',
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
    const platform = await signup('+8613800000201'),
      owner = await signup('+8613800000202'),
      member = await signup('+8613800000203'),
      other = await signup('+8613800000204'),
      outsider = await signup('+8613800000205'),
      reader = await signup('+8613800000206')
    const ownerClub = await signup('+8613800000202', false, true)
    async function permission(actor: any, permission: string, enabled = true) {
      await db
        .prepare(
          'INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at,revoked_at) VALUES (?,?,?,?,?,?) ON CONFLICT(user_id,permission) DO UPDATE SET status=excluded.status,revoked_at=excluded.revoked_at,version=auth_platform_permission.version+1',
        )
        .bind(
          actor.userId,
          permission,
          enabled ? 'ACTIVE' : 'REVOKED',
          platform.userId,
          Date.now(),
          enabled ? null : Date.now(),
        )
        .run()
    }
    for (const scope of [
      'TENANT_CREATE',
      'TENANT_READ',
      'TENANT_STATUS',
      'CATALOG_WRITE',
      'SUBSCRIPTION_WRITE',
      'SUBSCRIPTION_READ',
      'AUDIT_READ',
    ])
      await permission(platform, scope)
    for (const scope of ['SUBSCRIPTION_READ', 'AUDIT_READ']) await permission(reader, scope)
    const reason = 'Isolated AUTH-08 acceptance fixture'
    async function createTenant(name: string, user: any) {
      return ok(
        await call('/platform/tenants', { name, ownerUserId: user.userId, reason }, platform),
        'PlatformTenantView',
      )
    }
    const alpha = await createTenant('Subscription Alpha', owner),
      beta = await createTenant('Subscription Beta', other)
    async function join(actor: any) {
      const i = ok(
        await call(
          '/tenants/' + alpha.tenantId + '/invitations',
          { target: { kind: 'USER', value: actor.userId } },
          owner,
        ),
      )
      return ok(
        await call(
          '/invitations/' + i.invitationId + '/accept',
          { expectedVersion: i.version },
          actor,
        ),
      ).membership
    }
    const memberRow = await join(member),
      outsiderRow = await join(outsider)
    const priorOwner = ok(await call('/tenants/' + alpha.tenantId, undefined, owner))
    const now = Date.now(),
      date = (t: number) => new Date(t).toISOString()
    const period = { startsAt: date(now - 60000), endsAt: date(now + 86400000) }
    const planBody = {
      planVersion: 1,
      name: 'Demo base (test only)',
      personalFeatureIds: ['demo.shared'],
      seatTypes: [
        { seatTypeId: 'demo.standard', name: 'Standard test seat', featureIds: ['demo.work'] },
        { seatTypeId: 'demo.advanced', name: 'Advanced test seat', featureIds: ['demo.club'] },
      ],
      reason,
    }
    async function publish(id: string, b: any = planBody, key = secret()) {
      return call('/platform/catalog/plans/' + id + '/versions', b, platform, key)
    }
    async function getSub(id: string, actor = platform) {
      return ok(await call('/platform/subscriptions/' + id, undefined, actor), 'Subscription')
    }
    async function update(s: any, patch: any, actor = platform, key = secret()) {
      return call(
        '/platform/subscriptions/' + s.subscriptionId,
        { ...patch, expectedVersion: s.version, reason },
        actor,
        key,
        'PATCH',
      )
    }
    async function createSub(ownerRef: any, extra: any = {}, key = secret()) {
      return call(
        '/platform/subscriptions',
        { owner: ownerRef, planId: 'demo.base', planVersion: 1, ...period, ...extra, reason },
        platform,
        key,
      )
    }
    async function pools(id = alpha.tenantId, actor = owner) {
      return ok(await call('/tenants/' + id + '/seat-pools', undefined, actor), 'SeatPoolPage')
        .items
    }
    let personal: any, team: any
    await suite.test(
      'UAS-17/32: catalog publication requires platform authority, valid references and immutable versions',
      async () => {
        for (const product of ['SHARED', 'WORK', 'CLUB']) {
          const body = {
            featureId: 'demo.' + product.toLowerCase(),
            product,
            name: 'Demo ' + product + ' (test only)',
            reason,
          }
          assert.equal((await call('/platform/catalog/features', body, owner)).status, 403)
          const key = secret(),
            results = await Promise.all([
              call('/platform/catalog/features', body, platform, key),
              call('/platform/catalog/features', body, platform, key),
            ])
          results.forEach((r) => ok(r, 'Feature'))
          assert.deepEqual(results[0].data, results[1].data)
          assert.equal(
            (await call('/platform/catalog/features', { ...body, name: 'overwrite' }, platform))
              .status,
            409,
          )
          assert.equal(
            (await call('/platform/catalog/features', { ...body, reason: '   ' }, platform)).status,
            400,
          )
        }
        assert.equal(
          (await publish('bad', { ...planBody, personalFeatureIds: ['unknown'] })).error.code,
          'FEATURE_UNKNOWN',
        )
        assert.equal(
          (
            await publish('bad', {
              ...planBody,
              seatTypes: [planBody.seatTypes[0], planBody.seatTypes[0]],
            })
          ).status,
          400,
        )
        assert.equal((await publish('bad/name')).status, 501)
        const key = secret(),
          result = ok(await publish('demo.base', planBody, key), 'PlanVersion')
        assert.deepEqual(ok(await publish('demo.base', planBody, key)), result)
        assert.equal((await publish('demo.base', { ...planBody, name: 'overwrite' })).status, 409)
        ok(
          await publish('demo.base', {
            ...planBody,
            planVersion: 2,
            name: 'Demo v2',
            personalFeatureIds: ['demo.shared', 'demo.club'],
            seatTypes: [
              {
                ...planBody.seatTypes[0],
                name: 'New version label',
                featureIds: ['demo.work', 'demo.shared'],
              },
              planBody.seatTypes[1],
            ],
          }),
          'PlanVersion',
        )
        ok(
          await publish('demo.other', {
            ...planBody,
            seatTypes: [{ seatTypeId: 'demo.new', name: 'New type', featureIds: ['demo.shared'] }],
          }),
          'PlanVersion',
        )
        const list = ok(await call('/catalog/plans', undefined, ownerClub), 'PlanVersionPage').items
        assert.deepEqual(
          list.find((p: any) => p.planId === 'demo.base' && p.planVersion === 1),
          result,
        )
        assert.equal(
          list
            .find((p: any) => p.planVersion === 2)
            .seatTypes.find((s: any) => s.seatTypeId === 'demo.standard').name,
          'New version label',
        )
        assert.equal(
          ok(await call('/catalog/features', undefined, member), 'FeaturePage').items.length,
          3,
        )
        assert.equal((await db.prepare('SELECT count(*) n FROM billing_subscription').first()).n, 0)
      },
    )
    await suite.test(
      'UAS-17/19/32: platform creates personal and tenant subscriptions atomically; catalog visibility grants no subscription',
      async () => {
        const b = {
          owner: { kind: 'USER', id: owner.userId },
          planId: 'demo.base',
          planVersion: 1,
          ...period,
          reason,
        }
        assert.equal((await call('/platform/subscriptions', b, owner)).status, 403)
        assert.equal((await call('/platform/subscriptions', b, reader)).status, 403)
        assert.equal(
          (
            await call(
              '/platform/subscriptions',
              { ...b, owner: { kind: 'USER', id: 'missing' } },
              platform,
            )
          ).status,
          404,
        )
        assert.equal(
          (await call('/platform/subscriptions', { ...b, endsAt: b.startsAt }, platform)).status,
          400,
        )
        assert.equal(
          (
            await call(
              '/platform/subscriptions',
              { ...b, startsAt: '2026-02-30T00:00:00Z' },
              platform,
            )
          ).status,
          400,
        )
        assert.equal(
          (await call('/platform/subscriptions', { ...b, seatQuantities: {} }, platform)).status,
          400,
        )
        assert.equal((await createSub({ kind: 'TENANT', id: alpha.tenantId })).status, 400)
        assert.equal(
          (
            await createSub(
              { kind: 'TENANT', id: alpha.tenantId },
              { seatQuantities: { unknown: 3 } },
            )
          ).status,
          400,
        )
        assert.equal(
          (
            await createSub(
              { kind: 'TENANT', id: beta.tenantId },
              { seatQuantities: { 'demo.standard': -1 } },
            )
          ).status,
          400,
        )
        assert.equal(
          (await createSub({ kind: 'USER', id: owner.userId }, { planVersion: 999 })).status,
          404,
        )
        const key = secret(),
          results = await Promise.all([
            createSub({ kind: 'USER', id: owner.userId }, {}, key),
            createSub({ kind: 'USER', id: owner.userId }, {}, key),
          ])
        personal = ok(results[0], 'Subscription')
        assert.deepEqual(ok(results[1]), personal)
        assert.equal(
          (await createSub({ kind: 'USER', id: other.userId }, {}, key)).error.code,
          'IDEMPOTENCY_CONFLICT',
        )
        assert.equal(personal.status, 'ACTIVE')
        team = ok(
          await createSub(
            { kind: 'TENANT', id: alpha.tenantId },
            { seatQuantities: { 'demo.standard': 2, 'demo.advanced': 1 } },
          ),
          'Subscription',
        )
        assert.equal((await pools()).length, 2)
        assert.equal(
          (await db.prepare('SELECT count(*) n FROM billing_seat_assignment').first()).n,
          0,
        )
        assert.equal((await db.prepare('SELECT count(*) n FROM billing_subscription').first()).n, 2)
        assert.equal(
          (
            await db
              .prepare('SELECT version FROM billing_user_revision WHERE user_id=?')
              .bind(owner.userId)
              .first()
          ).version,
          1,
        )
      },
    )
    await suite.test(
      'UAS-17/26/33: subscription lists enforce current user, tenant membership, manager and platform scopes',
      async () => {
        assert.deepEqual(
          ok(await call('/users/me/subscriptions', undefined, owner), 'SubscriptionPage').items,
          [personal],
        )
        assert.deepEqual(ok(await call('/users/me/subscriptions', undefined, ownerClub)).items, [
          personal,
        ])
        assert.equal(ok(await call('/users/me/subscriptions', undefined, other)).items.length, 0)
        assert.deepEqual(
          ok(
            await call('/tenants/' + alpha.tenantId + '/subscriptions', undefined, member),
            'SubscriptionPage',
          ).items,
          [team],
        )
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/subscriptions', undefined, other)).status,
          404,
        )
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/seat-pools', undefined, member)).status,
          403,
        )
        assert.equal((await call('/platform/subscriptions', undefined, owner)).status, 403)
        assert.equal(
          (await call('/platform/subscriptions/' + personal.subscriptionId, undefined, other))
            .status,
          403,
        )
        assert.equal(
          (await call('/users/me/subscriptions?userId=' + other.userId, undefined, owner)).status,
          400,
        )
        assert.equal(
          ok(await call('/platform/subscriptions', undefined, reader), 'SubscriptionPage').items
            .length,
          2,
        )
        // WORK-07/CLUB-07: platform inventory does not require tenant membership or permit writes.
        const inventoryPath = '/platform/subscriptions/' + team.subscriptionId + '/seat-pools'
        const inventory = ok(await call(inventoryPath, undefined, reader), 'SeatPoolPage')
        assert.deepEqual(inventory.items, await pools())
        assert.equal((await call(inventoryPath, undefined, owner)).status, 403)
        assert.equal((await call(inventoryPath, undefined, member)).status, 403)
        assert.equal((await call(inventoryPath, undefined, other)).status, 403)
        assert.equal(
          (await call('/platform/subscriptions/missing/seat-pools', undefined, reader)).status,
          404,
        )
        assert.equal(
          (await call(inventoryPath + '?userId=' + owner.userId, undefined, reader)).status,
          400,
        )
        assert.deepEqual(
          ok(
            await call(
              '/platform/subscriptions/' + personal.subscriptionId + '/seat-pools',
              undefined,
              reader,
            ),
          ).items,
          [],
        )
        assert.equal((await update(personal, { enabled: false }, owner)).status, 403)
        assert.equal(
          (await update(personal, { owner: { kind: 'USER', id: other.userId } })).status,
          400,
        )
        assert.equal((await update(personal, { seatQuantities: {} })).status, 400)
        assert.equal((await update(personal, {})).status, 400)
      },
    )
    await suite.test(
      'UAS-19/20/22/36/37: scheduled, expired and disabled states retain records; renew extends only the original end',
      async () => {
        personal = ok(
          await update(personal, { startsAt: date(now + 3600000), endsAt: date(now + 7200000) }),
          'Subscription',
        )
        assert.equal(personal.status, 'SCHEDULED')
        personal = ok(
          await update(personal, { startsAt: date(now - 7200000), endsAt: date(now - 3600000) }),
        )
        assert.equal(personal.status, 'EXPIRED')
        personal = ok(await update(personal, { enabled: false }))
        assert.equal(personal.status, 'DISABLED')
        const disabled = personal
        personal = ok(
          await call(
            '/platform/subscriptions/' + personal.subscriptionId + '/renew',
            { endsAt: date(now + 86400000), expectedVersion: personal.version, reason },
            platform,
          ),
          'Subscription',
        )
        assert.equal(personal.enabled, false)
        assert.equal(personal.startsAt, disabled.startsAt)
        assert.equal(
          (
            await call(
              '/platform/subscriptions/' + personal.subscriptionId + '/renew',
              { endsAt: personal.endsAt, expectedVersion: personal.version, reason },
              platform,
            )
          ).status,
          400,
        )
        personal = ok(await update(personal, { enabled: true }))
        assert.equal(personal.status, 'ACTIVE')
        const expiry = personal.endsAt
        personal = ok(await update(personal, { plan: { planId: 'demo.base', planVersion: 2 } }))
        assert.equal(personal.endsAt, expiry)
        assert.equal(personal.planVersion, 2)
        personal = ok(await update(personal, { plan: { planId: 'demo.other', planVersion: 1 } }))
        assert.equal(personal.endsAt, expiry)
        assert.equal(
          (
            await call(
              '/platform/subscriptions/' + personal.subscriptionId,
              undefined,
              platform,
              secret(),
              'DELETE',
            )
          ).status,
          501,
        )
        const subBefore = await getSub(personal.subscriptionId),
          key = secret(),
          patch = { enabled: false }
        const races = await Promise.all([
          update(subBefore, patch, platform, key),
          update(subBefore, patch, platform, key),
        ])
        personal = ok(races[0])
        assert.deepEqual(ok(races[1]), personal)
        assert.equal((await update(subBefore, { enabled: true })).error.code, 'VERSION_CONFLICT')
      },
    )
    async function assignFixture(id: string, m: any, type = 'demo.standard', status = 'ASSIGNED') {
      await db
        .prepare(
          'INSERT INTO billing_seat_assignment(id,subscription_id,seat_type_id,tenant_id,membership_id,user_id,status,assigned_at,ended_at,end_reason) VALUES (?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          team.subscriptionId,
          type,
          alpha.tenantId,
          m.membershipId,
          m.userId,
          status,
          now,
          status === 'ENDED' ? now : null,
          status === 'ENDED' ? 'RELEASED' : null,
        )
        .run()
    }
    await suite.test(
      'UAS-19/21/22/36/37: retained allocations constrain capacity and type changes even after expiry; history never revives',
      async () => {
        await assignFixture('fixture-active', memberRow)
        await assignFixture('fixture-ended', outsiderRow, 'demo.advanced', 'ENDED')
        const seatBefore = (
          await db.prepare('SELECT * FROM billing_seat_assignment ORDER BY id').all()
        ).results
        team = ok(await update(team, { endsAt: date(now - 1000) }))
        assert.equal(team.status, 'EXPIRED')
        let snapshot = await pools()
        assert.equal(snapshot.find((p: any) => p.seatTypeId === 'demo.standard').assignedCount, 1)
        const oldEnd = team.endsAt
        team = ok(
          await update(team, { seatQuantities: { 'demo.standard': 3, 'demo.advanced': 2 } }),
        )
        assert.equal(team.endsAt, oldEnd)
        const before = await getSub(team.subscriptionId),
          beforePools = await pools()
        assert.equal(
          (await update(team, { seatQuantities: { 'demo.standard': 0, 'demo.advanced': 4 } })).error
            .code,
          'CAPACITY_CONFLICT',
        )
        assert.equal(
          (await update(team, { seatQuantities: { 'demo.advanced': 2 } })).error.code,
          'CAPACITY_CONFLICT',
        )
        assert.deepEqual(await getSub(team.subscriptionId), before)
        assert.deepEqual(await pools(), beforePools)
        assert.equal(
          (await update(team, { plan: { planId: 'demo.other', planVersion: 1 } })).status,
          400,
        )
        assert.equal(
          (
            await update(team, {
              plan: { planId: 'demo.other', planVersion: 1 },
              seatQuantities: { 'demo.new': 5 },
            })
          ).error.code,
          'CAPACITY_CONFLICT',
        )
        team = ok(
          await update(team, {
            plan: { planId: 'demo.base', planVersion: 2 },
            seatQuantities: { 'demo.standard': 1, 'demo.advanced': 0 },
          }),
        )
        assert.equal(team.endsAt, oldEnd)
        assert.equal((await pools()).find((p: any) => p.seatTypeId === 'demo.standard').quantity, 1)
        team = ok(
          await call(
            '/platform/subscriptions/' + team.subscriptionId + '/renew',
            { endsAt: date(now + 86400000), expectedVersion: team.version, reason },
            platform,
          ),
        )
        assert.equal(team.status, 'ACTIVE')
        assert.deepEqual(
          (await db.prepare('SELECT * FROM billing_seat_assignment ORDER BY id').all()).results,
          seatBefore,
        )
        // Stand-in for AUTH-09's later public release route: no synthetic release in production code.
        await db
          .prepare(
            "UPDATE billing_seat_assignment SET status='ENDED',ended_at=?,end_reason='RELEASED',version=version+1 WHERE id='fixture-active'",
          )
          .bind(Date.now())
          .run()
        team = ok(
          await update(team, {
            plan: { planId: 'demo.other', planVersion: 1 },
            seatQuantities: { 'demo.new': 2 },
          }),
        )
        assert.deepEqual(
          (await pools()).map((p: any) => p.seatTypeId),
          ['demo.new'],
        )
        assert.equal(
          (
            await db
              .prepare(
                "SELECT status FROM billing_seat_pool WHERE subscription_id=? AND seat_type_id='demo.standard'",
              )
              .bind(team.subscriptionId)
              .first()
          ).status,
          'RETIRED',
        )
        team = ok(
          await update(team, {
            plan: { planId: 'demo.base', planVersion: 1 },
            seatQuantities: { 'demo.standard': 2, 'demo.advanced': 1 },
          }),
        )
        assert.equal(
          (
            await db
              .prepare("SELECT count(*) n FROM billing_seat_assignment WHERE status='ASSIGNED'")
              .first()
          ).n,
          0,
        )
        assert.equal(
          (await pools()).find((p: any) => p.seatTypeId === 'demo.standard').assignedCount,
          0,
        )
        assert.equal(
          (await db.prepare('SELECT count(*) n FROM billing_seat_assignment').first()).n,
          2,
        )
      },
    )
    await suite.test(
      'UAS-19/26: late capacity contention and audit failure roll back subscription, pool, revision and receipt together',
      async () => {
        const before = await getSub(team.subscriptionId),
          beforePools = await pools()
        const revision = (
          await db
            .prepare('SELECT entitlement_revision FROM auth_managed_tenant WHERE space_id=?')
            .bind(alpha.tenantId)
            .first()
        ).entitlement_revision
        await db
          .prepare(
            `CREATE TRIGGER late_assignment BEFORE UPDATE ON billing_subscription WHEN OLD.id='${team.subscriptionId}' BEGIN INSERT INTO billing_seat_assignment(id,subscription_id,seat_type_id,tenant_id,membership_id,user_id,status,assigned_at) VALUES ('late-fixture',OLD.id,'demo.standard','${alpha.tenantId}','${memberRow.membershipId}','${member.userId}','ASSIGNED',${now}); END`,
          )
          .run()
        try {
          assert.equal(
            (await update(team, { seatQuantities: { 'demo.standard': 0, 'demo.advanced': 1 } }))
              .status,
            409,
          )
          assert.equal(
            await db
              .prepare("SELECT id FROM billing_seat_assignment WHERE id='late-fixture'")
              .first(),
            null,
          )
        } finally {
          await db.prepare('DROP TRIGGER late_assignment').run()
        }
        assert.deepEqual(await getSub(team.subscriptionId), before)
        assert.deepEqual(await pools(), beforePools)
        await db
          .prepare(
            "CREATE TRIGGER fail_commercial_audit BEFORE INSERT ON auth_management_audit BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END",
          )
          .run()
        const key = secret()
        try {
          assert.equal(
            (
              await update(
                team,
                { enabled: false, seatQuantities: { 'demo.standard': 7 } },
                platform,
                key,
              )
            ).status,
            503,
          )
        } finally {
          await db.prepare('DROP TRIGGER fail_commercial_audit').run()
        }
        assert.deepEqual(await getSub(team.subscriptionId), before)
        assert.deepEqual(await pools(), beforePools)
        assert.equal(
          (
            await db
              .prepare('SELECT entitlement_revision FROM auth_managed_tenant WHERE space_id=?')
              .bind(alpha.tenantId)
              .first()
          ).entitlement_revision,
          revision,
        )
        assert.equal(
          await db
            .prepare('SELECT * FROM auth_management_result WHERE idempotency_key_hash=?')
            .bind(hash(key))
            .first(),
          null,
        )
        team = ok(
          await update(
            team,
            { enabled: false, seatQuantities: { 'demo.standard': 7 } },
            platform,
            key,
          ),
        )
        assert.equal(team.enabled, false)
        // Distinct keys at the same version cannot both overwrite the subscription.
        const races = await Promise.all([
          update(team, { enabled: true }),
          update(team, { endsAt: date(now + 172800000) }),
        ])
        assert.deepEqual(races.map((r) => r.status).sort(), [200, 409])
        team = await getSub(team.subscriptionId)
      },
    )
    await suite.test(
      'UAS-20/35/36: tenant disable blocks tenant reads while platform maintains subscriptions without extending clocks',
      async () => {
        const oldTeam = team,
          oldPersonal = personal
        let t = ok(await call('/platform/tenants/' + alpha.tenantId, undefined, platform))
        t = ok(
          await call(
            '/platform/tenants/' + alpha.tenantId + '/disable',
            { expectedVersion: t.version, reason },
            platform,
          ),
        )
        for (const path of ['subscriptions', 'seat-pools', 'audit-events'])
          assert.equal(
            (await call('/tenants/' + alpha.tenantId + '/' + path, undefined, owner)).error.code,
            'TENANT_DISABLED',
          )
        assert.deepEqual(await getSub(team.subscriptionId), oldTeam)
        assert.ok(
          ok(
            await call(
              '/platform/subscriptions/' + team.subscriptionId + '/seat-pools',
              undefined,
              reader,
            ),
          ).items.length > 0,
        )
        assert.deepEqual(ok(await call('/users/me/subscriptions', undefined, owner)).items, [
          oldPersonal,
        ])
        assert.equal(
          ok(await call('/tenants/' + beta.tenantId + '/subscriptions', undefined, other)).items
            .length,
          0,
        )
        team = ok(await update(team, { enabled: false }))
        const expires = team.endsAt
        team = ok(await update(team, { enabled: true }))
        assert.equal(team.endsAt, expires)
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/subscriptions', undefined, owner)).status,
          403,
        )
        ok(
          await call(
            '/platform/tenants/' + alpha.tenantId + '/enable',
            { expectedVersion: t.version, reason },
            platform,
          ),
        )
        assert.deepEqual(
          ok(await call('/tenants/' + alpha.tenantId + '/subscriptions', undefined, member)).items,
          [team],
        )
        assert.equal((await pools()).find((p: any) => p.seatTypeId === 'demo.standard').quantity, 7)
      },
    )
    await suite.test(
      'UAS-26/32: scoped pagination, management audit and revocation protect reads and idempotent results',
      async () => {
        const first = ok(
          await call('/platform/subscriptions?limit=1', undefined, platform),
          'SubscriptionPage',
        )
        assert.ok(first.nextCursor)
        const next = ok(
          await call(
            '/platform/subscriptions?limit=1&cursor=' + first.nextCursor,
            undefined,
            platform,
          ),
          'SubscriptionPage',
        )
        assert.notEqual(first.items[0].subscriptionId, next.items[0].subscriptionId)
        assert.equal(
          (
            await call(
              '/platform/subscriptions?limit=1&cursor=' + first.nextCursor,
              undefined,
              reader,
            )
          ).status,
          400,
        )
        assert.equal(
          (
            await call(
              '/users/me/subscriptions?limit=1&cursor=' + first.nextCursor,
              undefined,
              platform,
            )
          ).status,
          400,
        )
        assert.equal((await call('/catalog/plans?limit=101', undefined, owner)).status, 400)
        const plans = ok(await call('/catalog/plans?limit=1', undefined, owner), 'PlanVersionPage')
        const nextPlan = ok(
          await call('/catalog/plans?limit=1&cursor=' + plans.nextCursor, undefined, owner),
          'PlanVersionPage',
        )
        assert.notDeepEqual(plans.items, nextPlan.items)
        // The preceding capacity test retires omitted types; restore two current pools for real pagination.
        team = ok(
          await update(team, { seatQuantities: { 'demo.standard': 7, 'demo.advanced': 1 } }),
        )
        const poolPath = '/platform/subscriptions/' + team.subscriptionId + '/seat-pools'
        const poolPage = ok(await call(poolPath + '?limit=1', undefined, reader))
        assert.ok(poolPage.nextCursor)
        const poolNext = ok(
          await call(poolPath + '?limit=1&cursor=' + poolPage.nextCursor, undefined, reader),
        )
        assert.notEqual(poolPage.items[0].seatTypeId, poolNext.items[0].seatTypeId)
        assert.equal(
          (
            await call(
              '/platform/subscriptions/' +
                personal.subscriptionId +
                '/seat-pools?limit=1&cursor=' +
                poolPage.nextCursor,
              undefined,
              reader,
            )
          ).status,
          400,
        )
        await permission(reader, 'SUBSCRIPTION_READ', false)
        assert.equal((await call(poolPath, undefined, reader)).status, 403)
        await permission(reader, 'SUBSCRIPTION_READ')
        await permission(platform, 'SUBSCRIPTION_READ', false)
        assert.equal(
          (
            await call(
              '/platform/subscriptions?limit=1&cursor=' + first.nextCursor,
              undefined,
              platform,
            )
          ).status,
          403,
        )
        await permission(platform, 'SUBSCRIPTION_READ')
        assert.equal(
          (
            await call(
              '/platform/subscriptions?limit=1&cursor=' + first.nextCursor,
              undefined,
              platform,
            )
          ).status,
          400,
        )
        const audits = ok(
          await call('/platform/audit-events?limit=100', undefined, reader),
          'AuditEventPage',
        ).items
        assert.ok(audits.some((a: any) => a.operation === 'subscription.renew'))
        const tenantAudit = ok(
          await call('/tenants/' + alpha.tenantId + '/audit-events', undefined, owner),
          'AuditEventPage',
        ).items
        assert.ok(tenantAudit.length)
        assert.ok(tenantAudit.every((a: any) => a.tenantId === alpha.tenantId))
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/audit-events', undefined, member)).status,
          403,
        )
        assert.equal(
          ok(await call('/tenants/' + beta.tenantId + '/audit-events', undefined, other)).items
            .length,
          0,
        )
        assert.equal((await call('/platform/audit-events', undefined, owner)).status, 403)
        const raw = JSON.stringify(
          (await db.prepare('SELECT * FROM auth_management_audit').all()).results,
        )
        for (const secretValue of [platform.accessToken, owner.accessToken, '+8613800000201'])
          assert.ok(!raw.includes(secretValue))
        const key = secret(),
          before = personal
        personal = ok(await update(before, { enabled: true }, platform, key))
        await permission(platform, 'SUBSCRIPTION_WRITE', false)
        assert.equal((await update(before, { enabled: true }, platform, key)).status, 403)
        await permission(platform, 'SUBSCRIPTION_WRITE')
        assert.deepEqual(ok(await update(before, { enabled: true }, platform, key)), personal)
        assert.equal(
          (await update(before, { enabled: false }, platform, key)).error.code,
          'IDEMPOTENCY_CONFLICT',
        )
        ok(await call('/sessions/current/logout', {}, platform))
        assert.equal((await update(before, { enabled: true }, platform, key)).status, 401)
      },
    )
  } finally {
    await p.dispose()
  }
})
