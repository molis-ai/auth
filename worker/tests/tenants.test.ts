import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-07 real managed tenants, directed invitations and ownership lifecycle', async (suite) => {
  const origin = 'http://127.0.0.1:8787'
  const barriers = new Map<
    string,
    {
      reached: ReturnType<typeof Promise.withResolvers<void>>
      proceed: ReturnType<typeof Promise.withResolvers<void>>
    }
  >()
  const p = await getRustProxy(
    {
      AUTH_ORIGIN: origin,
      UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
        environmentId: 'unified-local',
        kind: 'LOCAL',
        authOrigin: origin,
        deliveryMode: 'MOCK',
        providerMode: 'MOCK',
      }),
    },
    async (request) => {
      const barrier = barriers.get(new URL(request.url).pathname.slice(1))
      assert.ok(barrier, request.url)
      barrier.reached.resolve()
      await barrier.proceed.promise
      return new Response('continue')
    },
    undefined,
    {
      fixtureEntrypoint: readFileSync(
        new URL('./fixtures/d1-request-barrier.mjs', import.meta.url),
        'utf8',
      ),
    },
  )
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
      barrier?: string,
      callerOrigin?: string,
    ) {
      const r = await p.fetch(
        new Request(origin + '/api/v1' + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
            ...(actor ? { Authorization: 'Bearer ' + actor.accessToken } : {}),
            ...(proof ? { 'X-Auth-Initiator-Proof': proof } : {}),
            ...(barrier ? { 'X-Fixture-Barrier': barrier } : {}),
            ...(callerOrigin ? { Origin: callerOrigin } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      )
      const counts = r.headers.get('X-Fixture-D1-Calls')
      const plans = r.headers.get('X-Fixture-Query-Plans')
      return {
        status: r.status,
        ...(await r.json()),
        ...(counts
          ? {
              d1Calls: JSON.parse(counts),
              protectedQueries: Number(r.headers.get('X-Fixture-Protected-Queries')),
            }
          : {}),
        ...(plans ? { plans: JSON.parse(plans) as string[][] } : {}),
      }
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
                password: 'Tenant-Fixture-Quasar-48',
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
    const platform = await signup('+8613800000101'),
      owner = await signup('+8613800000102'),
      member = await signup('+8613800000103'),
      other = await signup('+8613800000104'),
      outsider = await signup('+8613800000105'),
      reader = await signup('+8613800000106')
    const ownerClub = await signup('+8613800000102', false, true)
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
    for (const scope of ['TENANT_CREATE', 'TENANT_READ', 'TENANT_STATUS'])
      await permission(platform, scope)
    await permission(reader, 'TENANT_READ')
    async function create(name: string, ownerId: string) {
      return ok(
        await call(
          '/platform/tenants',
          { name, ownerUserId: ownerId, reason: 'Isolated acceptance fixture' },
          platform,
        ),
        'PlatformTenantView',
      )
    }
    async function tenant(id: string, actor = owner) {
      return ok(await call('/tenants/' + id, undefined, actor), 'TenantView')
    }
    async function members(id: string, actor = owner) {
      return ok(await call('/tenants/' + id + '/members', undefined, actor), 'MembershipPage').items
    }
    async function invite(id: string, kind: string, value: string, actor = owner, key = secret()) {
      return ok(
        await call('/tenants/' + id + '/invitations', { target: { kind, value } }, actor, key),
        'Invitation',
      )
    }
    async function accept(invitation: any, actor: any, key = secret()) {
      return ok(
        await call(
          '/invitations/' + invitation.invitationId + '/accept',
          { expectedVersion: invitation.version },
          actor,
          key,
        ),
        'InvitationAcceptResult',
      )
    }
    async function role(id: string, m: any, role: string, actor = owner) {
      return ok(
        await call(
          '/tenants/' + id + '/members/' + m.membershipId + '/role',
          { role, expectedVersion: m.version },
          actor,
          secret(),
          'PATCH',
        ),
        'Membership',
      )
    }
    let alpha: any, beta: any, mMember: any, mOther: any, pending: any
    await suite.test(
      'UAS-12/34: only explicit platform permissions create tenants; concurrent retries create one owner and no paid grants',
      async () => {
        const body = {
          name: 'Alpha',
          ownerUserId: owner.userId,
          reason: 'Isolated acceptance fixture',
        }
        assert.equal((await call('/platform/tenants', body, owner)).status, 403)
        assert.equal((await call('/platform/tenants', body, reader)).status, 403)
        assert.equal(
          (await call('/platform/tenants', { ...body, platformAdmin: true }, platform)).status,
          400,
        )
        assert.equal(
          (await call('/platform/tenants', { ...body, ownerUserId: 'unknown-user' }, platform))
            .status,
          404,
        )
        const key = secret()
        const both = await Promise.all([
          call('/platform/tenants', body, platform, key),
          call('/platform/tenants', body, platform, key),
        ])
        alpha = ok(both[0], 'PlatformTenantView')
        assert.deepEqual(ok(both[1]), alpha)
        assert.equal((await db.prepare('SELECT count(*) n FROM auth_tenant').first()).n, 1)
        assert.equal(
          (
            await db
              .prepare(
                "SELECT count(*) n FROM auth_tenant_membership WHERE tenant_id=? AND role='OWNER' AND status='ACTIVE'",
              )
              .bind(alpha.tenantId)
              .first()
          ).n,
          1,
        )
        assert.equal(
          (await call('/platform/tenants', { ...body, name: 'different' }, platform, key)).error
            .code,
          'IDEMPOTENCY_CONFLICT',
        )
        await permission(platform, 'TENANT_CREATE', false)
        assert.equal((await call('/platform/tenants', body, platform, key)).status, 403)
        await permission(platform, 'TENANT_CREATE')
        beta = await create('Beta', other.userId)
        assert.equal((await tenant(alpha.tenantId, ownerClub)).tenantId, alpha.tenantId)
        const mine = ok(await call('/tenants', undefined, owner), 'MyTenantsPage')
        assert.equal(mine.items[0].membershipVersion, 0)
        assert.equal(mine.items.length, 1)
        assert.equal((await call('/tenants/' + alpha.tenantId, undefined, outsider)).status, 404)
        assert.equal((await call('/tenants/' + alpha.tenantId, undefined, platform)).status, 404)
        assert.equal(
          ok(await call('/platform/tenants', undefined, reader), 'PlatformTenantViewPage').items
            .length,
          2,
        )
      },
    )
    await suite.test(
      'member directory exposes names and verified email only inside the tenant',
      async () => {
        await db
          .prepare('UPDATE auth_user SET display_name=? WHERE id=?')
          .bind('林小雨', owner.userId)
          .run()
        let row = (await members(alpha.tenantId))[0]
        assert.equal(row.displayName, '林小雨')
        assert.equal(row.email, null)
        await db
          .prepare(
            'INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)',
          )
          .bind('directory-email', owner.userId, 'directory@example.test', Date.now())
          .run()
        row = (await members(alpha.tenantId))[0]
        assert.equal(row.email, null)
        await db
          .prepare('UPDATE auth_user_email SET verified_at=? WHERE id=?')
          .bind(Date.now(), 'directory-email')
          .run()
        assert.equal((await members(alpha.tenantId))[0].email, 'directory@example.test')
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/members', undefined, outsider)).status,
          404,
        )
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/members', undefined, platform)).status,
          404,
        )
      },
    )
    await suite.test(
      'UAS-13/28: directed invitations require current verified identity; mock notifications do not grant membership',
      async () => {
        const countBefore = (await db.prepare('SELECT count(*) n FROM auth_user').first()).n
        const emailInvite = await invite(alpha.tenantId, 'EMAIL', 'NEW-MEMBER@example.test')
        assert.equal((await db.prepare('SELECT count(*) n FROM auth_user').first()).n, countBefore)
        assert.equal((await members(alpha.tenantId)).length, 1)
        const outbox = await db.prepare('SELECT * FROM auth_mock_notification').all()
        assert.equal(outbox.results.length, 1)
        assert.equal(outbox.results[0].destination, 'new-member@example.test')
        assert.equal(JSON.parse(outbox.results[0].payload).invitationId, emailInvite.invitationId)
        assert.ok(!JSON.stringify(emailInvite).includes('new-member@example.test'))
        await db
          .prepare('INSERT INTO auth_user_email VALUES (?,?,?,NULL,?)')
          .bind('unverified-invite-email', outsider.userId, 'new-member@example.test', Date.now())
          .run()
        assert.equal(
          ok(await call('/invitations', undefined, outsider), 'InvitationPage').items.length,
          0,
        )
        assert.equal(
          (
            await call(
              '/invitations/' + emailInvite.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          404,
        )
        await db.prepare("DELETE FROM auth_user_email WHERE id='unverified-invite-email'").run()
        const newlyRegistered = await signup('new-member@example.test', true, true)
        assert.equal(
          ok(await call('/invitations', undefined, newlyRegistered), 'InvitationPage').items[0]
            .invitationId,
          emailInvite.invitationId,
        )
        await accept(emailInvite, newlyRegistered)
        const sms = await invite(alpha.tenantId, 'PHONE', '+8613800000103')
        const key = secret(),
          result = await accept(sms, member, key)
        mMember = result.membership
        assert.equal(mMember.role, 'MEMBER')
        assert.deepEqual(await accept(sms, member, key), result)
        assert.equal(
          (
            await call(
              '/invitations/' + sms.invitationId + '/accept',
              { expectedVersion: 0 },
              member,
            )
          ).status,
          409,
        )
        assert.equal(
          (
            await db
              .prepare("SELECT count(*) n FROM auth_mock_notification WHERE channel='SMS'")
              .first()
          ).n,
          1,
        )
        const directed = await invite(alpha.tenantId, 'USER', other.userId)
        assert.equal(
          (
            await call(
              '/invitations/' + directed.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          404,
        )
        mOther = (await accept(directed, other)).membership
        assert.equal(ok(await call('/tenants', undefined, other), 'MyTenantsPage').items.length, 2)
      },
    )
    await suite.test(
      'UAS-13/16: role and profile management stay within the tenant; OWNER cannot be changed through role APIs',
      async () => {
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/invitations',
              { target: { kind: 'USER', value: outsider.userId } },
              member,
            )
          ).status,
          403,
        )
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/members/' + mOther.membershipId + '/role',
              { role: 'ADMIN', expectedVersion: 0 },
              member,
              secret(),
              'PATCH',
            )
          ).status,
          403,
        )
        mMember = await role(alpha.tenantId, mMember, 'ADMIN')
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/members/' + mOther.membershipId + '/role',
              { role: 'ADMIN', expectedVersion: 0 },
              member,
              secret(),
              'PATCH',
            )
          ).status,
          403,
        )
        const ownerMembership = (await members(alpha.tenantId)).find((x: any) => x.role === 'OWNER')
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/members/' + ownerMembership.membershipId + '/role',
              { role: 'MEMBER', expectedVersion: ownerMembership.version },
              owner,
              secret(),
              'PATCH',
            )
          ).error.code,
          'OWNER_TRANSFER_REQUIRED',
        )
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/members/' + mOther.membershipId + '/role',
              { role: 'OWNER', expectedVersion: 0 },
              owner,
              secret(),
              'PATCH',
            )
          ).status,
          400,
        )
        assert.equal(
          (
            await call(
              '/tenants/' + beta.tenantId + '/members/' + mOther.membershipId + '/role',
              { role: 'ADMIN', expectedVersion: 0 },
              other,
              secret(),
              'PATCH',
            )
          ).status,
          404,
        )
        const before = await tenant(alpha.tenantId)
        const body = { name: 'Alpha renamed', expectedVersion: before.version },
          key = secret()
        const updated = ok(
          await call('/tenants/' + alpha.tenantId, body, member, key, 'PATCH'),
          'TenantView',
        )
        assert.equal((await tenant(alpha.tenantId, ownerClub)).name, updated.name)
        assert.equal(
          (await call('/tenants/' + alpha.tenantId, body, member, secret(), 'PATCH')).status,
          409,
        )
        mMember = await role(alpha.tenantId, mMember, 'MEMBER')
        assert.equal(
          (await call('/tenants/' + alpha.tenantId, body, member, key, 'PATCH')).status,
          403,
        )
        mMember = await role(alpha.tenantId, mMember, 'ADMIN')
        assert.equal(
          (
            await call(
              '/platform/tenants/' + alpha.tenantId + '/disable',
              { expectedVersion: updated.version, reason: 'test' },
              member,
            )
          ).status,
          403,
        )
      },
    )
    await suite.test(
      'UAS-13/26: decline, revoke, expiry and racing acceptance have one terminal outcome',
      async () => {
        const declined = await invite(alpha.tenantId, 'USER', outsider.userId)
        ok(
          await call(
            '/invitations/' + declined.invitationId + '/decline',
            { expectedVersion: 0 },
            outsider,
          ),
          'Invitation',
        )
        assert.equal(
          (
            await call(
              '/invitations/' + declined.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          409,
        )
        const revoked = await invite(alpha.tenantId, 'USER', outsider.userId)
        ok(
          await call(
            '/tenants/' + alpha.tenantId + '/invitations/' + revoked.invitationId + '/revoke',
            { expectedVersion: 0 },
            member,
          ),
          'Invitation',
        )
        assert.equal(
          (
            await call(
              '/invitations/' + revoked.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          409,
        )
        const expired = await invite(alpha.tenantId, 'USER', outsider.userId)
        await db
          .prepare('UPDATE auth_tenant_invitation SET expires_at=created_at+1 WHERE id=?')
          .bind(expired.invitationId)
          .run()
        await new Promise((r) => setTimeout(r, 5))
        assert.equal(
          (
            await call(
              '/invitations/' + expired.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          409,
        )
        const race = await invite(alpha.tenantId, 'USER', outsider.userId)
        const results = await Promise.all([
          call('/invitations/' + race.invitationId + '/accept', { expectedVersion: 0 }, outsider),
          call('/invitations/' + race.invitationId + '/decline', { expectedVersion: 0 }, outsider),
        ])
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409])
        const accepted =
          (
            await db
              .prepare('SELECT status FROM auth_tenant_invitation WHERE id=?')
              .bind(race.invitationId)
              .first()
          ).status === 'ACCEPTED'
        assert.equal(
          (await members(alpha.tenantId)).filter((m: any) => m.userId === outsider.userId).length,
          accepted ? 1 : 0,
        )
        const duplicates = await Promise.all([
          invite(alpha.tenantId, 'USER', other.userId),
          invite(alpha.tenantId, 'PHONE', '+8613800000104'),
        ])
        for (const i of duplicates)
          assert.equal((await accept(i, other)).membership.membershipId, mOther.membershipId)
        assert.equal(
          (await members(alpha.tenantId)).filter((m: any) => m.userId === other.userId).length,
          1,
        )
        pending = await invite(alpha.tenantId, 'USER', reader.userId)
      },
    )
    let transfer: any, priorOwner: any
    await suite.test(
      'UAS-13/26: invitation, mock notification, audit and receipt commit together',
      async () => {
        const before = await db.prepare('SELECT count(*) n FROM auth_tenant_invitation').first()
        const deliveries = await db.prepare('SELECT count(*) n FROM auth_mock_notification').first()
        await db
          .prepare(
            "CREATE TRIGGER fail_invitation_audit BEFORE INSERT ON auth_audit_event WHEN NEW.action='invitation.create' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
          )
          .run()
        const r = await call(
          '/tenants/' + alpha.tenantId + '/invitations',
          { target: { kind: 'EMAIL', value: 'rollback@example.test' } },
          owner,
        )
        assert.equal(r.status, 503)
        assert.equal(
          (await db.prepare('SELECT count(*) n FROM auth_tenant_invitation').first()).n,
          before.n,
        )
        assert.equal(
          (await db.prepare('SELECT count(*) n FROM auth_mock_notification').first()).n,
          deliveries.n,
        )
        await db.prepare('DROP TRIGGER fail_invitation_audit').run()
      },
    )
    await suite.test(
      'UAS-16/42: only the owner starts transfers to an active same-tenant member; cancel and expiry cannot transfer',
      async () => {
        const t = await tenant(alpha.tenantId)
        const body = { targetMembershipId: mOther.membershipId, expectedVersion: t.version }
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/ownership-transfers', body, member)).status,
          403,
        )
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/ownership-transfers',
              { ...body, targetMembershipId: t.membershipId },
              owner,
            )
          ).status,
          400,
        )
        const betaOwner = await tenant(beta.tenantId, other)
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/ownership-transfers',
              { ...body, targetMembershipId: betaOwner.membershipId },
              owner,
            )
          ).status,
          404,
        )
        const first = ok(
          await call('/tenants/' + alpha.tenantId + '/ownership-transfers', body, owner),
          'OwnershipTransfer',
        )
        assert.equal(
          (await call('/tenants/' + alpha.tenantId + '/ownership-transfers', body, owner)).status,
          409,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + first.transferId + '/accept',
              { expectedVersion: 0 },
              owner,
            )
          ).status,
          404,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + first.transferId + '/accept',
              { expectedVersion: 0 },
              reader,
            )
          ).status,
          404,
        )
        assert.equal(
          ok(await call('/ownership-transfers', undefined, reader), 'OwnershipTransferPage').items
            .length,
          0,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + first.transferId + '/cancel',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          404,
        )
        const key = secret()
        const cancelled = ok(
          await call(
            '/ownership-transfers/' + first.transferId + '/cancel',
            { expectedVersion: 0 },
            owner,
            key,
          ),
          'OwnershipTransfer',
        )
        assert.deepEqual(
          ok(
            await call(
              '/ownership-transfers/' + first.transferId + '/cancel',
              { expectedVersion: 0 },
              owner,
              key,
            ),
          ),
          cancelled,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + first.transferId + '/accept',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          409,
        )
        const exp = ok(
          await call('/tenants/' + alpha.tenantId + '/ownership-transfers', body, owner),
        )
        await db
          .prepare('UPDATE auth_ownership_transfer SET expires_at=created_at+1 WHERE id=?')
          .bind(exp.transferId)
          .run()
        await new Promise((r) => setTimeout(r, 5))
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + exp.transferId + '/accept',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          409,
        )
        assert.equal(
          ok(
            await call('/ownership-transfers', undefined, other),
            'OwnershipTransferPage',
          ).items.find((x: any) => x.transferId === exp.transferId).status,
          'EXPIRED',
        )
        transfer = ok(
          await call('/tenants/' + alpha.tenantId + '/ownership-transfers', body, owner),
          'OwnershipTransfer',
        )
      },
    )
    await suite.test(
      'UAS-16/42: ownership swaps atomically, demotes former owner to MEMBER and retries safely',
      async () => {
        priorOwner = (await members(alpha.tenantId)).find((x: any) => x.role === 'OWNER')
        await db
          .prepare(
            "CREATE TRIGGER fail_owner_promotion BEFORE UPDATE OF role ON auth_tenant_membership WHEN NEW.role='OWNER' AND OLD.role<>'OWNER' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END",
          )
          .run()
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + transfer.transferId + '/accept',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          503,
        )
        assert.equal((await tenant(alpha.tenantId)).myRole, 'OWNER')
        assert.equal(
          (await members(alpha.tenantId)).filter((x: any) => x.role === 'OWNER').length,
          1,
        )
        await db.prepare('DROP TRIGGER fail_owner_promotion').run()
        const key = secret()
        const results = await Promise.all([
          call(
            '/ownership-transfers/' + transfer.transferId + '/accept',
            { expectedVersion: 0 },
            other,
            key,
          ),
          call(
            '/ownership-transfers/' + transfer.transferId + '/accept',
            { expectedVersion: 0 },
            other,
            key,
          ),
        ])
        const accepted = ok(results[0], 'TransferAcceptResult')
        assert.deepEqual(ok(results[1]), accepted)
        assert.equal(accepted.previousOwner.role, 'MEMBER')
        assert.equal(accepted.owner.role, 'OWNER')
        assert.equal(accepted.previousOwner.membershipId, priorOwner.membershipId)
        priorOwner = accepted.previousOwner
        mOther = accepted.owner
        assert.equal((await tenant(alpha.tenantId, other)).myRole, 'OWNER')
        assert.equal((await tenant(alpha.tenantId, ownerClub)).myRole, 'MEMBER')
        assert.equal(
          (await members(alpha.tenantId)).filter((x: any) => x.role === 'OWNER').length,
          1,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + transfer.transferId + '/accept',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          409,
        )
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/members/' + mMember.membershipId + '/role',
              { role: 'MEMBER', expectedVersion: mMember.version },
              owner,
              secret(),
              'PATCH',
            )
          ).status,
          403,
        )
      },
    )
    await suite.test(
      'UAS-14/16: real exits cancel pending transfers, release seats and preserve membership incarnation boundaries',
      async () => {
        const t = await tenant(alpha.tenantId, other)
        const pending = ok(
          await call(
            '/tenants/' + alpha.tenantId + '/ownership-transfers',
            { targetMembershipId: mMember.membershipId, expectedVersion: t.version },
            other,
          ),
        )
        const left = ok(
          await call(
            '/tenants/' + alpha.tenantId + '/leave',
            { expectedVersion: mMember.version },
            member,
          ),
          'Membership',
        )
        assert.equal(left.status, 'LEFT')
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + pending.transferId + '/accept',
              { expectedVersion: 0 },
              member,
            )
          ).status,
          404,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + pending.transferId + '/cancel',
              { expectedVersion: 0 },
              other,
            )
          ).status,
          409,
        )
        assert.equal(
          (
            await db
              .prepare('SELECT status FROM auth_ownership_transfer WHERE id=?')
              .bind(pending.transferId)
              .first()
          ).status,
          'CANCELLED',
        )
        const oldId = mMember.membershipId
        mMember = (await accept(await invite(alpha.tenantId, 'USER', member.userId, other), member))
          .membership
        assert.notEqual(mMember.membershipId, oldId)
        assert.equal(mMember.role, 'MEMBER')
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId + '/leave',
              { expectedVersion: mOther.version },
              other,
            )
          ).error.code,
          'OWNER_TRANSFER_REQUIRED',
        )
        const priorId = priorOwner.membershipId,
          leaveKey = secret()
        const exitBody = { expectedVersion: priorOwner.version }
        const exited = ok(
          await call('/tenants/' + alpha.tenantId + '/leave', exitBody, owner, leaveKey),
          'Membership',
        )
        assert.equal(exited.status, 'LEFT')
        assert.deepEqual(
          ok(await call('/tenants/' + alpha.tenantId + '/leave', exitBody, owner, leaveKey)),
          exited,
        )
        assert.equal((await call('/tenants/' + alpha.tenantId, undefined, owner)).status, 404)
        priorOwner = (
          await accept(await invite(alpha.tenantId, 'USER', owner.userId, other), owner)
        ).membership
        assert.notEqual(priorOwner.membershipId, priorId)
        // The old receipt remains a historical result and cannot end the new membership.
        assert.deepEqual(
          ok(await call('/tenants/' + alpha.tenantId + '/leave', exitBody, owner, leaveKey)),
          exited,
        )
        assert.equal((await tenant(alpha.tenantId)).membershipId, priorOwner.membershipId)
        const removePath =
          '/tenants/' + alpha.tenantId + '/members/' + priorOwner.membershipId + '/remove'
        const removeBody = { expectedVersion: priorOwner.version },
          removeKey = secret()
        const removed = ok(await call(removePath, removeBody, other, removeKey), 'Membership')
        assert.equal(removed.status, 'REMOVED')
        assert.deepEqual(ok(await call(removePath, removeBody, other, removeKey)), removed)
        assert.equal(
          (await call(removePath, { expectedVersion: removed.version }, other)).status,
          409,
        )
        priorOwner = (
          await accept(await invite(alpha.tenantId, 'USER', owner.userId, other), owner)
        ).membership
      },
    )
    await suite.test(
      'UAS-26/35: only platform can disable/restore; tenant access stops while personal and other tenants continue',
      async () => {
        const t = await tenant(alpha.tenantId, other)
        const transfer = ok(
          await call(
            '/tenants/' + alpha.tenantId + '/ownership-transfers',
            { targetMembershipId: mMember.membershipId, expectedVersion: t.version },
            other,
          ),
        )
        const beforeMembers = await members(alpha.tenantId)
        const body = { expectedVersion: t.version, reason: 'Maintenance fixture' },
          key = secret()
        assert.equal(
          (await call('/platform/tenants/' + alpha.tenantId + '/disable', body, other)).status,
          403,
        )
        const disabled = ok(
          await call('/platform/tenants/' + alpha.tenantId + '/disable', body, platform, key),
          'PlatformTenantView',
        )
        assert.deepEqual(
          ok(await call('/platform/tenants/' + alpha.tenantId + '/disable', body, platform, key)),
          disabled,
        )
        for (const actor of [owner, other, member]) {
          assert.equal(
            (await call('/tenants/' + alpha.tenantId, undefined, actor)).error.code,
            'TENANT_DISABLED',
          )
          assert.equal(
            (await call('/tenants/' + alpha.tenantId + '/members', undefined, actor)).error.code,
            'TENANT_DISABLED',
          )
          assert.equal(
            ok(await call('/tenants', undefined, actor), 'MyTenantsPage').items.find(
              (x: any) => x.tenantId === alpha.tenantId,
            ).status,
            'DISABLED',
          )
          ok(await call('/users/me', undefined, actor), 'MeView')
        }
        assert.equal(
          (
            await call(
              '/invitations/' + pending.invitationId + '/accept',
              { expectedVersion: 0 },
              reader,
            )
          ).error.code,
          'TENANT_DISABLED',
        )
        assert.equal(
          ok(await call('/invitations', undefined, reader), 'InvitationPage').items.length,
          0,
        )
        assert.equal(
          ok(await call('/ownership-transfers', undefined, member), 'OwnershipTransferPage').items
            .length,
          0,
        )
        assert.equal(
          (
            await call(
              '/ownership-transfers/' + transfer.transferId + '/accept',
              { expectedVersion: 0 },
              member,
            )
          ).error.code,
          'TENANT_DISABLED',
        )
        assert.equal(
          (
            await call(
              '/tenants/' + alpha.tenantId,
              { name: 'blocked', expectedVersion: disabled.version },
              other,
              secret(),
              'PATCH',
            )
          ).error.code,
          'TENANT_DISABLED',
        )
        assert.equal((await tenant(beta.tenantId, other)).status, 'ACTIVE')
        assert.equal(
          ok(
            await call('/platform/tenants/' + alpha.tenantId, undefined, reader),
            'PlatformTenantView',
          ).status,
          'DISABLED',
        )
        const restore = { expectedVersion: disabled.version, reason: 'Restore fixture' }
        assert.equal(
          (await call('/platform/tenants/' + alpha.tenantId + '/enable', restore, reader)).status,
          403,
        )
        ok(
          await call('/platform/tenants/' + alpha.tenantId + '/enable', restore, platform),
          'PlatformTenantView',
        )
        assert.deepEqual(await members(alpha.tenantId), beforeMembers)
        await accept(pending, reader)
        ok(
          await call(
            '/ownership-transfers/' + transfer.transferId + '/cancel',
            { expectedVersion: 0 },
            other,
          ),
        )
        assert.equal(
          (
            await call(
              '/platform/tenants/' + alpha.tenantId,
              undefined,
              platform,
              secret(),
              'DELETE',
            )
          ).status,
          501,
        )
        assert.equal((await tenant(alpha.tenantId, other)).status, 'ACTIVE')
      },
    )
    await suite.test(
      'UAS-26: opaque cursors bind actor/client/route/page size and current permissions',
      async () => {
        const first = ok(
          await call('/platform/tenants?limit=1', undefined, platform),
          'PlatformTenantViewPage',
        )
        assert.ok(first.nextCursor)
        const next = ok(
          await call('/platform/tenants?limit=1&cursor=' + first.nextCursor, undefined, platform),
          'PlatformTenantViewPage',
        )
        assert.equal(next.items.length, 1)
        assert.notEqual(next.items[0].tenantId, first.items[0].tenantId)
        for (const path of ['/platform/tenants?limit=2&cursor=', '/tenants?limit=1&cursor='])
          assert.equal((await call(path + first.nextCursor, undefined, platform)).status, 400)
        assert.equal(
          (await call('/platform/tenants?limit=1&cursor=' + first.nextCursor, undefined, reader))
            .status,
          400,
        )
        assert.equal(
          (await call('/platform/tenants?limit=1&cursor=' + secret(), undefined, platform)).status,
          400,
        )
        assert.equal((await call('/platform/tenants?limit=101', undefined, platform)).status, 400)
        assert.equal(
          (await call('/platform/tenants?limit=1&limit=2', undefined, platform)).status,
          400,
        )
        assert.equal((await call('/tenants?userId=' + other.userId, undefined, owner)).status, 400)
        const page = ok(
          await call('/tenants/' + alpha.tenantId + '/members?limit=1', undefined, other),
          'MembershipPage',
        )
        assert.ok(page.nextCursor)
        assert.equal(
          (
            await call(
              '/tenants/' + beta.tenantId + '/members?limit=1&cursor=' + page.nextCursor,
              undefined,
              other,
            )
          ).status,
          400,
        )
        await permission(platform, 'TENANT_READ', false)
        assert.equal(
          (await call('/platform/tenants?limit=1&cursor=' + first.nextCursor, undefined, platform))
            .status,
          403,
        )
        await permission(platform, 'TENANT_READ')
        assert.equal(
          (await call('/platform/tenants?limit=1&cursor=' + first.nextCursor, undefined, platform))
            .status,
          400,
        )
        const fresh = ok(await call('/platform/tenants?limit=1', undefined, platform))
        await db
          .prepare('UPDATE auth_one_use SET expires_at=0 WHERE token_hash=?')
          .bind(hash(fresh.nextCursor))
          .run()
        assert.equal(
          (await call('/platform/tenants?limit=1&cursor=' + fresh.nextCursor, undefined, platform))
            .status,
          400,
        )
      },
    )
    async function cursorCount() {
      const result = await db
        .prepare("SELECT count(*) n FROM auth_one_use WHERE purpose='V2_TENANT_CURSOR'")
        .first()
      return result.n
    }
    async function atListSnapshot(
      path: string,
      actor: any,
      moment: 'before' | 'after',
      change: () => Promise<unknown>,
    ) {
      const tag = 'managed-list-' + moment + '/' + secret()
      const reached = Promise.withResolvers<void>()
      const proceed = Promise.withResolvers<void>()
      barriers.set(tag, { reached, proceed })
      const result = call(path, undefined, actor, secret(), 'GET', undefined, tag)
      try {
        await Promise.race([
          reached.promise,
          result.then((response) =>
            assert.fail('List did not reach its SELECT batch: ' + JSON.stringify(response)),
          ),
        ])
        await change()
      } finally {
        proceed.resolve()
        await result.finally(() => barriers.delete(tag))
      }
      return result
    }

    await suite.test('UAS-26 terminal reads skip write guards and cursor inserts', async () => {
      const calls = (path: string, actor: any) =>
        call(path, undefined, actor, secret(), 'GET', undefined, 'managed-list-trace')
      const oneRead = { read: 1, write: 0 }
      const n = await cursorCount()
      const all = ok(await call('/platform/tenants?limit=100', undefined, platform))
      const limit = Math.ceil(all.items.length / 2)
      const path = '/platform/tenants?limit=' + limit
      const firstResponse = await calls(path, platform)
      const paged = ok(firstResponse)
      assert.deepEqual(firstResponse.d1Calls, { read: 1, write: 1 })
      assert.ok(paged.nextCursor)
      await permission(platform, 'APPLICATION_READ')
      await db
        .prepare(
          "CREATE TRIGGER fixture_block_read_writes BEFORE INSERT ON auth_write_guard BEGIN SELECT RAISE(ABORT,'unexpected auth write'); END",
        )
        .run()
      try {
        const policy = await calls('/tenant-creation-policy', platform)
        ok(policy, 'TenantCreationPolicyView')
        assert.deepEqual(policy.d1Calls, oneRead)
        for (const [path, actor] of [
          ['/tenants?limit=100', other],
          ['/tenants/' + alpha.tenantId + '/members?limit=100', other],
          ['/platform/tenants?limit=100', platform],
          ['/platform/applications?limit=100', platform],
        ] as const) {
          const response = await calls(path, actor)
          assert.equal(ok(response).nextCursor, null, path)
          assert.deepEqual(response.d1Calls, oneRead, path)
        }
        const finalResponse = await calls(path + '&cursor=' + paged.nextCursor, platform)
        const finalPage = ok(finalResponse)
        assert.deepEqual(finalResponse.d1Calls, { read: 2, write: 0 })
        assert.equal(finalPage.nextCursor, null)
        assert.deepEqual(finalPage.items, all.items.slice(limit))
        assert.equal(await cursorCount(), n + 1)
      } finally {
        await db.prepare('DROP TRIGGER fixture_block_read_writes').run()
      }
    })

    await suite.test(
      'UAS-26 skips protected SQL work until credentials, permissions and cursors are valid',
      async () => {
        await permission(platform, 'USER_READ')
        const unrecognized = { accessToken: secret() }
        for (const path of [
          '/platform/users',
          '/platform/tenants',
          '/platform/users/' + owner.userId,
        ]) {
          for (const fixture of ['managed-list-poison', 'managed-list-broken']) {
            // The authorized request proves the deliberately faulty query reaches
            // SQLite. Missing credentials/grants must win over either fault.
            const get = (actor: any) =>
              call(path, undefined, actor, secret(), 'GET', undefined, fixture)
            const authorized = await get(platform)
            assert.ok(authorized.protectedQueries > 0)
            assert.equal(authorized.status, 503)
            const unauthenticated = await get(unrecognized)
            assert.equal(unauthenticated.status, 401)
            assert.equal(unauthenticated.error.code, 'INVALID_CREDENTIALS')
            const forbidden = await get(owner)
            assert.equal(forbidden.status, 403)
            assert.equal(forbidden.error.code, 'FORBIDDEN')
            if (fixture === 'managed-list-poison') {
              // LIMIT 0 skips expression evaluation in the original batch. A
              // fallback authorization probe would require another D1 call.
              assert.deepEqual(unauthenticated.d1Calls, { read: 1, write: 0 })
              assert.deepEqual(forbidden.d1Calls, { read: 1, write: 0 })
            }
          }
        }
        const deniedOrigin = await call(
          '/platform/users',
          undefined,
          platform,
          secret(),
          'GET',
          undefined,
          'managed-list-poison',
          'http://127.0.0.1:3000',
        )
        assert.equal(deniedOrigin.status, 403)
        assert.equal(deniedOrigin.error.code, 'FORBIDDEN')
        assert.deepEqual(deniedOrigin.d1Calls, { read: 1, write: 0 })
        const allowedOrigin = await call(
          '/platform/users',
          undefined,
          platform,
          secret(),
          'GET',
          undefined,
          'managed-list-trace',
          'http://127.0.0.1:4207',
        )
        assert.ok(
          ok(allowedOrigin).items.some(
            (item: { userId: string }) => item.userId === platform.userId,
          ),
        )
        const page = ok(await call('/platform/tenants?limit=1', undefined, platform))
        assert.ok(page.nextCursor)
        for (const path of [
          '/platform/tenants?limit=1&cursor=' + secret(),
          '/platform/users?limit=1&cursor=' + page.nextCursor,
        ]) {
          const invalid = await call(
            path,
            undefined,
            platform,
            secret(),
            'GET',
            undefined,
            'managed-list-poison',
          )
          assert.equal(invalid.status, 400)
          assert.equal(invalid.error.code, 'INVALID_REQUEST')
          assert.equal(invalid.protectedQueries, 0)
          assert.deepEqual(invalid.d1Calls, { read: 1, write: 0 })
        }
      },
    )

    await suite.test(
      'UAS-26 validates current authorization in the list snapshot and again before a cursor write',
      async () => {
        const path = '/platform/tenants'
        const terminal = path + '?limit=100'
        const paginated = path + '?limit=1'
        const all = ok(await call(terminal, undefined, reader))
        const before = await atListSnapshot(terminal, reader, 'before', () =>
          permission(reader, 'TENANT_READ', false),
        )
        assert.equal(before.status, 403)
        assert.equal(before.error.code, 'FORBIDDEN')

        await permission(reader, 'TENANT_READ')
        const after = await atListSnapshot(terminal, reader, 'after', () =>
          permission(reader, 'TENANT_READ', false),
        )
        assert.deepEqual(ok(after), all)
        assert.equal((await call(terminal, undefined, reader)).status, 403)

        await permission(reader, 'TENANT_READ')
        const n = await cursorCount()
        const permissionDrift = await atListSnapshot(paginated, reader, 'after', () =>
          permission(reader, 'TENANT_READ'),
        )
        assert.equal(permissionDrift.status, 409)
        assert.equal(permissionDrift.error.code, 'VERSION_CONFLICT')
        assert.equal(await cursorCount(), n)

        const members = '/tenants/' + alpha.tenantId + '/members?limit=1'
        const membershipDrift = await atListSnapshot(members, other, 'after', () =>
          db
            .prepare(
              "UPDATE auth_tenant_membership SET version=version+1 WHERE tenant_id=? AND user_id=? AND status='ACTIVE'",
            )
            .bind(alpha.tenantId, other.userId)
            .run(),
        )
        assert.equal(membershipDrift.status, 409)
        assert.equal(membershipDrift.error.code, 'VERSION_CONFLICT')
        assert.equal(await cursorCount(), n)

        const first = all.items[0]
        const rowDrift = ok(
          await atListSnapshot(paginated, reader, 'after', () =>
            db
              .prepare('UPDATE auth_tenant SET version=version+1 WHERE id=?')
              .bind(first.tenantId)
              .run(),
          ),
        )
        assert.deepEqual(rowDrift.items, [first])
        assert.ok(rowDrift.nextCursor)
        assert.equal(await cursorCount(), n + 1)

        const revoked = await atListSnapshot(paginated, reader, 'after', () =>
          db
            .prepare('UPDATE auth_login_session SET revoked_at=? WHERE id=?')
            .bind(Date.now(), reader.session.loginSessionId)
            .run(),
        )
        assert.equal(revoked.status, 409)
        assert.equal(revoked.error.code, 'VERSION_CONFLICT')
        assert.equal(await cursorCount(), n + 1)
        const denied = await call(terminal, undefined, reader)
        assert.equal(denied.status, 401)
        assert.equal(denied.error.code, 'SESSION_EXPIRED')
      },
    )
    await suite.test(
      'UAS-26/40: notification cleanup and audit keep targets private; revoked sessions cannot retry writes',
      async () => {
        const audit = JSON.stringify(
          (
            await db
              .prepare(
                "SELECT * FROM auth_audit_event WHERE action LIKE 'tenant.%' OR action LIKE 'invitation.%' OR action LIKE 'transfer.%'",
              )
              .all()
          ).results,
        )
        assert.ok(!audit.includes('new-member@example.test'))
        assert.ok(!audit.includes('+8613800000103'))
        assert.ok(!audit.includes(owner.accessToken))
        const expired = await db
          .prepare('SELECT delivery_id FROM auth_mock_notification LIMIT 1')
          .first()
        await db
          .prepare('UPDATE auth_mock_notification SET expires_at=created_at+1 WHERE delivery_id=?')
          .bind(expired.delivery_id)
          .run()
        await new Promise((r) => setTimeout(r, 5))
        await p.scheduled()
        assert.equal(
          await db
            .prepare('SELECT delivery_id FROM auth_mock_notification WHERE delivery_id=?')
            .bind(expired.delivery_id)
            .first(),
          null,
        )
        const key = secret(),
          t = await tenant(alpha.tenantId, other)
        const body = { name: 'Final name', expectedVersion: t.version }
        ok(await call('/tenants/' + alpha.tenantId, body, other, key, 'PATCH'))
        ok(await call('/sessions/current/logout', {}, other))
        assert.equal(
          (await call('/tenants/' + alpha.tenantId, body, other, key, 'PATCH')).status,
          401,
        )
        assert.equal(
          (
            await db
              .prepare(
                "SELECT count(*) n FROM auth_tenant_membership WHERE tenant_id=? AND role='OWNER' AND status='ACTIVE'",
              )
              .bind(alpha.tenantId)
              .first()
          ).n,
          1,
        )
      },
    )
    await suite.test(
      'management range and recipient indexes serve actual first and cursor pages',
      async (t) => {
        const focus = await create('Pagination fixture tenant', owner.userId)
        const disabled = await create('Disabled fixture tenant', owner.userId)
        const focusOwner = (await members(focus.tenantId))[0].membershipId
        const disabledOwner = (await members(disabled.tenantId))[0].membershipId
        const focusMember = randomUUID()
        const historyMember = randomUUID()
        const disabledMember = randomUUID()
        const expiry = Date.now() + 3_600_000
        const workApp = 'molis-work-unified-local-app'
        await permission(platform, 'CLIENT_READ')
        await permission(platform, 'AUDIT_READ')
        await db.batch([
          db.prepare("UPDATE auth_tenant SET status='DISABLED' WHERE id=?").bind(disabled.tenantId),
          db
            .prepare(
              `INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at,ended_at)
          VALUES (?,?,?,'MEMBER','ACTIVE',0,NULL),(?,?,?,'MEMBER','LEFT',0,1),
                 (?,?,?,'MEMBER','ACTIVE',0,NULL)`,
            )
            .bind(
              focusMember,
              focus.tenantId,
              member.userId,
              historyMember,
              focus.tenantId,
              owner.userId,
              disabledMember,
              disabled.tenantId,
              member.userId,
            ),
          db
            .prepare(
              `INSERT INTO auth_user_email VALUES
          ('fixture-email',?,'page@example.test',1,0),
          ('fixture-email-unverified',?,'unverified-page@example.test',NULL,0),
          ('fixture-email-unrelated',?,'unrelated-page@example.test',1,0)`,
            )
            .bind(owner.userId, owner.userId, outsider.userId),
        ])

        // A selective actor and tenant amid unrelated rows. Several rows share each
        // tenant/application so the planner must also range and order by cursor id.
        const series =
          'WITH RECURSIVE fixture(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM fixture WHERE n<2048)'
        await db.batch([
          db.prepare(`${series} INSERT INTO auth_user(id,display_name,status,avatar_data,created_at,updated_at)
          SELECT 'fixture-user-'||n,'Fixture User','ACTIVE',NULL,0,0 FROM fixture WHERE n<=512`),
          db.prepare(`${series} INSERT INTO auth_user_email
          SELECT 'fixture-email-'||n,'fixture-user-'||n,'fixture-'||n||'@example.test',1,0 FROM fixture WHERE n<=512`),
          db.prepare(`${series} INSERT INTO auth_user_phone
          SELECT 'fixture-phone-'||n,'fixture-user-'||n,printf('+86139%08d',n),1,0 FROM fixture WHERE n<=512`),
          db.prepare(`${series} INSERT INTO auth_tenant(id,name,created_at,status,managed_by,managed_at,updated_at)
          SELECT 'fixture-space-'||n,'Fixture Space',0,'ACTIVE','fixture-user-'||n,0,0 FROM fixture WHERE n<=256`),
          db.prepare(`${series} INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at)
          SELECT 'fixture-membership-'||n,'fixture-space-'||(1+(n-1)%256),'fixture-user-'||n,
                 CASE WHEN n<=256 THEN 'OWNER' ELSE 'MEMBER' END,'ACTIVE',0
          FROM fixture WHERE n<=512`),
          db
            .prepare(
              `${series} INSERT INTO auth_ownership_transfer
          (id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at)
          SELECT 'fixture-transfer-'||n,'fixture-space-'||(1+(n-1)%256),
                 'fixture-membership-'||(1+(n-1)%256),'fixture-membership-'||(257+(n-1)%256),
                 'CANCELLED',0,? FROM fixture`,
            )
            .bind(expiry),
          db
            .prepare(
              `${series} INSERT INTO auth_tenant_invitation
          (id,tenant_id,target_kind,target_user_id,target_email,target_phone,inviter_membership_id,status,created_at,expires_at)
          SELECT 'fixture-invite-'||n,'fixture-space-'||(1+(n-1)%256),
                 CASE n%3 WHEN 0 THEN 'USER' WHEN 1 THEN 'EMAIL' ELSE 'PHONE' END,
                 CASE n%3 WHEN 0 THEN 'fixture-user-'||(1+(n-1)%512) END,
                 CASE n%3 WHEN 1 THEN 'fixture-'||(1+(n-1)%512)||'@example.test' END,
                 CASE n%3 WHEN 2 THEN printf('+86139%08d',1+(n-1)%512) END,
                 'fixture-membership-'||(1+(n-1)%256),'PENDING',0,? FROM fixture`,
            )
            .bind(expiry),
          db.prepare(`${series} INSERT INTO auth_application(id,name)
          SELECT 'fixture-app-'||n,'Fixture Application' FROM fixture WHERE n<=256`),
          db
            .prepare(
              `${series} INSERT INTO auth_client(id,client_id,application_id,client_type,redirects,environment_id,allowed_origins)
          SELECT 'fixture-client-'||n,'fixture-client-'||n,'fixture-app-'||(1+(n-1)%256),'CLI','[]','unified-local','[]'
          FROM fixture UNION ALL SELECT 'fixture-work-client','fixture-work-client',?,'CLI','[]','unified-local','[]'`,
            )
            .bind(workApp),
          db.prepare(`${series} INSERT INTO auth_management_audit
          (id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,request_id,occurred_at)
          SELECT 'fixture-audit-'||n,'fixture-user-'||(1+(n-1)%256),'molis-work-unified-local',
                 'fixture-space-'||(1+(n-1)%256),'fixture','TENANT','fixture-space-'||(1+(n-1)%256),
                 CASE WHEN n%64=0 THEN 'DENIED' ELSE 'SUCCESS' END,'fixture-request',0 FROM fixture`),
        ])

        const inviteIds = Array.from({ length: 8 }, () => randomUUID())
        const inviteValues = [
          ['USER', owner.userId, null, null, focus.tenantId, focusOwner, 'PENDING', expiry],
          ['EMAIL', null, 'page@example.test', null, focus.tenantId, focusOwner, 'PENDING', expiry],
          ['PHONE', null, null, '+8613800000102', focus.tenantId, focusOwner, 'PENDING', expiry],
          [
            'EMAIL',
            null,
            'unverified-page@example.test',
            null,
            focus.tenantId,
            focusOwner,
            'PENDING',
            expiry,
          ],
          [
            'EMAIL',
            null,
            'unrelated-page@example.test',
            null,
            focus.tenantId,
            focusOwner,
            'PENDING',
            expiry,
          ],
          ['USER', owner.userId, null, null, focus.tenantId, focusOwner, 'PENDING', 1],
          ['USER', owner.userId, null, null, disabled.tenantId, disabledOwner, 'PENDING', expiry],
          ['USER', owner.userId, null, null, focus.tenantId, focusOwner, 'DECLINED', expiry],
        ]
        const transferIds = Array.from({ length: 5 }, () => randomUUID())
        await db.batch([
          ...inviteValues.map((row, i) =>
            db
              .prepare(
                `INSERT INTO auth_tenant_invitation
              (id,target_kind,target_user_id,target_email,target_phone,tenant_id,inviter_membership_id,status,created_at,expires_at)
              VALUES (?,?,?,?,?,?,?,?,0,?)`,
              )
              .bind(inviteIds[i], ...row),
          ),
          ...[
            [focus.tenantId, focusOwner, focusMember, 'CANCELLED', expiry],
            [focus.tenantId, focusMember, focusOwner, 'PENDING', 1],
            [focus.tenantId, focusMember, historyMember, 'CANCELLED', expiry],
            [focus.tenantId, focusOwner, historyMember, 'ACCEPTED', expiry],
            [disabled.tenantId, disabledOwner, disabledMember, 'CANCELLED', expiry],
          ].map(([tenantId, from, to, status, expires], i) =>
            db
              .prepare(
                `INSERT INTO auth_ownership_transfer
              (id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at)
              VALUES (?,?,?,?,?,0,?)`,
              )
              .bind(transferIds[i], tenantId, from, to, status, expires),
          ),
          db
            .prepare(
              `INSERT INTO auth_management_audit
          (id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,request_id,occurred_at)
          SELECT id,?,'molis-work-unified-local',?,'fixture','TENANT',?,'SUCCESS','fixture-request',1
          FROM (SELECT ? AS id UNION ALL SELECT ?)`,
            )
            .bind(owner.userId, focus.tenantId, focus.tenantId, randomUUID(), randomUUID()),
        ])
        await db.prepare('ANALYZE').run()

        async function walk(path: string, actor: any, indexes: string[]) {
          const items: any[] = []
          let cursor: string | null = null
          let pageNumber = 0
          do {
            const response = await call(
              path + '?limit=1' + (cursor ? '&cursor=' + cursor : ''),
              undefined,
              actor,
              secret(),
              'GET',
              undefined,
              'managed-list-explain',
            )
            const page = ok(response)
            assert.equal(page.items.length, 1)
            assert.equal(response.plans?.length, 1)
            const plan = response.plans![0]
            for (const index of indexes)
              assert.ok(
                plan.some((line) => line.startsWith('SEARCH ') && line.includes(index)),
                path + '\n' + plan.join('\n'),
              )
            assert.doesNotMatch(
              plan.join('\n'),
              /^SCAN (x|i|m|f|email|phone|c|cp|p|u|t|auth_[a-z_]+)\b/m,
            )
            if (++pageNumber <= 2) {
              const details = plan.filter((line) =>
                /^(SEARCH (x|i|m|f|e|email|phone|p|c|t|u|cp|auth_[a-z_]+)\b|SCAN |UNION |USE TEMP )/.test(
                  line,
                ),
              )
              t.diagnostic(path + ' page ' + pageNumber + '\n' + details.join('\n'))
            }
            const next: string | null = page.nextCursor
            if (cursor) {
              assert.deepEqual(
                ok(await call(path + '?limit=1&cursor=' + cursor, undefined, actor)).items,
                page.items,
              )
            }
            items.push(...page.items)
            assert.ok(pageNumber < 20, 'Unexpected page count for focused fixture')
            cursor = next
          } while (cursor)
          return items
        }
        const transfers = await walk('/ownership-transfers', owner, [
          'ix_tenant_membership_user',
          'ix_ownership_transfer_from',
          'ix_ownership_transfer_to',
        ])
        const listedTransferIds = transfers.map((item) => item.transferId)
        assert.deepEqual(listedTransferIds, [...new Set(listedTransferIds)].sort())
        const focusedTransfers = transfers.filter((item) => item.tenantId === focus.tenantId)
        assert.deepEqual(
          focusedTransfers.map((item) => item.transferId),
          [transferIds[0], transferIds[1], transferIds[3]].sort(),
        )
        assert.ok(!transfers.some((item) => item.tenantId === disabled.tenantId))
        assert.equal(
          focusedTransfers.find((item) => item.transferId === transferIds[1]).status,
          'EXPIRED',
        )
        const invitationList = await walk('/invitations', owner, [
          'ix_tenant_invitation_user',
          'ix_tenant_invitation_email',
          'ix_tenant_invitation_phone',
        ])
        const listedInvitationIds = invitationList.map((item) => item.invitationId)
        assert.deepEqual(listedInvitationIds, [...new Set(listedInvitationIds)].sort())
        assert.deepEqual(
          invitationList
            .filter((item) => item.tenantId === focus.tenantId)
            .map((item) => item.invitationId),
          inviteIds.slice(0, 3).sort(),
        )
        assert.ok(!invitationList.some((item) => item.tenantId === disabled.tenantId))
        assert.equal(
          (
            await walk('/tenants/' + focus.tenantId + '/members', owner, [
              'ix_tenant_membership_tenant_status_id',
              'ix_user_email_verified_order',
            ])
          ).length,
          2,
        )
        assert.equal(
          (
            await walk('/platform/applications/' + workApp + '/clients', platform, [
              'ix_client_application_id',
            ])
          ).length,
          2,
        )
        assert.ok(
          (
            await walk('/tenants/' + focus.tenantId + '/audit-events', owner, [
              'ix_management_audit_tenant',
            ])
          ).length >= 2,
        )

        for (const [path, index, indexedAccess] of [
          ['/platform/audit-events?limit=50', 'ix_management_audit_time', 'SCAN'],
          [
            `/platform/audit-events?tenantId=${focus.tenantId}&limit=2`,
            'ix_management_audit_tenant',
            'SEARCH',
          ],
          [
            '/platform/audit-events?result=DENIED&limit=10',
            'ix_management_audit_outcome_time',
            'SEARCH',
          ],
          [
            '/platform/audit-events?operation=tenant.create&limit=2',
            'ix_management_audit_operation_time',
            'SEARCH',
          ],
          ['/platform/tenants?status=ACTIVE&limit=10', 'ix_managed_tenant_status_time', 'SEARCH'],
        ]) {
          const queryPlan = async (url: string, access: string) => {
            const response = await call(
              url,
              undefined,
              platform,
              secret(),
              'GET',
              undefined,
              'managed-list-explain',
            )
            const page = ok(response)
            assert.equal(response.plans?.length, 1)
            const statements = response.plans![0]
            assert.ok(
              statements.some((line) => line.startsWith(access + ' ') && line.includes(index)),
              url + '\n' + statements.join('\n'),
            )
            assert.doesNotMatch(statements.join('\n'), /^SCAN (a|t) (?!USING INDEX)/m)
            assert.doesNotMatch(statements.join('\n'), /USE TEMP B-TREE FOR ORDER BY/)
            return page
          }
          const first = await queryPlan(path, indexedAccess)
          assert.ok(first.nextCursor)
          const second = await queryPlan(
            path + '&cursor=' + encodeURIComponent(first.nextCursor),
            'SEARCH',
          )
          const key = path.includes('/audit-events') ? 'auditEventId' : 'tenantId'
          assert.ok(second.items.length)
          assert.ok(
            second.items.every(
              (item: any) => !first.items.some((before: any) => before[key] === item[key]),
            ),
          )
        }
      },
    )
    await suite.test(
      'platform team governance projects verified users, commits audited changes and scopes time cursors',
      async () => {
        for (const scope of [
          'AUDIT_READ',
          'USER_READ',
          'USER_STATUS',
          'USER_EMAIL_WRITE',
          'PLATFORM_PERMISSION_WRITE',
          'APPLICATION_WRITE',
          'CLIENT_WRITE',
        ])
          await permission(platform, scope)
        const initialOwner = await signup('qa-governance-owner@example.test', true, true)
        const tenantReader = await signup('+8613800000111')
        const newOwner = await signup('+8613800000112')
        const accountSubject = await signup('+8613800000113')
        await permission(tenantReader, 'TENANT_READ')
        const created = await call(
          '/platform/tenants',
          {
            name: 'Platform Governance',
            ownerUserId: initialOwner.userId,
            reason: '  Governance test: existing owner  ',
          },
          platform,
        )
        const team = ok(created, 'PlatformTenantView')
        const path = '/platform/tenants/' + team.tenantId
        const auditPath = '/platform/audit-events'
        const tenantAuditPath = '/tenants/' + team.tenantId + '/audit-events'
        const filters = new URLSearchParams({
          tenantId: team.tenantId,
          category: 'tenant',
          result: 'SUCCEEDED',
          q: 'governance',
          limit: '2',
        })
        const logs = async (query: URLSearchParams, cursor?: string) => {
          const params = new URLSearchParams(query)
          if (cursor) params.set('cursor', cursor)
          return call(auditPath + '?' + params, undefined, platform)
        }

        const detail = ok(await call(path, undefined, tenantReader), 'PlatformTenantView')
        assert.equal(detail.memberCount, 1)
        assert.equal(detail.ownerUserId, initialOwner.userId)
        assert.equal(detail.ownerEmail, 'qa-governance-owner@example.test')
        assert.ok(detail.ownerDisplayName)
        assert.match(detail.createdAt, /Z$/)
        assert.equal(detail.updatedAt, detail.createdAt)
        assert.equal(
          ok(
            await call(
              '/platform/tenants?limit=100&status=ACTIVE&q=GOVERNANCE',
              undefined,
              tenantReader,
            ),
            'PlatformTenantViewPage',
          ).items[0].tenantId,
          team.tenantId,
        )
        assert.deepEqual(
          ok(await call('/platform/tenants?status=DISABLED&q=GOVERNANCE', undefined, tenantReader))
            .items,
          [],
        )
        assert.equal(
          (await call('/platform/users?status=ACTIVE&q=governance-owner', undefined, tenantReader))
            .status,
          403,
        )
        assert.deepEqual(
          ok(
            await call('/platform/users?status=ACTIVE&q=GOVERNANCE-OWNER', undefined, platform),
            'PlatformUserPage',
          ).items.map((row: any) => row.userId),
          [initialOwner.userId],
        )
        assert.equal((await call(path + '/members', undefined, initialOwner)).status, 403)
        const directory = ok(
          await call(path + '/members', undefined, tenantReader),
          'MembershipPage',
        ).items
        assert.equal(directory.length, 1)
        assert.equal(directory[0].email, detail.ownerEmail)

        assert.deepEqual(team, detail)
        await db
          .prepare(
            "INSERT INTO auth_user_email VALUES ('fixture-owner-alias',?,'owner-alias@example.test',1,?)",
          )
          .bind(initialOwner.userId, Date.now() + 60_000)
          .run()
        const aliasMatch = ok(
          await call('/platform/tenants?status=ACTIVE&q=owner-alias', undefined, tenantReader),
        ).items
        assert.equal(aliasMatch[0]?.tenantId, team.tenantId)
        assert.equal(aliasMatch[0]?.ownerEmail, detail.ownerEmail)

        const disabled = ok(
          await call(
            path + '/disable',
            { expectedVersion: 0, reason: 'Governance freeze' },
            platform,
          ),
        )
        const enabled = ok(
          await call(
            path + '/enable',
            { expectedVersion: disabled.version, reason: 'Governance restore' },
            platform,
          ),
        )
        assert.deepEqual(
          enabled,
          ok(await call(path, undefined, tenantReader), 'PlatformTenantView'),
        )
        assert.equal(disabled.ownerEmail, detail.ownerEmail)
        assert.equal(disabled.memberCount, 1)
        const transfer = {
          newOwnerUserId: newOwner.userId,
          expectedVersion: enabled.version,
          reason: 'Governance recovery',
        }
        assert.equal((await call(path + '/transfer-owner', transfer, tenantReader)).status, 403)
        assert.equal((await call(path + '/transfer-owner', transfer, platform, '')).status, 400)
        const key = secret()
        await db
          .prepare(
            "CREATE TRIGGER fail_team_audit BEFORE INSERT ON auth_management_audit WHEN NEW.operation='tenant.platform-transfer-owner' BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END",
          )
          .run()
        try {
          assert.equal((await call(path + '/transfer-owner', transfer, platform, key)).status, 503)
          assert.equal(
            ok(await call(path, undefined, tenantReader)).ownerUserId,
            initialOwner.userId,
          )
          assert.deepEqual(
            ok(await call(path + '/members', undefined, tenantReader)).items,
            directory,
          )
        } finally {
          await db.prepare('DROP TRIGGER fail_team_audit').run()
        }
        const response = await call(
          path + '/transfer-owner',
          transfer,
          platform,
          key,
          'POST',
          undefined,
          'd1-trace',
        )
        const transferred = ok(response, 'PlatformTenantView')
        // Session, permission, tenant, receipt and one batch for all three owner lookups.
        assert.deepEqual(response.d1Calls, { read: 5, write: 1 })
        assert.deepEqual(
          transferred,
          ok(await call(path, undefined, tenantReader), 'PlatformTenantView'),
        )
        assert.equal(transferred.memberCount, 2)
        assert.equal(transferred.ownerUserId, newOwner.userId)
        assert.equal(transferred.version, enabled.version + 1)
        assert.deepEqual(
          ok(await call(path + '/transfer-owner', transfer, platform, key)),
          transferred,
        )
        assert.equal(
          (await call(path + '/transfer-owner', transfer, platform)).error.code,
          'VERSION_CONFLICT',
        )
        const after = ok(
          await call(path + '/members', undefined, tenantReader),
          'MembershipPage',
        ).items
        assert.equal(after.find((row: any) => row.userId === initialOwner.userId).role, 'ADMIN')
        assert.equal(after.find((row: any) => row.userId === newOwner.userId).role, 'OWNER')

        const pending = ok(
          await call(
            '/tenants/' + team.tenantId + '/ownership-transfers',
            {
              targetMembershipId: directory[0].membershipId,
              expectedVersion: transferred.version,
            },
            newOwner,
          ),
          'OwnershipTransfer',
        )
        const recovered = ok(
          await call(
            path + '/transfer-owner',
            {
              newOwnerUserId: initialOwner.userId,
              expectedVersion: transferred.version,
              reason: 'Governance restored owner',
            },
            platform,
          ),
        )
        assert.equal(recovered.version, enabled.version + 2)
        assert.equal(ok(await call(path, undefined, tenantReader)).memberCount, 2)
        assert.equal(
          (
            await db
              .prepare('SELECT status FROM auth_ownership_transfer WHERE id=?')
              .bind(pending.transferId)
              .first()
          ).status,
          'CANCELLED',
        )
        assert.equal(
          (
            await db
              .prepare('SELECT entitlement_revision FROM auth_tenant WHERE id=?')
              .bind(team.tenantId)
              .first()
          ).entitlement_revision,
          4,
        )

        const stamped = Date.now() - 10_000
        await db
          .prepare(
            "UPDATE auth_management_audit SET occurred_at=? WHERE tenant_id=? AND operation='tenant.platform-transfer-owner'",
          )
          .bind(stamped, team.tenantId)
          .run()
        const expected = (
          await db
            .prepare(
              "SELECT id FROM auth_management_audit WHERE tenant_id=? AND lower(reason) LIKE '%governance%' ORDER BY occurred_at DESC,id DESC",
            )
            .bind(team.tenantId)
            .all()
        ).results.map((row) => row.id)
        const first = ok(await logs(filters), 'AuditEventPage')
        assert.equal(first.items.length, 2)
        const mismatch = new URLSearchParams(filters)
        mismatch.set('q', 'other')
        assert.equal((await logs(mismatch, first.nextCursor)).error.code, 'INVALID_REQUEST')
        assert.equal((await logs(filters, secret())).error.code, 'INVALID_REQUEST')
        const second = ok(await logs(filters, first.nextCursor), 'AuditEventPage')
        const third = ok(await logs(filters, second.nextCursor), 'AuditEventPage')
        assert.equal(third.nextCursor, null)
        const items = [...first.items, ...second.items, ...third.items]
        assert.equal(items.length, 5)
        assert.deepEqual(
          items.map((item) => item.auditEventId),
          expected,
        )
        const firstWrite = items.find((item) => item.operation === 'tenant.create')
        assert.equal(firstWrite.reason, '  Governance test: existing owner  ')
        assert.equal(firstWrite.requestId, created.requestId)
        assert.equal(firstWrite.tenantName, team.name)
        assert.equal(
          firstWrite.actorDisplayName,
          (
            await db
              .prepare('SELECT display_name FROM auth_user WHERE id=?')
              .bind(platform.userId)
              .first()
          ).display_name,
        )
        assert.deepEqual(firstWrite.changes, [
          { field: 'name', before: null, after: 'Platform Governance' },
          { field: 'ownerUserId', before: null, after: initialOwner.userId },
          { field: 'status', before: null, after: 'ACTIVE' },
        ])
        assert.ok(
          items
            .find((item) => item.operation === 'tenant.disable')
            .changes.some(
              (change: any) =>
                change.field === 'status' &&
                change.before === 'ACTIVE' &&
                change.after === 'DISABLED',
            ),
        )
        const dated = new URLSearchParams(filters)
        dated.set('from', new Date(stamped).toISOString().replace('Z', '+00:00'))
        dated.set('to', new Date(stamped).toISOString())
        assert.ok(
          ok(await logs(dated)).items.every(
            (item: any) => item.occurredAt === new Date(stamped).toISOString(),
          ),
        )
        assert.equal(ok(await logs(dated)).items.length, 2)
        dated.set('from', '2026-02-31T00:00:00Z')
        assert.equal((await logs(dated)).error.code, 'INVALID_REQUEST')
        assert.ok(
          ok(await call(tenantAuditPath, undefined, initialOwner)).items.every(
            (item: any) => item.tenantId === team.tenantId,
          ),
        )

        const patch = (path: string, body: unknown) => call(path, body, platform, secret(), 'PATCH')
        const userPath = '/platform/users/' + accountSubject.userId
        const user = ok(await call(userPath, undefined, platform))
        const updated = ok(
          await patch(userPath + '/email', {
            email: 'governance-subject@example.test',
            expectedVersion: user.version,
            reason: 'Governance verified email',
          }),
        )
        const status = ok(
          await patch(userPath + '/status', {
            status: 'DISABLED',
            expectedVersion: updated.version,
            reason: 'Governance user freeze',
          }),
        )
        ok(
          await patch(userPath + '/status', {
            status: 'ACTIVE',
            expectedVersion: status.version,
            reason: 'Governance user restore',
          }),
        )
        ok(
          await patch(userPath + '/permissions/USER_READ', {
            enabled: true,
            expectedVersion: null,
            reason: 'Governance grant',
          }),
        )
        const app = ok(await call('/platform/applications', { name: 'Governance app' }, platform))
        const client = ok(
          await call(
            '/platform/applications/' + app.applicationId + '/clients',
            {
              clientId: 'governance-audit-client',
              clientType: 'WEB',
              environmentId: 'unified-local',
              allowedOrigins: [origin],
              redirectAllowlist: [origin + '/account/callback'],
            },
            platform,
          ),
        )
        const account = ok(
          await call(auditPath + '?category=account&q=Governance&limit=20', undefined, platform),
          'AuditEventPage',
        ).items
        assert.equal(account.length, 4)
        assert.deepEqual(account.find((item: any) => item.operation === 'user.email').changes, [
          { field: 'email', before: null, after: 'governance-subject@example.test' },
        ])
        assert.ok(
          account
            .find((item: any) => item.operation === 'permission.set')
            .changes.some(
              (change: any) => change.field === 'capability' && change.after === 'USER_READ',
            ),
        )
        const applicationEvents = ok(
          await call(
            auditPath + '?category=app&actorUserId=' + platform.userId,
            undefined,
            platform,
          ),
        ).items
        assert.ok(
          applicationEvents.some(
            (item: any) =>
              item.operation === 'application.create' && item.target.id === app.applicationId,
          ),
        )
        const clientEvent = applicationEvents.find(
          (item: any) => item.operation === 'client.create' && item.target.id === client.clientId,
        )
        assert.ok(clientEvent)
        assert.deepEqual(
          clientEvent.changes.map((change: any) => change.field).sort(),
          [
            'allowedOrigins',
            'applicationId',
            'clientType',
            'environmentId',
            'redirectAllowlist',
            'status',
          ].sort(),
        )
        const newest = ok(
          await call(
            auditPath + '?limit=1&targetId=' + client.clientId + '&operation=client.create',
            undefined,
            platform,
          ),
        ).items
        assert.equal(newest[0].auditEventId, clientEvent.auditEventId)
      },
    )
    await suite.test(
      'UAS-13: verified email invitations can be accepted in LIVE mode without a notification',
      async () => {
        const email = 'live-invite@example.test'
        const recipient = await signup(email, true, true)
        const team = await create('Live email invitation', owner.userId)
        const liveDb = await p.updateBindings({
          UNIFIED_ACCOUNT_CONFIG: JSON.stringify({
            environmentId: 'unified-local',
            kind: 'LOCAL',
            authOrigin: origin,
            deliveryMode: 'LIVE',
            providerMode: 'MOCK',
          }),
        })
        await liveDb
          .prepare("UPDATE auth_environment SET delivery_mode='LIVE' WHERE id='unified-local'")
          .run()
        const invitation = await invite(team.tenantId, 'EMAIL', email.toUpperCase())
        assert.equal((await members(team.tenantId)).length, 1)
        assert.equal(
          await liveDb
            .prepare('SELECT count(*) n FROM auth_mock_notification WHERE destination=?')
            .bind(email)
            .first('n'),
          0,
        )
        assert.ok(
          ok(await call('/invitations', undefined, recipient), 'InvitationPage').items.some(
            (item: { invitationId: string }) => item.invitationId === invitation.invitationId,
          ),
        )
        assert.equal(
          (
            await call(
              '/invitations/' + invitation.invitationId + '/accept',
              { expectedVersion: 0 },
              outsider,
            )
          ).status,
          404,
        )
        assert.equal((await accept(invitation, recipient)).membership.role, 'MEMBER')
        assert.equal((await members(team.tenantId)).length, 2)
      },
    )
  } finally {
    for (const { proceed } of barriers.values()) proceed.resolve()
    await p.dispose()
  }
})
