import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'

const migrationName = '0005_unified_account.sql'
const directory = new URL('../migrations/', import.meta.url)
const migration = readFileSync(new URL(migrationName, directory), 'utf8')
const localSeed = readFileSync(
  new URL('../unified-account-local-seed.sql', import.meta.url),
  'utf8',
)

function database() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys=ON')
  for (const name of readdirSync(directory)
    .filter((name) => name.endsWith('.sql') && name < migrationName)
    .sort()) {
    db.exec(readFileSync(new URL(name, directory), 'utf8'))
  }
  db.exec(migration)
  // These domain-constraint tests also use the independent product registry.
  db.exec(readFileSync(new URL('0011_entitlement_client_product.sql', directory), 'utf8'))
  return db
}

function seedUsers(db: DatabaseSync) {
  db.exec(
    "INSERT INTO auth_user VALUES ('u','User','ACTIVE',NULL,0,0),('v','Other','ACTIVE',NULL,0,0),('w','Third','ACTIVE',NULL,0,0)",
  )
}

function configured() {
  const db = database()
  db.exec(localSeed)
  seedUsers(db)
  return db
}

function scalar(db: DatabaseSync, sql: string) {
  return db.prepare(sql).get()!.value
}

function sequence(db: DatabaseSync, kind = 'TRANSACTION') {
  return Number(
    db.prepare('INSERT INTO auth_security_sequence(kind,created_at) VALUES (?,1000)').run(kind)
      .lastInsertRowid,
  )
}

function session(db: DatabaseSync, id: string, user = 'u', client = 'molis-work-unified-local') {
  db.prepare(
    `INSERT INTO auth_login_session
    (id,user_id,client_id,authenticated_at,last_active_at,absolute_expires_at,user_epoch,created_seq)
    VALUES (?,?,?,1000,1000,7776001000,0,?)`,
  ).run(id, user, client, sequence(db))
}

function tenant(db: DatabaseSync, id: string, owner: string) {
  db.prepare(
    "INSERT INTO auth_space(id,name,space_type,status,created_at,updated_at) VALUES (?,?,'TEAM','ACTIVE',0,0)",
  ).run(id, id)
  db.prepare(
    "INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES (?,'ACTIVE',?,0,0)",
  ).run(id, owner)
  member(db, id + '-owner', id, owner, 'OWNER')
}

function member(db: DatabaseSync, id: string, tenantId: string, user: string, role = 'MEMBER') {
  db.prepare(
    "INSERT INTO auth_tenant_membership(id,tenant_id,user_id,role,status,joined_at) VALUES (?,?,?,?,'ACTIVE',0)",
  ).run(id, tenantId, user, role)
}

function catalog(db: DatabaseSync) {
  db.exec(`
    INSERT INTO billing_feature VALUES ('feature','SHARED','Test feature',0);
    INSERT INTO billing_seat_type VALUES ('standard','Test seat',0);
    INSERT INTO billing_plan_version VALUES ('plan',1,'Test plan','u',0);
    INSERT INTO billing_plan_personal_feature VALUES ('plan',1,'feature');
    INSERT INTO billing_plan_seat_type VALUES ('plan',1,'standard');
    INSERT INTO billing_plan_seat_feature VALUES ('plan',1,'standard','feature');
  `)
}

function subscription(db: DatabaseSync, id: string, tenantId: string) {
  db.prepare(
    `INSERT INTO billing_subscription
    (id,owner_tenant_id,plan_id,plan_version,enabled,starts_at,ends_at,created_at,updated_at)
    VALUES (?,?,'plan',1,1,0,1000,0,0)`,
  ).run(id, tenantId)
  db.prepare(
    "INSERT INTO billing_seat_pool(subscription_id,tenant_id,seat_type_id,quantity) VALUES (?,?,'standard',1)",
  ).run(id, tenantId)
}

function assign(
  db: DatabaseSync,
  id: string,
  sub: string,
  tenantId: string,
  membership: string,
  user: string,
) {
  db.prepare(
    `INSERT INTO billing_seat_assignment
    (id,subscription_id,seat_type_id,tenant_id,membership_id,user_id,status,assigned_at)
    VALUES (?,?,'standard',?,?,?,'ASSIGNED',100)`,
  ).run(id, sub, tenantId, membership, user)
}

