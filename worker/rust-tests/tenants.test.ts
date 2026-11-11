import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getRustProxy, initializeLocalRuntime } from '../scripts/local-runtime.mjs'
import { secret, challenge, hash } from './fixtures.ts'
import { validateNamed } from '../../contracts/unified-account/validate.ts'

test('AUTH-07 real managed tenants, directed invitations and ownership lifecycle', async (suite) => {
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
        assert.equal((await db.prepare('SELECT count(*) n FROM auth_managed_tenant').first()).n, 1)
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
        assert.equal((await db.prepare('SELECT count(*) n FROM billing_subscription').first()).n, 0)
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
        assert.deepEqual(mine.personalScope, { kind: 'PERSONAL' })
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
    await suite.test('member directory exposes names and verified email only inside the tenant', async () => {
      await db.prepare('UPDATE auth_user SET display_name=? WHERE id=?').bind('林小雨', owner.userId).run()
      let row = (await members(alpha.tenantId))[0]
      assert.equal(row.displayName, '林小雨')
      assert.equal(row.email, null)
      await db.prepare('INSERT INTO auth_user_email(id,user_id,canonical_email,created_at) VALUES (?,?,?,?)').bind('directory-email', owner.userId, 'directory@example.test', Date.now()).run()
      row = (await members(alpha.tenantId))[0]
      assert.equal(row.email, null)
      await db.prepare('UPDATE auth_user_email SET verified_at=? WHERE id=?').bind(Date.now(), 'directory-email').run()
      assert.equal((await members(alpha.tenantId))[0].email, 'directory@example.test')
      assert.equal((await call('/tenants/' + alpha.tenantId + '/members', undefined, outsider)).status, 404)
      assert.equal((await call('/tenants/' + alpha.tenantId + '/members', undefined, platform)).status, 404)
    })
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
      'UAS-16/42: ownership swaps atomically, demotes former owner to MEMBER, preserves seats and retries safely',
      async () => {
        priorOwner = (await members(alpha.tenantId)).find((x: any) => x.role === 'OWNER')
        const n = Date.now()
        await db
          .prepare("INSERT INTO billing_plan_version VALUES ('fixture-plan',1,'Fixture only',?,?)")
          .bind(platform.userId, n)
          .run()
        await db
          .prepare("INSERT INTO billing_seat_type VALUES ('fixture-seat','Fixture only',?)")
          .bind(n)
          .run()
        await db
          .prepare(
            "INSERT INTO billing_subscription(id,owner_tenant_id,plan_id,plan_version,enabled,starts_at,ends_at,created_at,updated_at) VALUES ('fixture-sub',?,'fixture-plan',1,1,?,?,?,?)",
          )
          .bind(alpha.tenantId, n, n + 86400000, n, n)
          .run()
        await db
          .prepare(
            "INSERT INTO billing_seat_pool(subscription_id,tenant_id,seat_type_id,quantity) VALUES ('fixture-sub',?,'fixture-seat',1)",
          )
          .bind(alpha.tenantId)
          .run()
        await db
          .prepare(
            "INSERT INTO billing_seat_assignment(id,subscription_id,seat_type_id,tenant_id,membership_id,user_id,status,assigned_at) VALUES ('fixture-assignment','fixture-sub','fixture-seat',?,?,?,'ASSIGNED',?)",
          )
          .bind(alpha.tenantId, priorOwner.membershipId, owner.userId, n)
          .run()
        const seat = await db.prepare('SELECT * FROM billing_seat_assignment').first()
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
        assert.deepEqual(await db.prepare('SELECT * FROM billing_seat_assignment').first(), seat)
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
        assert.equal(
          (
            await db
              .prepare(
                "SELECT status,end_reason FROM billing_seat_assignment WHERE id='fixture-assignment'",
              )
              .first()
          ).status,
          'ENDED',
        )
        assert.equal(
          (
            await db
              .prepare(
                "SELECT end_reason FROM billing_seat_assignment WHERE id='fixture-assignment'",
              )
              .first()
          ).end_reason,
          'MEMBER_LEFT',
        )
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
        assert.equal(
          (
            await db
              .prepare("SELECT status FROM billing_seat_assignment WHERE id='fixture-assignment'")
              .first()
          ).status,
          'ENDED',
        )
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
        const subscription = await db.prepare('SELECT * FROM billing_subscription').first()
        const seats = (await db.prepare('SELECT * FROM billing_seat_assignment').all()).results
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
        assert.deepEqual(
          await db.prepare('SELECT * FROM billing_subscription').first(),
          subscription,
        )
        assert.deepEqual(
          (await db.prepare('SELECT * FROM billing_seat_assignment').all()).results,
          seats,
        )
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
  } finally {
    await p.dispose()
  }
})
