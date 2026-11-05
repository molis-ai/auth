import { all, one, statement, requireValue, digest } from './common.mjs'
import { inventory } from './inventory.mjs'

// Rehearsal metadata only: deliberately not a production D1 migration or public API.
export async function markSyntheticDatabase(db) {
  await db.batch([
    statement(
      db,
      "CREATE TABLE account_rehearsal_marker (id TEXT PRIMARY KEY CHECK(id='SYNTHETIC_ONLY'))",
    ),
    statement(db, "INSERT INTO account_rehearsal_marker VALUES ('SYNTHETIC_ONLY')"),
    statement(
      db,
      "CREATE TABLE account_rehearsal_run (id TEXT PRIMARY KEY, plan_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('APPLIED','ROLLED_BACK')), before_clients TEXT NOT NULL, binding_digest TEXT NOT NULL, applied_at INTEGER NOT NULL, rolled_back_at INTEGER)",
    ),
  ])
}
const selectClients = (db, ids) =>
  all(
    db,
    'SELECT * FROM auth_client WHERE client_id IN (' +
      ids.map(() => '?').join(',') +
      ') ORDER BY client_id',
    ...ids,
  )
async function bindings(db, targets) {
  const rows = []
  for (const t of targets) {
    const row = await one(
      db,
      'SELECT p.*,e.kind,e.auth_origin,e.delivery_mode,e.provider_mode,e.status environment_status,e.version environment_version,cp.product,cp.version product_version FROM auth_client_policy p JOIN auth_environment e ON e.id=p.environment_id JOIN auth_client_product cp ON cp.client_id=p.client_id WHERE p.client_id=?',
      t.newClientId,
    )
    requireValue(
      row &&
        row.product === t.product &&
        row.kind === 'LOCAL' &&
        row.delivery_mode === 'MOCK' &&
        row.provider_mode === 'MOCK' &&
        row.environment_status === 'ACTIVE',
      'Only explicitly registered LOCAL mock product clients may be rehearsed',
    )
    const url = new URL(row.auth_origin)
    requireValue(
      url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname),
      'Rehearsal requires loopback Auth',
    )
    rows.push(row)
  }
  return rows
}
const planShape = (p) => {
  requireValue(
    p &&
      Object.keys(p).sort().join(',') ===
        'environment,formatVersion,inventoryDigest,review,runId,targets' &&
      p.formatVersion === 1 &&
      p.environment === 'SYNTHETIC_ONLY',
    'Invalid rehearsal plan',
  )
  requireValue(
    typeof p.runId === 'string' &&
      /^[a-zA-Z0-9_-]{8,100}$/.test(p.runId) &&
      /^[a-f0-9]{64}$/.test(p.inventoryDigest),
    'Invalid run or source digest',
  )
  requireValue(
    p.review &&
      Object.keys(p.review).sort().join(',') === 'evidenceReference,reviewedBy' &&
      ['reviewedBy', 'evidenceReference'].every(
        (k) => typeof p.review[k] === 'string' && /^[a-zA-Z0-9._-]{3,100}$/.test(p.review[k]),
      ),
    'Missing review record',
  )
  requireValue(
    Array.isArray(p.targets) &&
      p.targets.length === 2 &&
      new Set(p.targets.map((t) => t.product)).size === 2 &&
      p.targets.every(
        (t) =>
          Object.keys(t).sort().join(',') === 'legacyClientId,newClientId,product' &&
          ['WORK', 'CLUB'].includes(t.product) &&
          [t.legacyClientId, t.newClientId].every(
            (x) => typeof x === 'string' && x.length > 0 && x.length < 200,
          ),
      ),
    'Explicit Work and Club client pairs required',
  )
  requireValue(
    new Set(p.targets.flatMap((t) => [t.legacyClientId, t.newClientId])).size === 4,
    'Client sets must not overlap',
  )
}
async function preflight(db, p) {
  planShape(p)
  requireValue(
    await one(db, "SELECT id FROM account_rehearsal_marker WHERE id='SYNTHETIC_ONLY'"),
    'Synthetic rehearsal marker required',
  )
  return bindings(db, p.targets)
}
const guard = (db, condition, ...values) => {
  const id = crypto.randomUUID()
  return {
    guardStatement: statement(
      db,
      'INSERT INTO auth_write_guard(id,ok) SELECT ?,CASE WHEN ' + condition + ' THEN 1 ELSE 0 END',
      id,
      ...values,
    ),
    cleanup: statement(db, 'DELETE FROM auth_write_guard WHERE id=?', id),
  }
}
function clientGuards(db, clients) {
  return [
    ...clients.map((c) =>
      guard(
        db,
        "EXISTS(SELECT 1 FROM auth_application WHERE id=? AND status='ACTIVE' AND is_console=0)",
        c.application_id,
      ),
    ),
    ...clients.map((c) =>
      guard(
        db,
        'EXISTS(SELECT 1 FROM auth_client WHERE client_id=? AND application_id=? AND version=? AND status=? AND redirects=? AND scopes=? AND client_type=?)',
        c.client_id,
        c.application_id,
        c.version,
        c.status,
        c.redirects,
        c.scopes,
        c.client_type,
      ),
    ),
  ]
}
function bindingGuards(db, rows) {
  return rows.map((r) =>
    guard(
      db,
      "EXISTS(SELECT 1 FROM auth_client_policy p JOIN auth_environment e ON e.id=p.environment_id JOIN auth_client_product cp ON cp.client_id=p.client_id WHERE p.client_id=? AND p.version=? AND p.environment_id=? AND p.allowed_origins=? AND p.policy_profile='unified-account-v2' AND e.version=? AND e.kind='LOCAL' AND e.auth_origin=? AND e.delivery_mode='MOCK' AND e.provider_mode='MOCK' AND e.status='ACTIVE' AND cp.product=? AND cp.version=?)",
      r.client_id,
      r.version,
      r.environment_id,
      r.allowed_origins,
      r.environment_version,
      r.auth_origin,
      r.product,
      r.product_version,
    ),
  )
}
function revokeV1(db, clientId, now) {
  return [
    statement(
      db,
      'UPDATE auth_grant SET revoked_at=? WHERE client_id=? AND revoked_at IS NULL',
      now,
      clientId,
    ),
    statement(
      db,
      'UPDATE auth_code SET used_at=COALESCE(used_at,?) WHERE client_id=?',
      now,
      clientId,
    ),
    statement(
      db,
      "UPDATE auth_transaction SET status='CANCELLED',proof_hash=NULL WHERE json_extract(context,'$.clientId')=?",
      clientId,
    ),
  ]
}
function revokeV2(db, clientId, now) {
  return [
    statement(
      db,
      'UPDATE auth_login_session SET revoked_at=?,session_revision=session_revision+1 WHERE client_id=? AND revoked_at IS NULL',
      now,
      clientId,
    ),
    statement(
      db,
      'UPDATE auth_identity_proof SET consumed_at=COALESCE(consumed_at,?) WHERE transaction_id IN (SELECT id FROM auth_product_transaction WHERE client_id=?)',
      now,
      clientId,
    ),
    statement(
      db,
      "UPDATE auth_product_transaction SET status='CANCELLED',provider_pkce_verifier_sealed=NULL WHERE client_id=?",
      clientId,
    ),
  ]
}
const receipt = (row) => ({
  runId: row.id,
  state: row.state,
  appliedAt: row.applied_at,
  rolledBackAt: row.rolled_back_at,
})
/** Uses the same atomic statements on SQLite and workerd/D1. No user, credential, TEAM, or shared root session is changed. */
export async function applyRehearsal(db, p) {
  const bound = await preflight(db, p),
    hash = digest(p),
    old = await one(db, 'SELECT * FROM account_rehearsal_run WHERE id=?', p.runId)
  if (old) {
    requireValue(
      old.plan_digest === hash && old.state === 'APPLIED',
      'Run conflict or already rolled back; use a fresh review',
    )
    return receipt(old)
  }
  requireValue(
    (await inventory(db, 'AUTH')).sourceDigest === p.inventoryDigest,
    'Inventory changed; review again',
  )
  const clients = await selectClients(
    db,
    p.targets.flatMap((t) => [t.legacyClientId, t.newClientId]),
  )
  requireValue(clients.length === 4, 'Client not found')
  for (const t of p.targets) {
    const before = clients.find((c) => c.client_id === t.legacyClientId),
      after = clients.find((c) => c.client_id === t.newClientId)
    requireValue(
      before.status === 'ACTIVE' && after.status === 'DISABLED',
      'Expected active old and staged disabled new clients',
    )
    requireValue(
      !(await one(
        db,
        'SELECT client_id FROM auth_client_policy WHERE client_id=?',
        t.legacyClientId,
      )),
      'Old client already uses v2',
    )
    for (const c of [before, after])
      requireValue(
        await one(
          db,
          "SELECT id FROM auth_application WHERE id=? AND status='ACTIVE' AND is_console=0",
          c.application_id,
        ),
        'Product application must be active and non-console',
      )
  }
  const now = Date.now(),
    writes = [...clientGuards(db, clients), ...bindingGuards(db, bound)]
  for (const t of p.targets)
    writes.push(
      guard(db, 'NOT EXISTS(SELECT 1 FROM auth_client_policy WHERE client_id=?)', t.legacyClientId),
      statement(
        db,
        "UPDATE auth_client SET status='DISABLED',version=version+1 WHERE client_id=?",
        t.legacyClientId,
      ),
      statement(
        db,
        "UPDATE auth_client SET status='ACTIVE',version=version+1 WHERE client_id=?",
        t.newClientId,
      ),
      ...revokeV1(db, t.legacyClientId, now),
      ...revokeV2(db, t.newClientId, now),
    )
  writes.push(
    statement(
      db,
      "INSERT INTO account_rehearsal_run VALUES (?,?,'APPLIED',?,?,?,NULL)",
      p.runId,
      hash,
      JSON.stringify(clients),
      digest(bound),
      now,
    ),
  )
  await runGuarded(db, writes)
  return receipt(await one(db, 'SELECT * FROM account_rehearsal_run WHERE id=?', p.runId))
}
export async function rollbackRehearsal(db, p) {
  const bound = await preflight(db, p),
    row = await one(db, 'SELECT * FROM account_rehearsal_run WHERE id=?', p.runId)
  requireValue(row && row.plan_digest === digest(p), 'Run not found or plan changed')
  if (row.state === 'ROLLED_BACK') return receipt(row)
  requireValue(
    row.binding_digest === digest(bound),
    'Product configuration changed; do not overwrite it',
  )
  const before = JSON.parse(row.before_clients),
    current = await selectClients(
      db,
      before.map((c) => c.client_id),
    )
  requireValue(
    current.length === before.length &&
      current.every((c) => {
        const b = before.find((v) => v.client_id === c.client_id)
        return (
          digest({ ...c, status: b.status, version: b.version }) === digest(b) &&
          c.version === b.version + 1 &&
          c.status === (b.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE')
        )
      }),
    'Client changed after cutover; review rollback',
  )
  const now = Date.now(),
    writes = [
      guard(
        db,
        "EXISTS(SELECT 1 FROM account_rehearsal_run WHERE id=? AND state='APPLIED')",
        p.runId,
      ),
      ...clientGuards(db, current),
      ...bindingGuards(db, bound),
    ]
  for (const t of p.targets)
    writes.push(
      guard(db, 'NOT EXISTS(SELECT 1 FROM auth_client_policy WHERE client_id=?)', t.legacyClientId),
      statement(
        db,
        "UPDATE auth_client SET status='ACTIVE',version=version+1 WHERE client_id=?",
        t.legacyClientId,
      ),
      statement(
        db,
        "UPDATE auth_client SET status='DISABLED',version=version+1 WHERE client_id=?",
        t.newClientId,
      ),
      ...revokeV1(db, t.legacyClientId, now),
      ...revokeV2(db, t.newClientId, now),
    )
  writes.push(
    statement(
      db,
      "UPDATE account_rehearsal_run SET state='ROLLED_BACK',rolled_back_at=? WHERE id=?",
      now,
      p.runId,
    ),
  )
  await runGuarded(db, writes)
  return receipt(await one(db, 'SELECT * FROM account_rehearsal_run WHERE id=?', p.runId))
}
async function runGuarded(db, writes) {
  await db.batch([
    ...writes.map((w) => w.guardStatement ?? w),
    ...writes.filter((w) => w.cleanup).map((w) => w.cleanup),
  ])
}
