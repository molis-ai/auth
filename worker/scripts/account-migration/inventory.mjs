import { all, digest, requireValue } from './common.mjs'
export const credentialFormat = (value) =>
  !value
    ? 'ABSENT'
    : /^\{pbkdf2-sha256-600k-v1\}[0-9a-f]{96}$/.test(value)
      ? 'AUTH_PBKDF2_SHA256_600K_V1'
      : /^[0-9a-f]+:[0-9a-f]+$/i.test(value)
        ? 'HEX_PAIR_REQUIRES_REVIEW'
        : 'UNKNOWN_REQUIRES_REVIEW'
const groups = (rows) =>
  [...Map.groupBy(rows, (r) => r.key).values()]
    .filter((g) => g.length > 1)
    .map((g) => g.map((r) => r.ref).sort())
const present = (value) => typeof value === 'string' && value.length > 0
const authTables = [
  'auth_user',
  'auth_user_email',
  'auth_local_credential',
  'auth_external_identity',
  'auth_space',
  'auth_membership',
  'auth_client',
  'auth_application',
  'auth_user_security',
  'auth_user_phone',
  'auth_managed_tenant',
  'auth_client_policy',
  'auth_client_product',
  'auth_environment',
]
const clubTables = ['user', 'account', 'session', 'notes', 'central_business_identities']
/** Read-only inventory: raw credentials/addresses/subjects never enter the output. Version is not inferred from a repository checkout. */
export async function inventory(db, product) {
  requireValue(
    ['AUTH', 'CLUB'].includes(product),
    'Unsupported source; Work Home is not inspected by this tool',
  )
  const schema = await all(
    db,
    "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
  )
  const names = new Set(schema.filter((t) => t.type === 'table').map((t) => t.name)),
    data = {}
  const tables = product === 'AUTH' ? authTables : clubTables
  requireValue(
    (product === 'AUTH' ? authTables.slice(0, 8) : clubTables.slice(0, 4)).every((t) =>
      names.has(t),
    ),
    'Unknown source schema; preserve and review before conversion',
  )
  for (const table of tables)
    if (names.has(table))
      data[table] = (await all(db, 'SELECT * FROM ' + table)).sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      )
  const requiredColumns =
    product === 'AUTH'
      ? {
          auth_user: ['id', 'status'],
          auth_user_email: ['id', 'user_id', 'canonical_email', 'verified_at'],
          auth_local_credential: ['user_id', 'password_hash'],
          auth_external_identity: ['id', 'user_id', 'provider', 'issuer', 'subject'],
          auth_space: ['id', 'space_type', 'status'],
          auth_membership: ['space_id', 'user_id', 'role'],
          auth_client: ['client_id', 'application_id', 'status', 'version'],
        }
      : {
          user: ['id', 'email', 'email_verified'],
          account: ['id', 'user_id', 'provider_id', 'account_id', 'password'],
          notes: ['id', 'user_id'],
        }
  for (const [table, expected] of Object.entries(requiredColumns)) {
    const columns = await all(db, 'PRAGMA table_info(' + table + ')')
    requireValue(
      expected.every((c) => columns.some((x) => x.name === c)),
      'Unknown source columns; do not guess identity or verification state',
    )
  }
  const report = {
    formatVersion: 1,
    product,
    observedDeploymentVersion: 'NOT_OBSERVED',
    schemaDigest: digest(schema),
    sourceDigest: digest(data),
    counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    foreignKeyViolations: (await all(db, 'PRAGMA foreign_key_check')).map((r) => ({
      table: r.table,
      parent: r.parent,
      row: r.rowid,
    })),
    migrationHistory: [],
    users: [],
    duplicateEmailGroups: [],
    duplicateExternalIdentityGroups: [],
    teams: [],
    clients: [],
  }
  if (names.has('d1_migrations'))
    report.migrationHistory = (await all(db, 'SELECT name FROM d1_migrations ORDER BY name')).map(
      (r) => r.name,
    )
  if (product === 'AUTH') {
    report.users = data.auth_user.map((u) => {
      const emails = data.auth_user_email.filter((e) => e.user_id === u.id),
        credential = data.auth_local_credential.find((c) => c.user_id === u.id),
        identities = data.auth_external_identity.filter((e) => e.user_id === u.id)
      return {
        userId: u.id,
        status: u.status,
        emailBindings: emails.map((e) => ({ bindingId: e.id, verified: e.verified_at !== null })),
        passwordFormat: credentialFormat(credential?.password_hash),
        externalBindings: identities.map((e) => ({
          bindingId: e.id,
          provider: e.provider,
          stableIdentityPresent: present(e.issuer) && present(e.subject),
          v2Provider: ['GOOGLE', 'GITHUB'].includes(e.provider.toUpperCase()),
          mockIssuer: e.issuer.startsWith('https://mock.'),
        })),
        disposition: 'PRESERVE_ID',
        reviewRequired: [
          ...(emails.some((e) => e.verified_at === null) ? ['EMAIL_VERIFICATION_REQUIRED'] : []),
          ...(credential &&
          credentialFormat(credential.password_hash) !== 'AUTH_PBKDF2_SHA256_600K_V1'
            ? ['PASSWORD_FORMAT']
            : []),
          ...(identities.length ? ['PROVIDER_ISSUER_SUBJECT_AND_APP_REGISTRATION'] : []),
        ],
      }
    })
    report.duplicateEmailGroups = groups(
      data.auth_user_email.map((e) => ({
        key: e.canonical_email.trim().toLowerCase(),
        ref: e.user_id + ':' + e.id,
      })),
    )
    report.duplicateExternalIdentityGroups = groups(
      data.auth_external_identity.map((e) => ({
        key: JSON.stringify([e.issuer, e.subject]),
        ref: e.user_id + ':' + e.id,
      })),
    )
    report.teams = data.auth_space
      .filter((s) => s.space_type === 'TEAM')
      .map((s) => ({
        spaceId: s.id,
        status: s.status,
        managed: (data.auth_managed_tenant ?? []).some((t) => t.space_id === s.id),
        members: data.auth_membership
          .filter((m) => m.space_id === s.id)
          .map((m) => ({ userId: m.user_id, role: m.role })),
        disposition: (data.auth_managed_tenant ?? []).some((t) => t.space_id === s.id)
          ? 'PRESERVE_MANAGED'
          : 'REVIEW_REQUIRED_NO_AUTO_ENROLLMENT',
      }))
    report.clients = data.auth_client.map((c) => ({
      clientId: c.client_id,
      applicationId: c.application_id,
      status: c.status,
      version: c.version,
      policy:
        (data.auth_client_policy ?? []).find((p) => p.client_id === c.client_id)?.policy_profile ??
        'V1',
      product:
        (data.auth_client_product ?? []).find((p) => p.client_id === c.client_id)?.product ?? null,
    }))
  } else {
    report.users = data.user.map((u) => ({
      userId: u.id,
      emailPresent: u.email !== null,
      emailVerified: Boolean(u.email_verified),
      passwordFormats: data.account
        .filter((a) => a.user_id === u.id && a.password)
        .map((a) => credentialFormat(a.password)),
      externalBindings: data.account
        .filter((a) => a.user_id === u.id && a.provider_id !== 'credential')
        .map((a) => ({
          bindingId: a.id,
          provider: a.provider_id,
          stableSubjectPresent: present(a.account_id),
          issuer: 'REVIEW_REQUIRED',
        })),
      noteCount: data.notes.filter((n) => n.user_id === u.id).length,
      disposition: (data.central_business_identities ?? []).some((m) => m.local_user_id === u.id)
        ? 'MAPPED'
        : 'REVIEW_REQUIRED_NO_EMAIL_CLAIM',
    }))
    report.duplicateEmailGroups = groups(
      data.user
        .filter((u) => u.email)
        .map((u) => ({ key: u.email.trim().toLowerCase(), ref: u.id })),
    )
    report.duplicateExternalIdentityGroups = groups(
      data.account
        .filter((a) => a.provider_id !== 'credential')
        .map((a) => ({
          key: JSON.stringify([a.provider_id, a.account_id]),
          ref: a.user_id + ':' + a.id,
        })),
    )
  }
  return report
}
