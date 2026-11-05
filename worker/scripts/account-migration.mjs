import { DatabaseSync, backup } from 'node:sqlite'
import { mkdirSync, realpathSync, writeFileSync, chmodSync, copyFileSync, constants } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sqlitePort, requireValue } from './account-migration/common.mjs'
import { inventory } from './account-migration/inventory.mjs'
import { applyRehearsal, rollbackRehearsal } from './account-migration/cutover.mjs'
import { initializeSynthetic, targets } from './account-migration/synthetic.mjs'

export async function run(args) {
  const [operation, productOrDirectory, filename, ...extra] = args
  requireValue(
    extra.length === 0,
    'Unexpected arguments; remote and production mutation are not supported',
  )
  if (operation === 'inventory') {
    requireValue(
      ['AUTH', 'CLUB'].includes(productOrDirectory) && filename,
      'Usage: inventory AUTH|CLUB <offline SQLite copy>',
    )
    const path = realpathSync(resolve(filename))
    requireValue(
      !path.includes('/.wrangler/') && !path.includes('/.molis/'),
      'Use an explicitly authorized offline copy',
    )
    const sql = new DatabaseSync(path, { readOnly: true })
    try {
      return await inventory(sqlitePort(sql), productOrDirectory)
    } finally {
      sql.close()
    }
  }
  requireValue(
    operation === 'rehearse' && productOrDirectory && !filename,
    'Usage: rehearse <new output directory>; only generated synthetic data can be mutated',
  )
  const dir = resolve(productOrDirectory)
  mkdirSync(dir, { mode: 0o700 }) // Refuses an existing directory.
  const file = join(dir, 'synthetic-auth.sqlite'),
    sql = new DatabaseSync(file)
  chmodSync(file, 0o600)
  try {
    sql.exec('PRAGMA foreign_keys=ON')
    const db = sqlitePort(sql)
    await initializeSynthetic(db)
    const before = await inventory(db, 'AUTH'),
      plan = {
        formatVersion: 1,
        environment: 'SYNTHETIC_ONLY',
        runId: crypto.randomUUID(),
        inventoryDigest: before.sourceDigest,
        targets,
        review: { reviewedBy: 'synthetic-reviewer', evidenceReference: 'generated-fixture' },
      }
    const backupFile = join(dir, 'synthetic-auth-before.sqlite')
    await backup(sql, backupFile)
    chmodSync(backupFile, 0o600)
    const applied = await applyRehearsal(db, plan),
      repeated = await applyRehearsal(db, plan),
      rolledBack = await rollbackRehearsal(db, plan),
      rollbackRepeated = await rollbackRehearsal(db, plan),
      after = await inventory(db, 'AUTH')
    // Recovery exercise is a separate offline file, never replacement of the running database.
    const restoredFile = join(dir, 'synthetic-auth-restored-offline.sqlite')
    copyFileSync(backupFile, restoredFile, constants.COPYFILE_EXCL)
    chmodSync(restoredFile, 0o600)
    const restored = new DatabaseSync(restoredFile, { readOnly: true })
    let backupRestorationVerified = false
    try {
      backupRestorationVerified =
        (await inventory(sqlitePort(restored), 'AUTH')).sourceDigest === before.sourceDigest &&
        restored.prepare('PRAGMA integrity_check').get().integrity_check === 'ok' &&
        restored.prepare('PRAGMA foreign_key_check').all().length === 0
    } finally {
      restored.close()
    }
    const report = {
      formatVersion: 1,
      kind: 'SYNTHETIC_ONLY',
      applied,
      repeated,
      rolledBack,
      rollbackRepeated,
      usersPreserved: JSON.stringify(before.users) === JSON.stringify(after.users),
      teamsPreserved: JSON.stringify(before.teams) === JSON.stringify(after.teams),
      otherProductsPreserved:
        sql
          .prepare("SELECT revoked_at FROM auth_grant WHERE client_id='synthetic-other-product'")
          .get().revoked_at === null,
      oldTokensRemainRevoked:
        sql
          .prepare(
            "SELECT count(*) n FROM auth_grant WHERE client_id IN ('synthetic-old-work','synthetic-old-club') AND revoked_at IS NULL",
          )
          .get().n === 0,
      productionDataAccessed: false,
      backupRestorationVerified,
    }
    requireValue(
      report.backupRestorationVerified &&
        report.usersPreserved &&
        report.teamsPreserved &&
        report.otherProductsPreserved &&
        report.oldTokensRemainRevoked,
      'Synthetic rehearsal invariant failed',
    )
    for (const [name, data] of [
      ['inventory-before', before],
      ['reviewed-plan', plan],
      ['inventory-after', after],
      ['rehearsal-report', report],
    ])
      writeFileSync(join(dir, name + '.json'), JSON.stringify(data, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      })
    return { directory: dir, ...report }
  } finally {
    sql.close()
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(JSON.stringify(await run(process.argv.slice(2)), null, 2) + '\n')
  } catch {
    process.stderr.write(
      'Account inventory/rehearsal refused or failed. Check the offline schema, arguments and review prerequisites; no remote mode is available.\n',
    )
    process.exitCode = 1
  }
}