test('UAS-11/39/40: opt-in local seed is repeatable, isolated and never overwrites registrations or grants access', () => {
  const db = database()
  try {
    db.exec(localSeed)
    db.exec(localSeed)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_environment'), 1)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_application'), 2)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_client_policy'), 2)
    const rows = db
      .prepare(
        `SELECT c.client_id,c.application_id,c.client_type,c.redirects,p.allowed_origins
      FROM auth_client c JOIN auth_client_policy p ON p.client_id=c.client_id ORDER BY c.client_id`,
      )
      .all()
    assert.equal(rows[0].client_type, 'WEB')
    assert.equal(rows[1].client_type, 'MACOS')
    assert.notEqual(rows[0].application_id, rows[1].application_id)
    assert.deepEqual(JSON.parse(String(rows[0].redirects)), [
      'http://127.0.0.1:3000/account/callback',
    ])
    assert.deepEqual(JSON.parse(String(rows[1].redirects)), [
      'http://127.0.0.1:4207/account/callback',
    ])
    assert.deepEqual(JSON.parse(String(rows[0].allowed_origins)), ['http://127.0.0.1:3000'])
    for (const table of [
      'auth_user',
      'auth_local_credential',
      'auth_platform_permission',
      'auth_managed_tenant',
      'billing_subscription',
    ]) {
      assert.equal(scalar(db, `SELECT count(*) AS value FROM ${table}`), 0)
    }
    db.exec("UPDATE auth_environment SET status='DISABLED',provider_mode='LIVE',version=9")
    db.exec(
      "UPDATE auth_client SET status='DISABLED',redirects='[\"http://127.0.0.1:3999/custom\"]' WHERE client_id='molis-club-unified-local'",
    )
    db.exec(
      "UPDATE auth_client_policy SET allowed_origins='[\"http://127.0.0.1:3999\"]',version=4 WHERE client_id='molis-club-unified-local'",
    )
    db.exec(localSeed)
    assert.equal(scalar(db, 'SELECT version AS value FROM auth_environment'), 9)
    assert.equal(
      scalar(
        db,
        "SELECT status AS value FROM auth_client WHERE client_id='molis-club-unified-local'",
      ),
      'DISABLED',
    )
    assert.equal(
      scalar(
        db,
        "SELECT version AS value FROM auth_client_policy WHERE client_id='molis-club-unified-local'",
      ),
      4,
    )
  } finally {
    db.close()
  }
})

test('UAS-11/39/40: production cannot enable mock and registration validates environment, origin and JSON shapes', () => {
  const db = database()
  try {
    const insert = db.prepare(`INSERT INTO auth_environment
      (id,kind,auth_origin,delivery_mode,provider_mode,created_at,updated_at) VALUES (?,'PRODUCTION',?,?,?,0,0)`)
    for (const [id, origin, delivery, provider] of [
      ['sms-mock', 'https://auth.example.test', 'MOCK', 'LIVE'],
      ['provider-mock', 'https://auth.example.test', 'LIVE', 'MOCK'],
      ['http', 'http://auth.example.test', 'LIVE', 'LIVE'],
      ['path', 'https://auth.example.test/path', 'LIVE', 'LIVE'],
      ['fragment', 'https://auth.example.test#x', 'LIVE', 'LIVE'],
      ['credentials', 'https://user@auth.example.test', 'LIVE', 'LIVE'],
      ['empty-host', 'https://', 'LIVE', 'LIVE'],
    ])
      assert.throws(() => insert.run(id, origin, delivery, provider), /CHECK constraint/)
    insert.run('production', 'https://auth.example.test', 'LIVE', 'LIVE')
    assert.throws(
      () => db.exec("UPDATE auth_environment SET provider_mode='MOCK' WHERE id='production'"),
      /CHECK constraint/,
    )
    db.exec(localSeed)
    assert.throws(
      () => db.exec("UPDATE auth_client_policy SET allowed_origins='{}'"),
      /CHECK constraint/,
    )
    assert.throws(() => db.exec("UPDATE auth_client_policy SET allowed_origins='broken'"))
    assert.throws(
      () => db.exec("UPDATE auth_client_policy SET policy_profile='user-chosen-profile'"),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_client_policy SET environment_id='missing'"),
      /FOREIGN KEY constraint/,
    )
  } finally {
    db.close()
  }
})

test('UAS-04/28/34: verified phone identity needs no email and platform permissions are not inferred from memberships', () => {
  const db = configured()
  try {
    db.exec("INSERT INTO auth_user_phone VALUES ('phone','u','+8613800000000',100,100)")
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_user_email'), 0)
    assert.throws(
      () =>
        db.exec("INSERT INTO auth_user_phone VALUES ('duplicate','v','+8613800000000',100,100)"),
      /UNIQUE constraint/,
    )
    assert.throws(
      () =>
        db.exec("INSERT INTO auth_user_phone VALUES ('unverified','v','+8613900000000',NULL,100)"),
      /NOT NULL constraint/,
    )
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO auth_user_phone VALUES ('foreign-country','v','+12125551212',100,100)",
        ),
      /CHECK constraint/,
    )
    assert.throws(
      () =>
        db.exec("INSERT INTO auth_user_phone VALUES ('non-normal','v','+86138abcdefgh',100,100)"),
      /CHECK constraint/,
    )
    tenant(db, 'tenant', 'u')
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_platform_permission'), 0)
    db.exec(
      "INSERT INTO auth_platform_permission(user_id,permission,status,granted_by,granted_at) VALUES ('v','tenant.manage','ACTIVE','u',100)",
    )
    assert.throws(
      () => db.exec("UPDATE auth_platform_permission SET status='REVOKED'"),
      /CHECK constraint/,
    )
    assert.equal(
      scalar(db, "SELECT count(*) AS value FROM auth_platform_permission WHERE user_id='u'"),
      0,
    )
  } finally {
    db.close()
  }
})

test('UAS-09/10/26/38: independent login and refresh families store bounded clocks, revisions and activity deduplication', () => {
  const db = configured()
  try {
    session(db, 'work')
    session(db, 'club', 'u', 'molis-club-unified-local')
    db.exec(
      "UPDATE auth_login_session SET last_active_at=2000,session_revision=1,revoked_at=3000 WHERE id='work'",
    )
    assert.equal(
      scalar(db, "SELECT last_active_at AS value FROM auth_login_session WHERE id='club'"),
      1000,
    )
    assert.equal(
      scalar(db, "SELECT revoked_at AS value FROM auth_login_session WHERE id='club'"),
      null,
    )
    assert.throws(
      () =>
        db.exec(
          "UPDATE auth_login_session SET absolute_expires_at=absolute_expires_at+1 WHERE id='club'",
        ),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_login_session SET last_active_at=0 WHERE id='club'"),
      /CHECK constraint/,
    )
    db.exec("INSERT INTO auth_login_activity VALUES ('club','event','OPEN',2000)")
    assert.throws(
      () => db.exec("INSERT INTO auth_login_activity VALUES ('club','event','INTERACT',2001)"),
      /UNIQUE constraint/,
    )
    assert.throws(
      () => db.exec("INSERT INTO auth_login_activity VALUES ('club','refresh','REFRESH',2002)"),
      /CHECK constraint/,
    )
    db.exec(
      "INSERT INTO auth_login_refresh_token VALUES ('refresh-one','club',0,0,0,1000,9000,NULL)",
    )
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO auth_login_refresh_token VALUES ('refresh-two','club',1,0,0,2000,9000,NULL)",
        ),
      /UNIQUE constraint/,
    )
    db.exec("UPDATE auth_login_refresh_token SET used_at=2000 WHERE token_hash='refresh-one'")
    db.exec(
      "INSERT INTO auth_login_refresh_token VALUES ('refresh-two','club',1,0,0,2000,9000,NULL)",
    )
    assert.equal(
      scalar(db, "SELECT last_active_at AS value FROM auth_login_session WHERE id='club'"),
      1000,
    )
    assert.equal(
      scalar(db, "SELECT authenticated_at AS value FROM auth_login_session WHERE id='club'"),
      1000,
    )
  } finally {
    db.close()
  }
})

test('UAS-07/11/26/41: transactions and proofs bind purpose, environment, current identity and server revocation order', () => {
  const db = configured()
  try {
    session(db, 'work')
    const pending = sequence(db)
    db.prepare(
      `INSERT INTO auth_product_transaction
      (id,client_id,environment_id,purpose,method,initiator_hash,redirect_uri,product_state,product_state_hash,pkce_challenge,created_seq,created_at,expires_at)
      VALUES ('pending','molis-work-unified-local','unified-local','LOGIN','PHONE_OTP','initiator','http://127.0.0.1:4207/account/callback','opaque-product-state','state-hash','pkce',?,1000,2000)`,
    ).run(pending)
    assert.equal(
      scalar(db, "SELECT product_state AS value FROM auth_product_transaction WHERE id='pending'"),
      'opaque-product-state',
    )
    db.exec(
      "UPDATE auth_product_transaction SET provider_nonce_hash='provider-nonce-digest',provider_pkce_verifier_sealed='sealed-provider-fixture' WHERE id='pending'",
    )
    assert.equal(
      scalar(db, "SELECT pkce_challenge AS value FROM auth_product_transaction WHERE id='pending'"),
      'pkce',
    )
    assert.equal(
      scalar(
        db,
        "SELECT provider_pkce_verifier_sealed AS value FROM auth_product_transaction WHERE id='pending'",
      ),
      'sealed-provider-fixture',
    )
    const revoked = sequence(db, 'REVOCATION')
    db.prepare(
      'INSERT INTO auth_user_security(user_id,revoked_before_seq,updated_at) VALUES (?,?,?)',
    ).run('u', revoked, 1500)
    assert.equal(
      scalar(db, "SELECT account_version AS value FROM auth_user_security WHERE user_id='u'"),
      0,
    )
    assert.equal(
      scalar(db, "SELECT identity_version AS value FROM auth_user_security WHERE user_id='u'"),
      0,
    )
    db.exec("UPDATE auth_user_security SET account_version=account_version+1 WHERE user_id='u'")
    assert.equal(
      scalar(db, "SELECT identity_version AS value FROM auth_user_security WHERE user_id='u'"),
      0,
    )
    assert.throws(
      () => db.exec("UPDATE auth_user_security SET account_version=-1 WHERE user_id='u'"),
      /CHECK constraint/,
    )
    assert.ok(pending < revoked && revoked < sequence(db))
    assert.throws(
      () => db.exec("UPDATE auth_product_transaction SET environment_id='unknown'"),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_product_transaction SET method='EMAIL_CODE'"),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_product_transaction SET purpose='REAUTH'"),
      /CHECK constraint/,
    )
    db.exec(
      "UPDATE auth_product_transaction SET purpose='REAUTH',user_id='u',login_session_id='work',user_epoch=0,session_revision=0,operation='binding.replace',target='binding' WHERE id='pending'",
    )
    assert.throws(
      () => db.exec("UPDATE auth_product_transaction SET user_id='v'"),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_product_transaction SET client_id='molis-club-unified-local'"),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () =>
        db.exec(`INSERT INTO auth_identity_proof
      (token_hash,transaction_id,kind,binding_hash,user_id,user_epoch,created_at,expires_at)
      VALUES ('proof','pending','OPERATION','binding','u',0,1000,2000)`),
      /CHECK constraint/,
    )
    db.exec(`INSERT INTO auth_identity_proof
      (token_hash,transaction_id,kind,binding_hash,user_id,login_session_id,user_epoch,identity_version,session_revision,created_at,expires_at)
      VALUES ('proof','pending','OPERATION','binding','u','work',0,0,0,1000,2000)`)
    assert.throws(
      () => db.exec("UPDATE auth_identity_proof SET user_id='v'"),
      /FOREIGN KEY constraint/,
    )
    db.exec(`INSERT INTO auth_verification_challenge
      (id,transaction_id,channel,canonical_target,credential_hash,delivery_id,delivery_status,max_attempts,created_at,expires_at,next_send_at)
      VALUES ('challenge','pending','SMS','+8613800000000','code-digest','delivery','UNKNOWN',5,1000,2000,1500)`)
    assert.throws(
      () => db.exec('UPDATE auth_verification_challenge SET attempts=6'),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_identity_proof SET verified_identity='[]'"),
      /CHECK constraint/,
    )
  } finally {
    db.close()
  }
})

test('UAS-12/13/16/34/42: managed tenants retain membership incarnations and enforce same-tenant invitations and transfer targets', () => {
  const db = configured()
  try {
    tenant(db, 'a', 'u')
    tenant(db, 'b', 'v')
    member(db, 'a-member', 'a', 'w')
    assert.throws(() => member(db, 'extra-owner', 'a', 'v', 'OWNER'), /UNIQUE constraint/)
    assert.throws(() => member(db, 'viewer', 'a', 'v', 'VIEWER'), /CHECK constraint/)
    assert.throws(() => member(db, 'duplicate-member', 'a', 'w'), /UNIQUE constraint/)
    db.exec("UPDATE auth_tenant_membership SET status='LEFT',ended_at=100 WHERE id='a-member'")
    member(db, 'a-member-again', 'a', 'w')
    assert.equal(
      scalar(
        db,
        "SELECT count(*) AS value FROM auth_tenant_membership WHERE tenant_id='a' AND user_id='w'",
      ),
      2,
    )
    db.exec(
      "INSERT INTO auth_space(id,name,space_type,status,personal_user_id,created_at,updated_at) VALUES ('personal','Personal','PERSONAL','ACTIVE','u',0,0)",
    )
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO auth_managed_tenant(space_id,status,managed_by,managed_at,updated_at) VALUES ('personal','ACTIVE','u',0,0)",
        ),
      /FOREIGN KEY constraint/,
    )
    db.exec(`INSERT INTO auth_tenant_invitation
      (id,tenant_id,target_kind,target_email,inviter_membership_id,status,created_at,expires_at)
      VALUES ('invite','a','EMAIL','not-registered@example.test','a-owner','PENDING',0,1000)`)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_user'), 3)
    assert.throws(
      () => db.exec("UPDATE auth_tenant_invitation SET inviter_membership_id='b-owner'"),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_tenant_invitation SET status='ACCEPTED'"),
      /CHECK constraint/,
    )
    assert.throws(
      () =>
        db.exec(`INSERT INTO auth_ownership_transfer
      (id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at)
      VALUES ('transfer','a','a-owner','b-owner','PENDING',0,1000)`),
      /FOREIGN KEY constraint/,
    )
    db.exec(`INSERT INTO auth_ownership_transfer
      (id,tenant_id,from_membership_id,to_membership_id,status,created_at,expires_at)
      VALUES ('transfer','a','a-owner','a-member-again','PENDING',0,1000)`)
    assert.throws(
      () => db.exec('UPDATE auth_ownership_transfer SET to_membership_id=from_membership_id'),
      /CHECK constraint/,
    )
  } finally {
    db.close()
  }
})

test('UAS-17/18/19/28/36/37: subscription and seat keys reject wrong owners, cross-tenant members and duplicate current assignments', () => {
  const db = configured()
  try {
    tenant(db, 'a', 'u')
    tenant(db, 'b', 'v')
    member(db, 'a-member', 'a', 'w')
    catalog(db)
    subscription(db, 'sub-a', 'a')
    assert.throws(
      () => db.exec("UPDATE billing_subscription SET owner_user_id='u'"),
      /CHECK constraint/,
    )
    assert.throws(
      () => db.exec('UPDATE billing_subscription SET ends_at=starts_at'),
      /CHECK constraint/,
    )
    assert.throws(() => db.exec('UPDATE billing_seat_pool SET quantity=-1'), /CHECK constraint/)
    assert.throws(
      () => db.exec("UPDATE billing_seat_pool SET tenant_id='b'"),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () => assign(db, 'wrong-member', 'sub-a', 'a', 'b-owner', 'v'),
      /FOREIGN KEY constraint/,
    )
    assert.throws(
      () => assign(db, 'wrong-user', 'sub-a', 'a', 'a-member', 'v'),
      /FOREIGN KEY constraint/,
    )
    assign(db, 'assignment', 'sub-a', 'a', 'a-member', 'w')
    assert.throws(() => assign(db, 'duplicate', 'sub-a', 'a', 'a-member', 'w'), /UNIQUE constraint/)
    db.exec('UPDATE billing_subscription SET enabled=0')
    assert.equal(
      scalar(db, "SELECT count(*) AS value FROM billing_seat_assignment WHERE status='ASSIGNED'"),
      1,
    )
    db.exec(
      "UPDATE billing_seat_assignment SET status='ENDED',ended_at=200,end_reason='RELEASED' WHERE id='assignment'",
    )
    assign(db, 'new-assignment', 'sub-a', 'a', 'a-member', 'w')
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM billing_seat_assignment'), 2)
    assert.throws(() => db.exec('DELETE FROM billing_seat_pool'), /FOREIGN KEY constraint/)
    db.exec(`INSERT INTO billing_subscription
      (id,owner_user_id,plan_id,plan_version,enabled,starts_at,ends_at,created_at,updated_at)
      VALUES ('personal','u','plan',1,1,0,1000,0,0)`)
    assert.throws(
      () =>
        db.exec(
          "INSERT INTO billing_seat_pool(subscription_id,tenant_id,seat_type_id,quantity) VALUES ('personal','a','standard',1)",
        ),
      /FOREIGN KEY constraint/,
    )
  } finally {
    db.close()
  }
})

test('UAS-19/21/22/30: existing guarded batches roll back capacity changes together with idempotency and audit records', () => {
  const db = configured()
  try {
    tenant(db, 'a', 'u')
    member(db, 'a-member', 'a', 'v')
    catalog(db)
    subscription(db, 'sub-a', 'a')
    assign(db, 'assignment', 'sub-a', 'a', 'a-member', 'v')
    db.exec('BEGIN')
    try {
      db.exec(`INSERT INTO auth_management_result VALUES
        ('u','molis-work-unified-local','subscription.resize','sub-a','key-digest','request-digest',200,'{"quantity":0}',0,1000)`)
      db.exec(`INSERT INTO auth_management_audit
        (id,actor_user_id,client_id,tenant_id,operation,target_type,target_id,outcome,request_id,occurred_at)
        VALUES ('audit','u','molis-work-unified-local','a','subscription.resize','subscription','sub-a','SUCCESS','request',0)`)
      // Capacity counts preserved ASSIGNED history even when its subscription expires.
      db.exec(`INSERT INTO auth_write_guard(id,ok) SELECT 'capacity',
        (0 >= (SELECT count(*) FROM billing_seat_assignment
          WHERE subscription_id='sub-a' AND seat_type_id='standard' AND status='ASSIGNED'))`)
      db.exec(
        "UPDATE billing_seat_pool SET quantity=0,version=version+1 WHERE subscription_id='sub-a'",
      )
      assert.fail('Expected capacity guard rejection')
    } catch (error) {
      db.exec('ROLLBACK')
      assert.match(String(error), /CHECK constraint/)
    }
    assert.equal(scalar(db, 'SELECT quantity AS value FROM billing_seat_pool'), 1)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_management_result'), 0)
    assert.equal(scalar(db, 'SELECT count(*) AS value FROM auth_management_audit'), 0)
    db.exec(`INSERT INTO auth_management_result VALUES
      ('u','molis-work-unified-local','seat.release','assignment','key-digest','request-digest',200,'{"released":true}',0,1000)`)
    assert.throws(
      () =>
        db.exec(`INSERT INTO auth_management_result VALUES
      ('u','molis-work-unified-local','seat.release','assignment','key-digest','changed-request',200,'{}',0,1000)`),
      /UNIQUE constraint/,
    )
    assert.throws(
      () => db.exec("UPDATE auth_management_result SET response_json='[]'"),
      /CHECK constraint/,
    )
  } finally {
    db.close()
  }
})
