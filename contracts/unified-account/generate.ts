import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The generated JSON is the language-neutral contract. No product implementation imports this builder.
type Schema = Record<string, unknown>
const defs: Record<string, Schema> = {}
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` })
const str = (minLength = 1, maxLength = 160, extra: Schema = {}): Schema => ({
  type: 'string',
  minLength,
  maxLength,
  ...extra,
})
const en = (...values: string[]): Schema => ({ type: 'string', enum: values })
const num = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER): Schema => ({
  type: 'integer',
  minimum,
  maximum,
})
const arr = (items: Schema, maxItems = 100, minItems = 0): Schema => ({
  type: 'array',
  items,
  minItems,
  maxItems,
})
const obj = (properties: Record<string, Schema>, required = Object.keys(properties)): Schema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const union = (...oneOf: Schema[]): Schema => ({ oneOf })
const nullable = (schema: Schema): Schema => union(schema, { type: 'null' })
const bool: Schema = { type: 'boolean' }
const literal = (value: unknown): Schema => ({ const: value })
const add = (name: string, schema: Schema): Schema => {
  defs[name] = schema
  return ref(name)
}
const id = add('Id', str(1, 160, { pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' }))
const time = add('Timestamp', str(20, 24, { format: 'date-time' }))
const secret = add('OpaqueSecret', str(32, 4096, { pattern: '^[A-Za-z0-9._~-]+$' }))
const version = add('Version', num(0))
const planVersion = add('PlanVersionNumber', num(1))
const email = add('Email', str(3, 254, { format: 'email' }))
const phone = add('Phone', str(14, 14, { pattern: '^\\+861[3-9][0-9]{9}$' }))
const url = add('HttpUrl', str(1, 2048, { format: 'http-url' }))
const password = add('LoginPassword', str(1, 512))
const newPassword = add(
  'NewPassword',
  str(8, 512, {
    description:
      'Transport bound only. Existing backend applies NFC normalization, 8..128 Unicode scalar values, raw UTF-16 length <=512, and its existing common-password rules.',
  }),
)
const pngDataUrl = add(
  'PngDataUrl',
  str(30, 184320, {
    pattern: '^data:image/png;base64,[A-Za-z0-9+/]+={0,2}$',
    description:
      'Structural encoding only: the server must decode, bound dimensions and re-encode PNG before storing or returning it.',
  }),
)
const name = add('DisplayName', str(1, 80))
const challenge = add('S256Challenge', str(43, 43, { pattern: '^[A-Za-z0-9_-]{43}$' }))
const codeVerifier = add('CodeVerifier', str(43, 128, { pattern: '^[A-Za-z0-9._~-]+$' }))
const expected = { expectedVersion: version }
const reason = str(1, 500)
const methods = ['EMAIL_PASSWORD', 'PHONE_OTP', 'GOOGLE', 'GITHUB']
const identityMethods = ['EMAIL_CODE', 'PHONE_OTP', 'GOOGLE', 'GITHUB']
const loginType = add('LoginMethodType', en('EMAIL', 'PHONE', 'GOOGLE', 'GITHUB'))
add('Empty', obj({}))
add(
  'Scope',
  union(obj({ kind: literal('PERSONAL') }), obj({ kind: literal('TENANT'), tenantId: id })),
)
add(
  'UserView',
  obj({
    issuer: url,
    userId: id,
    displayName: name,
    email: nullable(email),
    avatarUrl: nullable(union(url, pngDataUrl)),
    version,
  }),
)
add(
  'LoginMethod',
  obj({
    bindingId: id,
    type: loginType,
    maskedLabel: str(1, 254),
    verified: bool,
    usableForLogin: bool,
  }),
)
add(
  'SessionView',
  obj({
    loginSessionId: id,
    applicationId: id,
    clientId: id,
    authenticatedAt: time,
    lastActiveAt: time,
    idleExpiresAt: time,
    absoluteExpiresAt: time,
    sessionRevision: version,
  }),
)
add(
  'PlatformCapability',
  en(
    'TENANT_CREATE',
    'TENANT_READ',
    'TENANT_STATUS',
    'CATALOG_WRITE',
    'SUBSCRIPTION_READ',
    'SUBSCRIPTION_WRITE',
    'AUDIT_READ',
    'APPLICATION_READ',
    'APPLICATION_WRITE',
    'CLIENT_READ',
    'CLIENT_WRITE',
    'USER_READ',
    'USER_STATUS',
    'USER_EMAIL_WRITE',
    'PLATFORM_PERMISSION_WRITE',
  ),
)
add(
  'MeView',
  obj({
    user: ref('UserView'),
    loginMethods: arr(ref('LoginMethod'), 20),
    passwordEnabled: bool,
    session: ref('SessionView'),
    platformCapabilities: arr(ref('PlatformCapability'), 15),
  }),
)
add(
  'TokenSet',
  obj({
    accessToken: secret,
    refreshToken: secret,
    tokenType: literal('Bearer'),
    accessExpiresAt: time,
    session: ref('SessionView'),
  }),
)
const operations = [
  { operation: literal('BIND_METHOD'), target: obj({ method: loginType }) },
  { operation: literal('REPLACE_METHOD'), target: obj({ bindingId: id }) },
  { operation: literal('UNLINK_METHOD'), target: obj({ bindingId: id }) },
  { operation: literal('CHANGE_PASSWORD'), target: obj({ kind: literal('PASSWORD') }) },
]
add('SensitiveOperation', union(...operations.map((op) => obj(op))))
const transactionBase = {
  clientId: id,
  redirectUri: url,
  state: str(16, 512),
  codeChallenge: challenge,
  codeChallengeMethod: literal('S256'),
  initiatorChallenge: challenge,
}
const transactionVariants: Schema[] = []
for (const method of methods)
  transactionVariants.push(
    obj({ ...transactionBase, purpose: literal('LOGIN'), method: literal(method) }),
  )
transactionVariants.push(
  obj({ ...transactionBase, purpose: literal('EMAIL_SIGNUP'), method: literal('EMAIL_CODE') }),
)
for (const method of methods)
  for (const operation of operations)
    transactionVariants.push(
      obj({
        ...transactionBase,
        purpose: literal('REAUTH'),
        method: literal(method),
        ...operation,
        useSession: bool,
      }, [...Object.keys(transactionBase), "purpose", "method", ...Object.keys(operation)]),
    )
for (const method of identityMethods) {
  transactionVariants.push(
    obj({ ...transactionBase, purpose: literal('BIND'), method: literal(method) }),
  )
  transactionVariants.push(
    obj({
      ...transactionBase,
      purpose: literal('REPLACE'),
      method: literal(method),
      bindingId: id,
    }),
  )
}
transactionVariants.push(
  obj({ ...transactionBase, purpose: literal('PASSWORD_RESET'), method: literal('EMAIL_CODE') }),
)
add('CreateTransactionRequest', union(...transactionVariants))
add(
  'ReauthenticationRequest',
  union(
    ...methods.flatMap((method) =>
      operations.map((op) => obj({ ...transactionBase, method: literal(method), ...op, useSession: bool }, Object.keys({ ...transactionBase, method: literal(method), ...op }))),
    ),
  ),
)
add(
  'NextStep',
  en(
    'REQUEST_CHALLENGE',
    'VERIFY_CHALLENGE',
    'PASSWORD_LOGIN',
    'EMAIL_SIGNUP',
    'PHONE_LOGIN',
    'START_PROVIDER',
    'WAIT_PROVIDER',
    'COMPLETE',
    'NONE',
  ),
)
add(
  'TransactionCreated',
  obj({
    transactionId: id,
    status: en('PENDING', 'VERIFIED'),
    nextStep: en('REQUEST_CHALLENGE', 'PASSWORD_LOGIN', 'START_PROVIDER', 'COMPLETE'),
    expiresAt: time,
  }),
)
add(
  'TransactionView',
  union(
    obj({
      transactionId: id,
      status: literal('PENDING'),
      nextStep: en(
        'REQUEST_CHALLENGE',
        'VERIFY_CHALLENGE',
        'PASSWORD_LOGIN',
        'EMAIL_SIGNUP',
        'PHONE_LOGIN',
        'START_PROVIDER',
        'WAIT_PROVIDER',
      ),
      expiresAt: time,
    }),
    obj({
      transactionId: id,
      status: literal('VERIFIED'),
      nextStep: literal('COMPLETE'),
      expiresAt: time,
    }),
    obj({
      transactionId: id,
      status: en('CONSUMED', 'CANCELLED', 'EXPIRED'),
      nextStep: literal('NONE'),
      expiresAt: time,
    }),
  ),
)
add(
  'ChallengeRequest',
  union(
    obj({ channel: literal('EMAIL'), address: email }),
    obj({ channel: literal('SMS'), address: phone }),
  ),
)
add('ChallengeCreated', obj({ challengeId: id, expiresAt: time, retryAfterSeconds: num(0, 3600) }))
add('VerifyChallengeRequest', obj({ credential: str(6, 6, { pattern: '^[0-9]{6}$' }) }))
add('VerificationResult', obj({ verificationProof: secret, expiresAt: time }))
add('PasswordLoginRequest', obj({ email, password }))
add('EmailSignupRequest', obj({ email, password: newPassword, verificationProof: secret }))
add('PhoneLoginRequest', obj({ verificationProof: secret }))
add('VerifiedResult', obj({ status: literal('VERIFIED'), nextStep: literal('COMPLETE') }))
add('ProviderStartResult', obj({ browserStartUrl: url }))
add(
  'TransactionCompleteResult',
  union(
    obj({ kind: literal('LOGIN_CODE'), code: secret, state: str(16, 512), expiresAt: time }),
    obj({ kind: literal('OPERATION_PROOF'), operationProof: secret, expiresAt: time }),
    obj({ kind: literal('NEW_IDENTITY_PROOF'), newIdentityProof: secret, expiresAt: time }),
    obj({ kind: literal('RESET_PROOF'), resetProof: secret, expiresAt: time }),
  ),
)
add('TransactionCancelResult', obj({ status: literal('CANCELLED') }))
add(
  'TokenRequest',
  union(
    obj({
      grantType: literal('authorization_code'),
      clientId: id,
      code: secret,
      redirectUri: url,
      codeVerifier,
    }),
    obj({ grantType: literal('refresh_token'), clientId: id, refreshToken: secret }),
  ),
)
add('ProfileUpdateRequest', {
  ...obj({ displayName: name, avatarDataUrl: nullable(pngDataUrl), ...expected }, [
    'expectedVersion',
  ]),
  anyOf: [{ required: ['displayName'] }, { required: ['avatarDataUrl'] }],
})
add('LoginMethodsView', obj({ loginMethods: arr(ref('LoginMethod'), 20), version }))
add('BindMethodRequest', obj({ operationProof: secret, newIdentityProof: secret, ...expected }))
add('UnlinkMethodRequest', obj({ operationProof: secret, ...expected }))
add('PasswordChangeRequest', obj({ operationProof: secret, newPassword, ...expected }))
add(
  'PasswordChangeResult',
  obj({ passwordChanged: literal(true), keptLoginSessionId: id, session: ref('SessionView') }),
)
add('PasswordResetRequest', obj({ transactionId: id, resetProof: secret, newPassword }))
add(
  'PasswordResetResult',
  obj({ passwordChanged: literal(true), nextStep: literal('LOGIN_REQUIRED') }),
)
add('ActivityRequest', obj({ eventId: id, kind: en('OPEN', 'INTERACT') }))
add(
  'LogoutRequest',
  union(ref('Empty'), obj({ refreshProof: obj({ clientId: id, refreshToken: secret }) })),
)
add(
  'CurrentLogoutResult',
  obj({
    revokedScope: literal('CURRENT_LOGIN'),
    status: en('REVOKED', 'ALREADY_ENDED'),
    loginSessionId: id,
  }),
)
add(
  'GlobalLogoutResult',
  obj({ revokedScope: literal('ALL_MOLIS_PRODUCTS'), status: literal('REVOKED') }),
)
add('ExpectedVersionRequest', obj(expected))
add('TenantRole', en('OWNER', 'ADMIN', 'MEMBER'))
add(
  'TenantView',
  obj({
    tenantId: id,
    name,
    status: en('ACTIVE', 'DISABLED'),
    myRole: ref('TenantRole'),
    membershipId: id,
    version,
  }),
)
add(
  'PlatformTenantView',
  obj({ tenantId: id, name, status: en('ACTIVE', 'DISABLED'), ownerUserId: id, version }),
)
add(
  'Membership',
  obj({
    membershipId: id,
    tenantId: id,
    userId: id,
    role: ref('TenantRole'),
    status: en('ACTIVE', 'LEFT', 'REMOVED'),
    version,
  }),
)
add('TenantUpdateRequest', obj({ name, ...expected }))
add('TenantCreateRequest', obj({ name, ownerUserId: id, reason }))
add('PlatformApplication', obj({ applicationId: id, name, status: en('ACTIVE', 'DISABLED'), version }))
add('PlatformApplicationPage', obj({ items: arr(ref('PlatformApplication')), nextCursor: nullable(str(1, 2048)) }))
add('ApplicationCreateRequest', obj({ name }))
add('ApplicationUpdateRequest', obj({ name, status: en('ACTIVE', 'DISABLED'), ...expected }))
const origins = { ...arr(str(1, 2048, { format: 'http-origin' }), 32, 1), uniqueItems: true }
const redirects = { ...arr(url, 32, 1), uniqueItems: true }
add('PlatformLoginClient', obj({ clientId: id, applicationId: id, clientType: en('WEB', 'MACOS', 'CLI'), status: en('ACTIVE', 'DISABLED'), version, environmentId: id, policyVersion: version, allowedOrigins: origins, redirectAllowlist: redirects, product: nullable(en('WORK', 'CLUB')) }))
add('PlatformLoginClientPage', obj({ items: arr(ref('PlatformLoginClient')), nextCursor: nullable(str(1, 2048)) }))
add('LoginClientCreateRequest', obj({ clientId: id, clientType: en('WEB', 'MACOS', 'CLI'), environmentId: id, allowedOrigins: origins, redirectAllowlist: redirects, product: en('WORK', 'CLUB') }, ['clientId', 'clientType', 'environmentId', 'allowedOrigins', 'redirectAllowlist']))
add('LoginClientUpdateRequest', obj({ status: en('ACTIVE', 'DISABLED'), allowedOrigins: origins, redirectAllowlist: redirects, expectedPolicyVersion: version, ...expected }))
add('PlatformUser', obj({ userId: id, displayName: name, email: nullable(str(3,254,{format:'email'})), status: en('ACTIVE', 'DISABLED'), version }))
add('PlatformUserPage', obj({ items: arr(ref('PlatformUser')), nextCursor: nullable(str(1, 2048)) }))
add('UserEmailRequest', obj({ email:str(3,254,{format:'email'}), ...expected, reason }))
add('UserStatusRequest', obj({ status: en('ACTIVE', 'DISABLED'), ...expected, reason }))
add('PlatformPermission', obj({ userId: id, capability: ref('PlatformCapability'), status: en('ACTIVE', 'REVOKED'), version }))
add('PlatformPermissionPage', obj({ items: arr(ref('PlatformPermission')), nextCursor: nullable(str(1, 2048)) }))
add('PlatformPermissionRequest', obj({ enabled: bool, expectedVersion: nullable(version), reason }))
add('SelfTenantCreateRequest', obj({ name }))
add('TenantCreationPolicyView', obj({ mode: en('SELF_SERVICE', 'PLATFORM_ONLY') }))
add('PlatformVersionRequest', obj({ ...expected, reason }))
add('RoleUpdateRequest', obj({ role: en('ADMIN', 'MEMBER'), ...expected }))
add(
  'InvitationTarget',
  union(
    obj({ kind: literal('EMAIL'), value: email }),
    obj({ kind: literal('PHONE'), value: phone }),
    obj({ kind: literal('USER'), value: id }),
  ),
)
add('InvitationCreateRequest', obj({ target: ref('InvitationTarget') }))
add(
  'Invitation',
  obj({
    invitationId: id,
    tenantId: id,
    targetSummary: str(1, 254),
    status: en('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'),
    expiresAt: time,
    version,
  }),
)
add('InvitationAcceptResult', obj({ invitation: ref('Invitation'), membership: ref('Membership') }))
add('TransferCreateRequest', obj({ targetMembershipId: id, ...expected }))
add(
  'OwnershipTransfer',
  obj({
    transferId: id,
    tenantId: id,
    fromMembershipId: id,
    toMembershipId: id,
    status: en('PENDING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'),
    expiresAt: time,
    version,
  }),
)
add(
  'TransferAcceptResult',
  obj({
    transfer: ref('OwnershipTransfer'),
    previousOwner: ref('Membership'),
    owner: ref('Membership'),
    tenantVersion: version,
  }),
)
add('Feature', obj({ featureId: id, product: en('WORK', 'CLUB', 'SHARED'), name }))
const featureIds = { ...arr(id, 1000), uniqueItems: true }
add('SeatType', obj({ seatTypeId: id, name, featureIds }))
add(
  'PlanVersion',
  obj({
    planId: id,
    planVersion,
    name,
    personalFeatureIds: featureIds,
    seatTypes: arr(ref('SeatType'), 100),
  }),
)
add(
  'FeatureCreateRequest',
  obj({ featureId: id, product: en('WORK', 'CLUB', 'SHARED'), name, reason }),
)
add(
  'PlanVersionCreateRequest',
  obj({
    planVersion,
    name,
    personalFeatureIds: featureIds,
    seatTypes: arr(ref('SeatType'), 100),
    reason,
  }),
)
add('SubscriptionOwner', obj({ kind: en('USER', 'TENANT'), id }))
add(
  'Subscription',
  obj({
    subscriptionId: id,
    owner: ref('SubscriptionOwner'),
    planId: id,
    planVersion,
    enabled: bool,
    startsAt: time,
    endsAt: time,
    version,
    status: en('SCHEDULED', 'ACTIVE', 'EXPIRED', 'DISABLED'),
  }),
)
add('SeatQuantities', {
  type: 'object',
  propertyNames: id,
  additionalProperties: num(0, 1000000),
  maxProperties: 100,
})
const subscriptionCreate = { planId: id, planVersion, startsAt: time, endsAt: time, reason }
add(
  'SubscriptionCreateRequest',
  union(
    obj({ ...subscriptionCreate, owner: obj({ kind: literal('USER'), id }) }),
    obj({
      ...subscriptionCreate,
      owner: obj({ kind: literal('TENANT'), id }),
      seatQuantities: ref('SeatQuantities'),
    }),
  ),
)
add('SubscriptionUpdateRequest', {
  ...obj(
    {
      plan: obj({ planId: id, planVersion }),
      startsAt: time,
      endsAt: time,
      enabled: bool,
      seatQuantities: ref('SeatQuantities'),
      ...expected,
      reason,
    },
    ['expectedVersion', 'reason'],
  ),
  anyOf: ['plan', 'startsAt', 'endsAt', 'enabled', 'seatQuantities'].map((key) => ({
    required: [key],
  })),
})
add('SubscriptionRenewRequest', obj({ endsAt: time, ...expected, reason }))
add(
  'SeatPool',
  obj({
    subscriptionId: id,
    tenantId: id,
    seatTypeId: id,
    quantity: num(0, 1000000),
    assignedCount: num(0, 1000000),
    availableCount: num(0, 1000000),
    version,
  }),
)
const assignmentBase = {
  assignmentId: id,
  subscriptionId: id,
  seatTypeId: id,
  membershipId: id,
  userId: id,
  assignedAt: time,
  version,
}
add(
  'Assignment',
  union(
    obj({
      ...assignmentBase,
      status: literal('ASSIGNED'),
      endedAt: literal(null),
      endReason: literal(null),
    }),
    obj({
      ...assignmentBase,
      status: literal('ENDED'),
      endedAt: time,
      endReason: en('RELEASED', 'REASSIGNED', 'MEMBER_LEFT', 'MEMBER_REMOVED'),
    }),
  ),
)
add('SeatAssignRequest', obj({ subscriptionId: id, seatTypeId: id, membershipId: id, ...expected }))
add('SeatReleaseRequest', obj({ ...expected, reason }, ['expectedVersion']))
add(
  'SeatReassignRequest',
  obj({ targetMembershipId: id, ...expected, reason }, ['targetMembershipId', 'expectedVersion']),
)
add(
  'SeatMutationResult',
  obj({ assignment: ref('Assignment'), pool: ref('SeatPool'), entitlementRevision: id }),
)
add(
  'SeatReassignResult',
  obj({
    endedAssignment: ref('Assignment'),
    assignment: ref('Assignment'),
    pool: ref('SeatPool'),
    entitlementRevision: id,
  }),
)
add(
  'AuditEvent',
  obj({
    auditEventId: id,
    actorUserId: id,
    operation: id,
    target: obj({ kind: id, id }),
    tenantId: nullable(id),
    occurredAt: time,
    result: en('SUCCEEDED', 'DENIED'),
    changes: arr(
      obj({ field: id, before: nullable(str(0, 1000)), after: nullable(str(0, 1000)) }),
      100,
    ),
  }),
)
add(
  'EntitlementSource',
  union(
    obj({ kind: literal('PERSONAL_SUBSCRIPTION'), subscriptionId: id }),
    obj({ kind: literal('TENANT_SEAT'), subscriptionId: id, seatTypeId: id, assignmentId: id }),
  ),
)
add(
  'EntitlementDecision',
  union(
    obj({
      featureId: id,
      allowed: literal(true),
      reason: literal('GRANTED'),
      validUntil: time,
      sources: arr(ref('EntitlementSource'), 1000, 1),
    }),
    obj({
      featureId: id,
      allowed: literal(false),
      reason: literal('FEATURE_NOT_GRANTED'),
      validUntil: time,
      sources: arr(ref('EntitlementSource'), 0),
    }),
  ),
)
add(
  'EntitlementCheckRequest',
  obj({ scope: ref('Scope'), featureIds: { ...arr(id, 100, 1), uniqueItems: true } }),
)
add(
  'EntitlementCheckResult',
  obj({
    scope: ref('Scope'),
    evaluatedAt: time,
    revision: id,
    decisions: arr(ref('EntitlementDecision'), 100, 1),
  }),
)
for (const item of [
  'LoginMethod',
  'TenantView',
  'PlatformTenantView',
  'Membership',
  'Invitation',
  'OwnershipTransfer',
  'Feature',
  'PlanVersion',
  'Subscription',
  'SeatPool',
  'Assignment',
  'AuditEvent',
]) {
  add(`${item}Page`, obj({ items: arr(ref(item)), nextCursor: nullable(str(1, 2048)) }))
}
add(
  'MyTenantsPage',
  obj({
    personalScope: obj({ kind: literal('PERSONAL') }),
    items: arr(ref('TenantView')),
    nextCursor: nullable(str(1, 2048)),
  }),
)

// Product-facing schemas contain handles only. Central proofs and tokens are deliberately impossible here.
add(
  'AccountView',
  union(
    obj({ state: en('ANONYMOUS', 'EXPIRED') }),
    obj({
      state: literal('AUTHENTICATED'),
      user: ref('UserView'),
      session: ref('SessionView'),
      capabilities: arr(ref('PlatformCapability'), 15),
    }),
    obj({ state: literal('OFFLINE_CACHED'), user: ref('UserView') }),
  ),
)
const returnTo = str(1, 2048, { format: 'local-path' })
const productTxn = { returnTo }
const productVariants: Schema[] = []
for (const method of methods)
  productVariants.push(
    obj({ ...productTxn, purpose: literal('LOGIN'), method: literal(method) }, [
      'purpose',
      'method',
    ]),
  )
for (const purpose of ['EMAIL_SIGNUP', 'PASSWORD_RESET'])
  productVariants.push(
    obj({ ...productTxn, purpose: literal(purpose), method: literal('EMAIL_CODE') }, [
      'purpose',
      'method',
    ]),
  )
for (const method of identityMethods) {
  productVariants.push(
    obj({ ...productTxn, purpose: literal('BIND'), method: literal(method), reauthHandle: id }, [
      'purpose',
      'method',
      'reauthHandle',
    ]),
  )
  productVariants.push(
    obj(
      {
        ...productTxn,
        purpose: literal('REPLACE'),
        method: literal(method),
        reauthHandle: id,
        bindingId: id,
      },
      ['purpose', 'method', 'reauthHandle', 'bindingId'],
    ),
  )
}
add('ProductTransactionRequest', union(...productVariants))
add(
  'ProductReauthenticationRequest',
  union(
    ...methods.flatMap((method) => operations.map((op) => obj({ method: literal(method), ...op, useSession: bool }, ["method", ...Object.keys(op)]))),
  ),
)
add(
  'ProductTransactionView',
  union(
    obj({
      handle: id,
      status: literal('PENDING'),
      nextStep: en(
        'REQUEST_CHALLENGE',
        'VERIFY_CHALLENGE',
        'PASSWORD_LOGIN',
        'EMAIL_SIGNUP',
        'PHONE_LOGIN',
        'START_PROVIDER',
        'WAIT_PROVIDER',
      ),
      expiresAt: time,
    }),
    obj({
      handle: id,
      status: literal('VERIFIED'),
      nextStep: literal('COMPLETE'),
      expiresAt: time,
    }),
    obj({
      handle: id,
      status: en('CONSUMED', 'CANCELLED', 'EXPIRED'),
      nextStep: literal('NONE'),
      expiresAt: time,
    }),
  ),
)
add(
  'ProductSubmitRequest',
  union(
    obj({ step: literal('REQUEST_CHALLENGE'), address: union(email, phone) }),
    obj({
      step: literal('VERIFY_CHALLENGE'),
      challengeHandle: id,
      credential: str(6, 6, { pattern: '^[0-9]{6}$' }),
    }),
    obj({ step: literal('PASSWORD_LOGIN'), email, password }),
    obj({ step: literal('EMAIL_SIGNUP'), email, password: newPassword }),
    ...['PHONE_LOGIN', 'START_PROVIDER', 'COMPLETE'].map((step) => obj({ step: literal(step) })),
  ),
)
add(
  'ProductSubmitResult',
  union(
    ref('ProductTransactionView'),
    obj({
      challengeHandle: id,
      expiresAt: time,
      retryAfterSeconds: num(0, 3600),
      nextStep: literal('VERIFY_CHALLENGE'),
    }),
    obj({ browserStartUrl: url }),
    obj({ account: ref('AccountView') }),
    obj({ operationReady: literal(true) }),
  ),
)
add(
  'ProductCallbackQuery',
  obj({ transactionId: id, state: str(16, 512), result: en('VERIFIED', 'CANCELLED', 'FAILED') }),
)
add(
  'ProductCallbackResult',
  union(
    obj({ account: ref('AccountView') }),
    obj({ operationReady: literal(true) }),
    obj({ status: en('CANCELLED', 'FAILED') }),
  ),
)
add('ProductLogoutRequest', obj({ scope: en('CURRENT_LOGIN', 'ALL_MOLIS_PRODUCTS') }))
add(
  'ProductLogoutResult',
  obj({ localCleared: literal(true), remoteRevocation: en('CONFIRMED', 'UNCONFIRMED') }),
)
add('ProductBindRequest', obj({ reauthHandle: id, identityHandle: id, ...expected }))
add('ProductUnlinkRequest', obj({ reauthHandle: id, ...expected }))
add('ProductPasswordChangeRequest', obj({ reauthHandle: id, newPassword, ...expected }))
add('ProductPasswordResetRequest', obj({ resetHandle: id, newPassword }))

// These are internal ports/configuration, not public HTTP endpoints.
add(
  'DeliveryTemplate',
  en(
    'EMAIL_SIGNUP',
    'BIND_EMAIL',
    'REPLACE_EMAIL',
    'PASSWORD_RESET',
    'PHONE_LOGIN',
    'PHONE_REAUTH',
    'BIND_PHONE',
    'REPLACE_PHONE',
  ),
)
const delivery = {
  deliveryId: id,
  templateKey: ref('DeliveryTemplate'),
  templateData: obj({ credential: str(6, 6, { pattern: '^[0-9]{6}$' }) }),
  expiresAt: time,
}
add(
  'SmsDelivery',
  obj({
    ...delivery,
    toE164: phone,
    templateKey: en('PHONE_LOGIN', 'PHONE_REAUTH', 'BIND_PHONE', 'REPLACE_PHONE'),
  }),
)
add(
  'MailDelivery',
  obj({
    ...delivery,
    to: email,
    templateKey: en('EMAIL_SIGNUP', 'BIND_EMAIL', 'REPLACE_EMAIL', 'PASSWORD_RESET'),
  }),
)
add(
  'DeliveryResult',
  union(
    obj({ status: literal('ACCEPTED'), providerMessageId: id }),
    obj({ status: literal('FAILED'), code: en('REJECTED', 'UNAVAILABLE') }),
    obj({ status: literal('UNKNOWN'), code: literal('TIMEOUT') }),
  ),
)
add(
  'ProviderIdentity',
  obj(
    {
      issuer: url,
      subject: str(1, 255),
      email,
      emailVerified: bool,
      profile: obj({ displayName: name }, []),
    },
    ['issuer', 'subject'],
  ),
)
add(
  'ProviderServerContext',
  obj({
    transactionId: id,
    provider: en('GOOGLE', 'GITHUB'),
    providerState: secret,
    browserBindingDigest: challenge,
    providerNonceDigest: challenge,
    providerCodeChallenge: challenge,
    providerCodeVerifierRef: id,
    callbackUri: url,
    environmentId: id,
    expiresAt: time,
  }),
)
add(
  'ProviderCallback',
  union(
    obj({ state: secret, code: str(1, 4096) }),
    obj({ state: secret, error: en('access_denied', 'temporarily_unavailable', 'server_error') }),
  ),
)
const environmentBase = {
  environmentId: id,
  authOrigin: str(1, 2048, { format: 'http-origin' }),
  productOrigin: str(1, 2048, { format: 'http-origin' }),
  clientId: id,
  policyProfile: literal('unified-account-v2'),
  redirectAllowlist: { ...arr(url, 32, 1), uniqueItems: true },
}
add(
  'ClientEnvironmentConfig',
  union(
    obj({
      ...environmentBase,
      environmentKind: en('LOCAL', 'TEST'),
      deliveryMode: en('MOCK', 'LIVE'),
      providerMode: en('MOCK', 'LIVE'),
    }),
    obj({
      ...environmentBase,
      environmentKind: literal('PRODUCTION'),
      deliveryMode: literal('LIVE'),
      providerMode: literal('LIVE'),
    }),
  ),
)
add(
  'EnvironmentConfig',
  union(
    obj({
      environmentId: id,
      kind: en('LOCAL', 'TEST'),
      authOrigin: str(1, 2048, { format: 'http-origin' }),
      deliveryMode: en('MOCK', 'LIVE'),
      providerMode: en('MOCK', 'LIVE'),
    }),
    obj({
      environmentId: id,
      kind: literal('PRODUCTION'),
      authOrigin: str(1, 2048, { format: 'http-origin' }),
      deliveryMode: literal('LIVE'),
      providerMode: literal('LIVE'),
    }),
  ),
)
add(
  'MigrationMapping',
  obj({
    issuer: url,
    authUserId: id,
    product: en('WORK', 'CLUB'),
    localUserId: id,
    evidence: en('VERIFIED_EXISTING_LINK', 'VERIFIED_CREDENTIAL', 'REVIEWED_OWNER_PROOF'),
    status: en('PENDING', 'VERIFIED', 'CONFLICT'),
    version,
  }),
)
add(
  'MigrationInventoryRecord',
  obj({
    product: en('AUTH', 'WORK', 'CLUB'),
    sourceRecordId: id,
    kind: en(
      'USER',
      'EMAIL',
      'PHONE',
      'EXTERNAL_IDENTITY',
      'PASSWORD_FORMAT',
      'TEAM',
      'BUSINESS_REFERENCE',
    ),
    disposition: en('PRESERVE', 'MAP', 'REVIEW_REQUIRED'),
    verificationPreserved: bool,
    evidenceReference: id,
  }),
)

const errorCodes: Record<string, string[]> = {
  '400': ['INVALID_REQUEST', 'INVALID_SCOPE', 'FEATURE_UNKNOWN'],
  '401': [
    'LOGIN_REQUIRED',
    'SESSION_EXPIRED',
    'SESSION_REVOKED',
    'INVALID_CREDENTIALS',
    'INVALID_GRANT',
  ],
  '403': [
    'FORBIDDEN',
    'POLICY_MISMATCH',
    'TENANT_DISABLED',
    'REAUTH_REQUIRED',
    'CLIENT_POLICY_REQUIRES_V2',
    'TENANT_API_REQUIRED',
  ],
  '404': ['NOT_FOUND'],
  '409': [
    'VERSION_CONFLICT',
    'CAPACITY_CONFLICT',
    'IDENTITY_IN_USE',
    'LAST_LOGIN_METHOD',
    'OWNER_TRANSFER_REQUIRED',
    'PROOF_CONSUMED',
    'TRANSACTION_EXPIRED',
    'IDEMPOTENCY_CONFLICT',
  ],
  '429': ['RATE_LIMITED'],
  '501': ['UNIFIED_ACCOUNT_NOT_IMPLEMENTED'],
  '503': ['UPSTREAM_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'UNIFIED_CONFIGURATION_INVALID'],
}
for (const [status, codes] of Object.entries(errorCodes)) {
  add(
    `Error${status}`,
    obj({
      requestId: id,
      error: obj(
        {
          code: en(...codes),
          fields: arr(
            obj({
              field: id,
              reason: en('REQUIRED', 'INVALID', 'TOO_LONG', 'OUT_OF_RANGE', 'UNKNOWN_FIELD'),
            }),
            20,
          ),
          retryAfterSeconds: num(0, 86400),
        },
        status === '429' ? ['code', 'retryAfterSeconds'] : ['code'],
      ),
    }),
  )
}
add('ErrorResponse', union(...Object.keys(errorCodes).map((status) => ref(`Error${status}`))))

type Endpoint = {
  group: string
  method: string
  path: string
  operationId: string
  input?: string
  output: string
  auth: string
  idempotent?: boolean
  query?: string
}
const endpoints: Endpoint[] = []
const ep = (
  group: string,
  method: string,
  path: string,
  operationId: string,
  input: string | undefined,
  output: string,
  auth = 'session',
  idempotent = false,
  query?: string,
) => endpoints.push({ group, method, path, operationId, input, output, auth, idempotent, query })
ep(
  'API-02',
  'post',
  '/auth/transactions',
  'createTransaction',
  'CreateTransactionRequest',
  'TransactionCreated',
  'transaction-create',
)
ep(
  'API-02',
  'get',
  '/auth/transactions/{transactionId}',
  'getTransaction',
  undefined,
  'TransactionView',
  'initiator',
)
ep(
  'API-02',
  'post',
  '/auth/transactions/{transactionId}/challenges',
  'createChallenge',
  'ChallengeRequest',
  'ChallengeCreated',
  'initiator',
)
ep(
  'API-02',
  'post',
  '/auth/transactions/{transactionId}/challenges/{challengeId}/verify',
  'verifyChallenge',
  'VerifyChallengeRequest',
  'VerificationResult',
  'initiator',
)
for (const [suffix, operationId, input, output] of [
  ['password', 'verifyPassword', 'PasswordLoginRequest', 'VerifiedResult'],
  ['email-signup', 'signUpEmail', 'EmailSignupRequest', 'VerifiedResult'],
  ['phone', 'signInPhone', 'PhoneLoginRequest', 'VerifiedResult'],
  ['complete', 'completeTransaction', 'Empty', 'TransactionCompleteResult'],
  ['cancel', 'cancelTransaction', 'Empty', 'TransactionCancelResult'],
])
  ep(
    'API-02',
    'post',
    `/auth/transactions/{transactionId}/${suffix}`,
    operationId,
    input,
    output,
    'initiator',
  )
for (const provider of ['google', 'github'])
  ep(
    'API-02',
    'post',
    `/auth/transactions/{transactionId}/providers/${provider}/start`,
    `start${provider === 'google' ? 'Google' : 'GitHub'}`,
    'Empty',
    'ProviderStartResult',
    'initiator',
  )
ep('API-02', 'post', '/auth/token', 'exchangeToken', 'TokenRequest', 'TokenSet', 'grant')
ep('API-03', 'get', '/users/me', 'getMe', undefined, 'MeView')
ep(
  'API-03',
  'patch',
  '/users/me/profile',
  'updateProfile',
  'ProfileUpdateRequest',
  'UserView',
  'session',
  true,
)
ep('API-03', 'get', '/users/me/login-methods', 'listLoginMethods', undefined, 'LoginMethodsView')
ep(
  'API-03',
  'post',
  '/users/me/reauthentications',
  'createReauthentication',
  'ReauthenticationRequest',
  'TransactionCreated',
)
for (const [path, operationId, input] of [
  ['bind', 'bindMethod', 'BindMethodRequest'],
  ['{bindingId}/replace', 'replaceMethod', 'BindMethodRequest'],
  ['{bindingId}/unlink', 'unlinkMethod', 'UnlinkMethodRequest'],
])
  ep(
    'API-03',
    'post',
    `/users/me/login-methods/${path}`,
    operationId,
    input,
    'LoginMethodsView',
    'session',
    true,
  )
ep(
  'API-03',
  'post',
  '/users/me/password/change',
  'changePassword',
  'PasswordChangeRequest',
  'PasswordChangeResult',
  'session',
  true,
)
ep(
  'API-03',
  'post',
  '/auth/password-reset/complete',
  'resetPassword',
  'PasswordResetRequest',
  'PasswordResetResult',
  'initiator',
)
ep('API-04', 'get', '/sessions/current', 'getCurrentSession', undefined, 'SessionView')
ep(
  'API-04',
  'post',
  '/sessions/current/activity',
  'recordActivity',
  'ActivityRequest',
  'SessionView',
)
ep(
  'API-04',
  'post',
  '/sessions/current/logout',
  'logoutCurrent',
  'LogoutRequest',
  'CurrentLogoutResult',
  'revoke',
  true,
)
ep(
  'API-04',
  'post',
  '/sessions/logout-all',
  'logoutAll',
  'LogoutRequest',
  'GlobalLogoutResult',
  'revoke',
  true,
)
for (const [method, path, operation, input, output, permission] of [
  ['get', '/platform/users', 'listPlatformUsers', undefined, 'PlatformUserPage', 'USER_READ'],
  ['get', '/platform/users/{userId}', 'getPlatformUser', undefined, 'PlatformUser', 'USER_READ'],
  ['patch', '/platform/users/{userId}/email', 'setPlatformUserEmail', 'UserEmailRequest', 'PlatformUser', 'USER_EMAIL_WRITE'],
  ['patch', '/platform/users/{userId}/status', 'setPlatformUserStatus', 'UserStatusRequest', 'PlatformUser', 'USER_STATUS'],
  ['get', '/platform/users/{userId}/permissions', 'listPlatformPermissions', undefined, 'PlatformPermissionPage', 'PLATFORM_PERMISSION_WRITE'],
  ['patch', '/platform/users/{userId}/permissions/{capability}', 'setPlatformPermission', 'PlatformPermissionRequest', 'PlatformPermission', 'PLATFORM_PERMISSION_WRITE'],
  ['get', '/platform/applications', 'listApplications', undefined, 'PlatformApplicationPage', 'APPLICATION_READ'],
  ['get', '/platform/applications/{applicationId}', 'getApplication', undefined, 'PlatformApplication', 'APPLICATION_READ'],
  ['post', '/platform/applications', 'createApplication', 'ApplicationCreateRequest', 'PlatformApplication', 'APPLICATION_WRITE'],
  ['patch', '/platform/applications/{applicationId}', 'updateApplication', 'ApplicationUpdateRequest', 'PlatformApplication', 'APPLICATION_WRITE'],
  ['get', '/platform/applications/{applicationId}/clients', 'listLoginClients', undefined, 'PlatformLoginClientPage', 'CLIENT_READ'],
  ['post', '/platform/applications/{applicationId}/clients', 'createLoginClient', 'LoginClientCreateRequest', 'PlatformLoginClient', 'CLIENT_WRITE'],
  ['get', '/platform/clients/{clientId}', 'getLoginClient', undefined, 'PlatformLoginClient', 'CLIENT_READ'],
  ['patch', '/platform/clients/{clientId}', 'updateLoginClient', 'LoginClientUpdateRequest', 'PlatformLoginClient', 'CLIENT_WRITE'],
] as const) ep('API-10', method, path, operation, input, output, 'platform:' + permission, method !== 'get')
ep('API-05', 'get', '/tenants', 'listMyTenants', undefined, 'MyTenantsPage')
ep('API-05', 'get', '/tenant-creation-policy', 'getTenantCreationPolicy', undefined, 'TenantCreationPolicyView')
ep('API-05', 'post', '/tenants', 'createMyTenant', 'SelfTenantCreateRequest', 'TenantView', 'session', true)
ep('API-05', 'get', '/tenants/{tenantId}', 'getTenant', undefined, 'TenantView')
ep(
  'API-05',
  'patch',
  '/tenants/{tenantId}',
  'updateTenant',
  'TenantUpdateRequest',
  'TenantView',
  'tenant-manager',
  true,
)
ep(
  'API-05',
  'post',
  '/platform/tenants',
  'createTenant',
  'TenantCreateRequest',
  'PlatformTenantView',
  'platform:TENANT_CREATE',
  true,
)
ep(
  'API-05',
  'get',
  '/platform/tenants',
  'listPlatformTenants',
  undefined,
  'PlatformTenantViewPage',
  'platform:TENANT_READ',
)
ep(
  'API-05',
  'get',
  '/platform/tenants/{tenantId}',
  'getPlatformTenant',
  undefined,
  'PlatformTenantView',
  'platform:TENANT_READ',
)
for (const action of ['disable', 'enable'])
  ep(
    'API-05',
    'post',
    `/platform/tenants/{tenantId}/${action}`,
    `${action}Tenant`,
    'PlatformVersionRequest',
    'PlatformTenantView',
    'platform:TENANT_STATUS',
    true,
  )
ep('API-05', 'get', '/tenants/{tenantId}/members', 'listMembers', undefined, 'MembershipPage')
ep(
  'API-05',
  'patch',
  '/tenants/{tenantId}/members/{membershipId}/role',
  'updateMemberRole',
  'RoleUpdateRequest',
  'Membership',
  'tenant-owner',
  true,
)
ep(
  'API-05',
  'post',
  '/tenants/{tenantId}/members/{membershipId}/remove',
  'removeMember',
  'ExpectedVersionRequest',
  'Membership',
  'tenant-manager',
  true,
)
ep(
  'API-05',
  'post',
  '/tenants/{tenantId}/leave',
  'leaveTenant',
  'ExpectedVersionRequest',
  'Membership',
  'session',
  true,
)
ep(
  'API-05',
  'post',
  '/tenants/{tenantId}/invitations',
  'createInvitation',
  'InvitationCreateRequest',
  'Invitation',
  'tenant-manager',
  true,
)
ep(
  'API-05',
  'get',
  '/tenants/{tenantId}/invitations',
  'listTenantInvitations',
  undefined,
  'InvitationPage',
  'tenant-manager',
)
ep(
  'API-05',
  'post',
  '/tenants/{tenantId}/invitations/{invitationId}/revoke',
  'revokeInvitation',
  'ExpectedVersionRequest',
  'Invitation',
  'tenant-manager',
  true,
)
ep('API-05', 'get', '/invitations', 'listMyInvitations', undefined, 'InvitationPage')
for (const action of ['accept', 'decline'])
  ep(
    'API-05',
    'post',
    `/invitations/{invitationId}/${action}`,
    `${action}Invitation`,
    'ExpectedVersionRequest',
    action === 'accept' ? 'InvitationAcceptResult' : 'Invitation',
    'invitation-target',
    true,
  )
ep(
  'API-05',
  'post',
  '/tenants/{tenantId}/ownership-transfers',
  'createOwnershipTransfer',
  'TransferCreateRequest',
  'OwnershipTransfer',
  'tenant-owner',
  true,
)
ep(
  'API-05',
  'get',
  '/ownership-transfers',
  'listOwnershipTransfers',
  undefined,
  'OwnershipTransferPage',
)
ep(
  'API-05',
  'post',
  '/ownership-transfers/{transferId}/accept',
  'acceptOwnershipTransfer',
  'ExpectedVersionRequest',
  'TransferAcceptResult',
  'transfer-target',
  true,
)
ep(
  'API-05',
  'post',
  '/ownership-transfers/{transferId}/cancel',
  'cancelOwnershipTransfer',
  'ExpectedVersionRequest',
  'OwnershipTransfer',
  'transfer-owner',
  true,
)
for (const [path, operationId, output] of [
  ['plans', 'listPlans', 'PlanVersionPage'],
  ['features', 'listFeatures', 'FeaturePage'],
])
  ep('API-06', 'get', `/catalog/${path}`, operationId, undefined, output)
ep(
  'API-06',
  'post',
  '/platform/catalog/features',
  'createFeature',
  'FeatureCreateRequest',
  'Feature',
  'platform:CATALOG_WRITE',
  true,
)
ep(
  'API-06',
  'post',
  '/platform/catalog/plans/{planId}/versions',
  'publishPlanVersion',
  'PlanVersionCreateRequest',
  'PlanVersion',
  'platform:CATALOG_WRITE',
  true,
)
ep(
  'API-06',
  'get',
  '/users/me/subscriptions',
  'listPersonalSubscriptions',
  undefined,
  'SubscriptionPage',
)
ep(
  'API-06',
  'get',
  '/tenants/{tenantId}/subscriptions',
  'listTenantSubscriptions',
  undefined,
  'SubscriptionPage',
)
ep(
  'API-06',
  'get',
  '/tenants/{tenantId}/seat-pools',
  'listSeatPools',
  undefined,
  'SeatPoolPage',
  'tenant-manager',
)
ep(
  'API-06',
  'get',
  '/tenants/{tenantId}/seat-assignments',
  'listSeatAssignments',
  undefined,
  'AssignmentPage',
  'session',
  false,
  'assignment-state',
)
ep(
  'API-06',
  'post',
  '/platform/subscriptions',
  'createSubscription',
  'SubscriptionCreateRequest',
  'Subscription',
  'platform:SUBSCRIPTION_WRITE',
  true,
)
ep(
  'API-06',
  'get',
  '/platform/subscriptions',
  'listPlatformSubscriptions',
  undefined,
  'SubscriptionPage',
  'platform:SUBSCRIPTION_READ',
)
ep(
  'API-06',
  'get',
  '/platform/subscriptions/{subscriptionId}',
  'getPlatformSubscription',
  undefined,
  'Subscription',
  'platform:SUBSCRIPTION_READ',
)
ep(
  'API-06',
  'get',
  '/platform/subscriptions/{subscriptionId}/seat-pools',
  'listPlatformSeatPools',
  undefined,
  'SeatPoolPage',
  'platform:SUBSCRIPTION_READ',
)
ep(
  'API-06',
  'patch',
  '/platform/subscriptions/{subscriptionId}',
  'updateSubscription',
  'SubscriptionUpdateRequest',
  'Subscription',
  'platform:SUBSCRIPTION_WRITE',
  true,
)
ep(
  'API-06',
  'post',
  '/platform/subscriptions/{subscriptionId}/renew',
  'renewSubscription',
  'SubscriptionRenewRequest',
  'Subscription',
  'platform:SUBSCRIPTION_WRITE',
  true,
)
ep(
  'API-06',
  'post',
  '/tenants/{tenantId}/seat-assignments',
  'assignSeat',
  'SeatAssignRequest',
  'SeatMutationResult',
  'tenant-manager',
  true,
)
ep(
  'API-06',
  'post',
  '/tenants/{tenantId}/seat-assignments/{assignmentId}/release',
  'releaseSeat',
  'SeatReleaseRequest',
  'SeatMutationResult',
  'tenant-manager',
  true,
)
ep(
  'API-06',
  'post',
  '/tenants/{tenantId}/seat-assignments/{assignmentId}/reassign',
  'reassignSeat',
  'SeatReassignRequest',
  'SeatReassignResult',
  'tenant-manager',
  true,
)
ep(
  'API-06',
  'get',
  '/tenants/{tenantId}/audit-events',
  'listTenantAudit',
  undefined,
  'AuditEventPage',
  'tenant-manager',
)
ep(
  'API-06',
  'get',
  '/platform/audit-events',
  'listPlatformAudit',
  undefined,
  'AuditEventPage',
  'platform:AUDIT_READ',
)
ep(
  'API-07',
  'post',
  '/entitlements/check',
  'checkEntitlements',
  'EntitlementCheckRequest',
  'EntitlementCheckResult',
)

ep('API-08', 'get', '/api/account/session', 'productSession', undefined, 'AccountView', 'product')
ep(
  'API-08',
  'post',
  '/api/account/auth/transactions',
  'productCreateTransaction',
  'ProductTransactionRequest',
  'ProductTransactionView',
  'product',
)
ep(
  'API-08',
  'post',
  '/api/account/reauthentications',
  'productCreateReauthentication',
  'ProductReauthenticationRequest',
  'ProductTransactionView',
  'product',
)
ep(
  'API-08',
  'get',
  '/api/account/auth/transactions/{handle}',
  'productGetTransaction',
  undefined,
  'ProductTransactionView',
  'product',
)
ep(
  'API-08',
  'post',
  '/api/account/auth/transactions/{handle}/submit',
  'productSubmit',
  'ProductSubmitRequest',
  'ProductSubmitResult',
  'product',
)
for (const action of ['resend', 'cancel'])
  ep(
    'API-08',
    'post',
    `/api/account/auth/transactions/{handle}/${action}`,
    `product${action === 'resend' ? 'Resend' : 'Cancel'}`,
    'Empty',
    'ProductTransactionView',
    'product',
  )
ep(
  'API-08',
  'get',
  '/api/account/auth/callback',
  'productCallback',
  undefined,
  'ProductCallbackResult',
  'product-callback',
  false,
  'callback',
)
ep(
  'API-08',
  'post',
  '/api/account/activity',
  'productActivity',
  'ActivityRequest',
  'SessionView',
  'product',
)
ep(
  'API-08',
  'post',
  '/api/account/logout',
  'productLogout',
  'ProductLogoutRequest',
  'ProductLogoutResult',
  'product',
  true,
)
ep(
  'API-08',
  'patch',
  '/api/account/profile',
  'productUpdateProfile',
  'ProfileUpdateRequest',
  'UserView',
  'product',
  true,
)
ep(
  'API-08',
  'get',
  '/api/account/login-methods',
  'productListLoginMethods',
  undefined,
  'LoginMethodsView',
  'product',
)
for (const [path, operationId, input] of [
  ['bind', 'productBindMethod', 'ProductBindRequest'],
  ['{bindingId}/replace', 'productReplaceMethod', 'ProductBindRequest'],
  ['{bindingId}/unlink', 'productUnlinkMethod', 'ProductUnlinkRequest'],
])
  ep(
    'API-08',
    'post',
    `/api/account/login-methods/${path}`,
    operationId,
    input,
    'LoginMethodsView',
    'product',
    true,
  )
ep(
  'API-08',
  'post',
  '/api/account/password/change',
  'productChangePassword',
  'ProductPasswordChangeRequest',
  'PasswordChangeResult',
  'product',
  true,
)
ep(
  'API-08',
  'post',
  '/api/account/password/reset',
  'productResetPassword',
  'ProductPasswordResetRequest',
  'PasswordResetResult',
  'product',
)
// Fixed non-secret mappings are copied by identifier, not implemented as a wildcard proxy.
for (const central of [...endpoints].filter((e) =>
  ['API-05', 'API-06', 'API-07', 'API-10'].includes(e.group),
)) {
  const path = central.path === '/users/me/subscriptions' ? '/subscriptions' : central.path
  ep(
    'API-08',
    central.method,
    `/api/account${path}`,
    `product_${central.operationId}`,
    central.input,
    central.output,
    'product',
    central.idempotent,
    central.query,
  )
}

const policy = {
  contractVersion: '1.2.0',
  implementationStatus: 'CONTRACT_ONLY',
  policyProfile: 'unified-account-v2',
  defaults: {
    transactionTtlSeconds: 600,
    challengeTtlSeconds: 300,
    challengeMaxWrongAttempts: 5,
    challengeResendSeconds: 60,
    loginCodeTtlSeconds: 60,
    proofTtlSeconds: 300,
    invitationTtlSeconds: 604800,
    transferTtlSeconds: 86400,
    idempotencyTtlSeconds: 86400,
    loginIdleSeconds: 2592000,
    loginAbsoluteSeconds: 7776000,
    accessTokenTtlSeconds: 900,
    passwordMinNormalizedCodePoints: 8,
    passwordMaxNormalizedCodePoints: 128,
    passwordMaxRawUtf16Units: 512,
    pageDefault: 20,
    pageMax: 100,
    entitlementFeatureMax: 100,
    sendQuotaWindowSeconds: 3600,
    sendQuotaPerIp: 60,
    sendQuotaPerTarget: 10,
    sendQuotaPerClient: 1000,
  },
  errors: errorCodes,
  permissions: endpoints.map((e) => ({
    operationId: e.operationId,
    authority: e.auth,
    idempotency: e.idempotent ? 'REQUIRED' : 'NOT_APPLICABLE',
    inputSchema: e.input ?? null,
    outputSchema: e.output,
  })),
  stateMachines: {
    transaction: {
      initial: 'PENDING',
      transitions: [
        ['PENDING', 'VERIFIED'],
        ['PENDING', 'CANCELLED'],
        ['PENDING', 'EXPIRED'],
        ['VERIFIED', 'CONSUMED'],
        ['VERIFIED', 'CANCELLED'],
        ['VERIFIED', 'EXPIRED'],
      ],
      terminal: ['CONSUMED', 'CANCELLED', 'EXPIRED'],
    },
    challenge: {
      initial: 'ISSUED',
      transitions: [
        ['ISSUED', 'VERIFIED'],
        ['ISSUED', 'LOCKED'],
        ['ISSUED', 'EXPIRED'],
        ['ISSUED', 'SUPERSEDED'],
      ],
      terminal: ['VERIFIED', 'LOCKED', 'EXPIRED', 'SUPERSEDED'],
    },
    proof: {
      initial: 'ISSUED',
      transitions: [
        ['ISSUED', 'CONSUMED'],
        ['ISSUED', 'REVOKED'],
        ['ISSUED', 'EXPIRED'],
      ],
      terminal: ['CONSUMED', 'REVOKED', 'EXPIRED'],
    },
    invitation: {
      initial: 'PENDING',
      transitions: ['ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'].map((s) => ['PENDING', s]),
      terminal: ['ACCEPTED', 'DECLINED', 'REVOKED', 'EXPIRED'],
    },
    transfer: {
      initial: 'PENDING',
      transitions: ['ACCEPTED', 'CANCELLED', 'EXPIRED'].map((s) => ['PENDING', s]),
      terminal: ['ACCEPTED', 'CANCELLED', 'EXPIRED'],
    },
    membership: {
      initial: 'ACTIVE',
      transitions: [
        ['ACTIVE', 'LEFT'],
        ['ACTIVE', 'REMOVED'],
      ],
      terminal: ['LEFT', 'REMOVED'],
      rejoin: 'NEW_MEMBERSHIP_ID',
    },
    assignment: {
      initial: 'ASSIGNED',
      transitions: [['ASSIGNED', 'ENDED']],
      terminal: ['ENDED'],
      expiration: 'RETAIN_ASSIGNED',
      reassign: 'END_OLD_CREATE_NEW_ATOMICALLY',
    },
    session: {
      initial: 'ACTIVE',
      transitions: [
        ['ACTIVE', 'REVOKED'],
        ['ACTIVE', 'EXPIRED'],
      ],
      terminal: ['REVOKED', 'EXPIRED'],
    },
  },
  authenticationFlows: [
    {
      purpose: 'LOGIN',
      methods: ['EMAIL_PASSWORD'],
      verification: 'PASSWORD',
      verifiedBy: 'password',
      completion: 'LOGIN_CODE',
      createsUser: false,
    },
    {
      purpose: 'LOGIN',
      methods: ['PHONE_OTP'],
      verification: 'CHALLENGE_THEN_PHONE',
      verifiedBy: 'phone',
      completion: 'LOGIN_CODE',
      createsUser: true,
    },
    {
      purpose: 'LOGIN',
      methods: ['GOOGLE', 'GITHUB'],
      verification: 'PROVIDER_CALLBACK',
      verifiedBy: 'provider-callback',
      completion: 'LOGIN_CODE',
      createsUser: true,
    },
    {
      purpose: 'EMAIL_SIGNUP',
      methods: ['EMAIL_CODE'],
      verification: 'CHALLENGE_THEN_SIGNUP',
      verifiedBy: 'email-signup',
      completion: 'LOGIN_CODE',
      createsUser: true,
    },
    {
      purpose: 'REAUTH',
      methods,
      verification: 'EXISTING_USABLE_IDENTITY',
      verifiedBy: 'password/challenge/provider-callback',
      completion: 'OPERATION_PROOF',
      createsUser: false,
    },
    {
      purpose: 'BIND',
      methods: identityMethods,
      verification: 'NEW_IDENTITY_ONLY',
      verifiedBy: 'challenge/provider-callback',
      completion: 'NEW_IDENTITY_PROOF',
      createsUser: false,
    },
    {
      purpose: 'REPLACE',
      methods: identityMethods,
      verification: 'NEW_IDENTITY_ONLY',
      verifiedBy: 'challenge/provider-callback',
      completion: 'NEW_IDENTITY_PROOF',
      createsUser: false,
    },
    {
      purpose: 'PASSWORD_RESET',
      methods: ['EMAIL_CODE'],
      verification: 'EXISTING_VERIFIED_EMAIL',
      verifiedBy: 'challenge',
      completion: 'RESET_PROOF',
      createsUser: false,
    },
  ],
  roleRules: {
    tenantCreation: {
      configuration: 'TENANT_CREATION_POLICY',
      default: 'SELF_SERVICE',
      modes: ['SELF_SERVICE', 'PLATFORM_ONLY'],
      selfServiceOwner: 'CURRENT_AUTHENTICATED_USER',
      platformCreation: 'TENANT_CREATE',
      changesExistingMembership: false,
    },
    tenantDisabled: 'DENY_MEMBER_READ_AND_WRITE_EXCEPT_MINIMAL_MY_TENANTS',
    platformAuthority: 'INDEPENDENT_OF_TENANT_ROLE',
    OWNER: [
      'PROFILE_WRITE',
      'MEMBERS_READ',
      'INVITE',
      'REMOVE_NON_OWNER',
      'APPOINT_ADMIN',
      'TRANSFER_OWNER',
      'SEAT_MANAGE',
      'AUDIT_READ',
    ],
    ADMIN: [
      'PROFILE_WRITE',
      'MEMBERS_READ',
      'INVITE',
      'REMOVE_MEMBER',
      'LEAVE',
      'SEAT_MANAGE',
      'AUDIT_READ',
    ],
    MEMBER: [
      'MEMBERS_READ',
      'LEAVE',
      'OWN_ASSIGNMENTS_READ',
      'TENANT_SUBSCRIPTIONS_READ',
      'SHARED_CONTENT_READ_DOWNLOAD',
    ],
    transferAccepted: {
      targetRole: 'OWNER',
      previousOwnerRole: 'MEMBER',
      existingAssignments: 'PRESERVE',
      uniqueOwner: true,
    },
  },
  proofBindings: {
    verificationProof: [
      'transactionId',
      'normalizedTarget',
      'purpose',
      'currentSubjectIfKnown',
      'expiry',
      'oneUse',
    ],
    operationProof: [
      'userId',
      'loginSessionId',
      'operation',
      'target',
      'identityRevision',
      'sessionRevision',
      'revocationBoundary',
      'expiry',
      'oneUse',
    ],
    newIdentityProof: [
      'userId',
      'loginSessionId',
      'transactionId',
      'purpose',
      'method',
      'normalizedIdentity',
      'bindingIdForReplace',
      'identityRevision',
      'sessionRevision',
      'expiry',
      'oneUse',
    ],
    resetProof: [
      'transactionId',
      'userId',
      'verifiedEmailBinding',
      'identityRevision',
      'revocationBoundary',
      'expiry',
      'oneUse',
    ],
    loginCode: [
      'clientId',
      'redirectUri',
      'codeChallenge',
      'userId',
      'transactionCreationSequence',
      'revocationBoundary',
      'purpose',
      'expiry',
      'oneUse',
    ],
  },
  atomicConstraints: [
    'PASSWORD_CHANGE_AND_REVOKE_OTHERS_KEEP_TRUSTED_CURRENT_SESSION',
    'PASSWORD_RESET_AND_REVOKE_ALL',
    'GLOBAL_REVOKE_FENCES_OLD_PENDING_TRANSACTIONS_AND_LATE_REFRESH',
    'ROTATE_REFRESH_ONCE_PER_LOGIN_FAMILY',
    'MEMBERSHIP_END_AND_ALL_TENANT_ASSIGNMENTS_END_AND_REVISION',
    'ASSIGN_CAPACITY_VERSION_AND_ENTITLEMENT_REVISION',
    'REASSIGN_END_OLD_CREATE_NEW_WITHOUT_TRANSIENT_OVERALLOCATION',
    'RETAINED_ASSIGNED_COUNTS_TOWARDS_EXPIRED_POOL_CAPACITY',
    'REDUCE_QUANTITY_NOT_BELOW_ASSIGNED',
    'REMOVE_SEAT_TYPE_ONLY_AFTER_ALL_ASSIGNMENTS_END',
    'TRANSFER_UNIQUE_OWNER_AND_KEEP_ASSIGNMENTS',
    'BIND_IDENTITY_UNIQUE_AND_AT_LEAST_ONE_USABLE_METHOD',
    'IDEMPOTENT_BUSINESS_WRITE_RESULT_AND_AUDIT_COMMIT_TOGETHER',
  ],
  entitlementRules: {
    personal: 'VALID_PERSONAL_SUBSCRIPTIONS_UNION',
    tenant:
      'ACTIVE_MEMBERSHIP_AND_ACTIVE_TENANT_THEN_PERSONAL_UNION_CURRENT_TENANT_VALID_ASSIGNMENTS',
    adminGrantsPaidFeatures: false,
    sharedReadRequiresPaidFeature: false,
    unavailableIsDenied: false,
    resultsAreOfflineLicenses: false,
  },
  deliveryRules: {
    acceptedMeansVerified: false,
    universalTestCode: false,
    mockProductionAllowed: false,
    liveFailureFallsBackToMock: false,
    replacementChallengeInvalidatesPrevious: true,
  },
  sessionRules: {
    refreshCountsAsActivity: false,
    pollingCountsAsActivity: false,
    sensitiveReauthenticationResetsAbsolute: false,
    clientTimeAccepted: false,
    currentLogout: 'CURRENT_LOGIN_ONLY',
    globalLogout: 'ALL_MOLIS_PRODUCTS',
    refreshUnknownOutcome: 'NO_REPLAY_REAUTHENTICATE',
    revokedProofMayReadSameLogoutResultOnly: true,
  },
  identityRules: {
    automaticEmailMerge: false,
    unverifiedEmailMayAuthenticate: false,
    productSessionsIndependent: true,
  },
  portSchemas: [
    'SmsDelivery',
    'MailDelivery',
    'DeliveryResult',
    'ProviderServerContext',
    'ProviderCallback',
    'ProviderIdentity',
    'EnvironmentConfig',
    'ClientEnvironmentConfig',
    'MigrationMapping',
    'MigrationInventoryRecord',
  ],
}
for (const flow of policy.authenticationFlows)
  Object.assign(flow, {
    requiresCurrentSession: ['REAUTH', 'BIND', 'REPLACE'].includes(flow.purpose),
  })

const paths: Record<string, Record<string, unknown>> = {}
for (const e of endpoints) {
  const outputName = `${e.output}Response`
  if (!defs[outputName]) add(outputName, obj({ data: ref(e.output), requestId: id }))
  const path = e.group === 'API-08' ? e.path : `/api/v2${e.path}`
  const parameters: unknown[] = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { $ref: './schemas.json#/$defs/Id' },
  }))
  if (e.auth === 'initiator')
    parameters.push({
      name: 'X-Auth-Initiator-Proof',
      in: 'header',
      required: true,
      schema: { $ref: './schemas.json#/$defs/OpaqueSecret' },
    })
  if (e.idempotent)
    parameters.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      schema: { type: 'string', minLength: 16, maxLength: 128 },
    })
  if (e.output.endsWith('Page'))
    parameters.push(
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      { name: 'cursor', in: 'query', schema: { type: 'string', minLength: 1, maxLength: 2048 } },
    )
  if (e.query === 'assignment-state')
    parameters.push({
      name: 'state',
      in: 'query',
      schema: { type: 'string', enum: ['current', 'history'], default: 'current' },
    })
  if (e.query === 'callback')
    for (const [key, schema] of Object.entries(
      defs.ProductCallbackQuery.properties as Record<string, Schema>,
    ))
      parameters.push({ name: key, in: 'query', required: true, schema: rewriteRefs(schema) })
  const security = ['grant', 'initiator', 'product-callback'].includes(e.auth)
    ? []
    : ['revoke', 'transaction-create'].includes(e.auth)
      ? [{ bearerAuth: [] }, {}]
      : e.auth === 'product'
        ? [{ productSession: [] }]
        : [{ bearerAuth: [] }]
  const response = (schema: string) => ({
    description: schema,
    headers: { 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
    content: { 'application/json': { schema: { $ref: `./schemas.json#/$defs/${schema}` } } },
  })
  const responses: Record<string, unknown> = { '200': response(outputName) }
  for (const status of Object.keys(errorCodes)) responses[status] = response(`Error${status}`)
  const operation: Record<string, unknown> = {
    operationId: e.operationId,
    tags: [e.group],
    'x-implementation-status': 'CONTRACT_ONLY',
    'x-authority': e.auth,
    security,
    parameters,
    responses,
  }
  if (e.auth === 'transaction-create')
    operation['x-session-required-purposes'] = ['REAUTH', 'BIND', 'REPLACE']
  if (e.input)
    operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: { $ref: `./schemas.json#/$defs/${e.input}` } } },
    }
  ;(paths[path] ??= {})[e.method] = operation
}
function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteRefs)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) => [
        key,
        key === '$ref' && typeof val === 'string' ? `./schemas.json${val}` : rewriteRefs(val),
      ]),
    )
  return value
}
const openapi = {
  openapi: '3.1.0',
  info: {
    title: 'Molis Unified Account',
    version: '1.2.0',
    description:
      'AUTH-01 executable contract. Endpoints are not implemented by this artifact. Product paths are adapter operation mappings; Work management uses its action gateway.',
  },
  jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
  tags: Array.from({ length: 9 }, (_, i) => ({ name: `API-0${i + 1}` })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' },
      productSession: { type: 'apiKey', in: 'cookie', name: '__Host-molis-session' },
    },
  },
  'x-internal-port-schemas': policy.portSchemas.map((n) => `./schemas.json#/$defs/${n}`),
  'x-policy': './policy.json',
  'x-product-write-protection':
    'Origin plus session-bound CSRF (Club); loopback/Host/Origin/local-control/one-use-write-key (Work). Callback uses transaction state.',
}
const schemas = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://contracts.molis.invalid/unified-account/1/schemas.json',
  $defs: defs,
}

// Deterministic generated coverage is complemented by hand-selected attack/boundary fixtures below.
function sample(schema: Schema): unknown {
  if ('$ref' in schema) return sample(defs[String(schema.$ref).split('/').at(-1)!])
  if ('const' in schema) return schema.const
  if (schema.enum) return (schema.enum as unknown[])[0]
  if (schema.oneOf) return sample((schema.oneOf as Schema[])[0])
  if (schema.type === 'null') return null
  if (schema.type === 'boolean') return true
  if (schema.type === 'integer') return Math.max(1, Number(schema.minimum ?? 0))
  if (schema.type === 'array')
    return Array.from({ length: Number(schema.minItems ?? 0) }, () =>
      sample(schema.items as Schema),
    )
  if (schema.type === 'object') {
    const props = (schema.properties ?? {}) as Record<string, Schema>
    const required = [...((schema.required ?? []) as string[])]
    if (schema.anyOf) required.push(...(((schema.anyOf as Schema[])[0].required ?? []) as string[]))
    return Object.fromEntries([...new Set(required)].map((key) => [key, sample(props[key])]))
  }
  if (schema.format === 'date-time') return '2026-11-04T08:00:00Z'
  if (schema.format === 'email') return 'sample@example.invalid'
  if (schema.format === 'http-url' || schema.format === 'http-origin')
    return 'https://auth.example.invalid'
  if (schema.format === 'local-path') return '/account'
  if (String(schema.pattern).includes('861')) return '+8613800000000'
  if (String(schema.pattern).includes('data:image')) return 'data:image/png;base64,AAAAAAAAAAAA'
  if (schema.pattern === '^[0-9]{6}$') return '123456'
  return 'x'.repeat(Math.max(8, Number(schema.minLength ?? 1)))
}
type Fixture = { name: string; schema: string; valid: boolean; value: unknown }
const fixtures: Fixture[] = []
const fixture = (name: string, schema: string, valid: boolean, value: unknown) =>
  fixtures.push({ name, schema, valid, value })
for (const [schema, definition] of Object.entries(defs)) {
  fixture(`${schema}:minimal-valid`, schema, true, sample(definition))
  fixture(`${schema}:wrong-root-type`, schema, false, definition.type === 'null' ? true : null)
  if (definition.oneOf)
    for (const [i, branch] of (definition.oneOf as Schema[]).entries())
      fixture(`${schema}:variant-${i + 1}`, schema, true, sample(branch))
}
const tx = sample(defs.CreateTransactionRequest) as Record<string, unknown>
fixture('purpose-email-password-reset-forbidden', 'CreateTransactionRequest', false, {
  ...tx,
  purpose: 'PASSWORD_RESET',
})
fixture('reauth-missing-operation', 'CreateTransactionRequest', false, { ...tx, purpose: 'REAUTH' })
fixture('reauth-cross-operation-target', 'CreateTransactionRequest', false, {
  ...tx,
  purpose: 'REAUTH',
  operation: 'CHANGE_PASSWORD',
  target: { bindingId: 'binding_example' },
})
fixture('reauth-email-code-not-existing-login-method', 'CreateTransactionRequest', false, {
  ...tx,
  purpose: 'REAUTH',
  method: 'EMAIL_CODE',
  operation: 'CHANGE_PASSWORD',
  target: { kind: 'PASSWORD' },
})
fixture('replace-missing-binding', 'CreateTransactionRequest', false, {
  ...tx,
  purpose: 'REPLACE',
  method: 'PHONE_OTP',
})
fixture('transaction-actor-injection', 'CreateTransactionRequest', false, {
  ...tx,
  userId: 'victim',
})
fixture('transaction-policy-injection', 'CreateTransactionRequest', false, {
  ...tx,
  policyProfile: 'legacy',
})
fixture('transaction-pkce-plain', 'CreateTransactionRequest', false, {
  ...tx,
  codeChallengeMethod: 'plain',
})
fixture('transaction-pkce-short', 'CreateTransactionRequest', false, {
  ...tx,
  codeChallenge: 'short',
})
fixture('challenge-phone-outside-86', 'ChallengeRequest', false, {
  channel: 'SMS',
  address: '+12025550123',
})
fixture('challenge-channel-target-mismatch', 'ChallengeRequest', false, {
  channel: 'EMAIL',
  address: '+8613800000000',
})
fixture('challenge-rewrite-purpose', 'VerifyChallengeRequest', false, {
  credential: '123456',
  purpose: 'LOGIN',
})
fixture('credential-length', 'VerifyChallengeRequest', false, { credential: '12345' })
fixture('proof-kind-confusion', 'TransactionCompleteResult', false, {
  kind: 'RESET_PROOF',
  operationProof: 'x'.repeat(40),
  expiresAt: '2026-11-04T08:00:00Z',
})
fixture('proof-unexpected-extra', 'TransactionCompleteResult', false, {
  kind: 'LOGIN_CODE',
  code: 'x'.repeat(40),
  resetProof: 'x'.repeat(40),
  state: 'state'.repeat(4),
  expiresAt: '2026-11-04T08:00:00Z',
})
fixture('token-grants-mixed', 'TokenRequest', false, {
  grantType: 'refresh_token',
  clientId: 'client_example',
  refreshToken: 'x'.repeat(40),
  code: 'x'.repeat(40),
})
fixture('password-select-except-session', 'PasswordChangeRequest', false, {
  ...(sample(defs.PasswordChangeRequest) as object),
  exceptSessionId: 'victim',
})
fixture('profile-empty-update', 'ProfileUpdateRequest', false, { expectedVersion: 1 })
fixture('profile-null-avatar-removes', 'ProfileUpdateRequest', true, {
  avatarDataUrl: null,
  expectedVersion: 1,
})
fixture('profile-external-fetch-forbidden', 'ProfileUpdateRequest', false, {
  avatarUrl: 'https://example.invalid/a.png',
  expectedVersion: 1,
})
fixture('activity-client-time', 'ActivityRequest', false, {
  eventId: 'event_example',
  kind: 'INTERACT',
  timestamp: '2026-11-04T08:00:00Z',
})
fixture('activity-background-kind', 'ActivityRequest', false, {
  eventId: 'event_example',
  kind: 'REFRESH',
})
fixture('scope-user-injection', 'Scope', false, { kind: 'PERSONAL', userId: 'victim' })
fixture('self-tenant-owner-injection', 'SelfTenantCreateRequest', false, { name: 'Example', ownerUserId: 'another_user' })
fixture('tenant-creation-unknown-policy', 'TenantCreationPolicyView', false, { mode: 'UNKNOWN' })
fixture('scope-personal-tenant-injection', 'Scope', false, {
  kind: 'PERSONAL',
  tenantId: 'tenant_example',
})
fixture('member-owner-escalation', 'RoleUpdateRequest', false, {
  role: 'OWNER',
  expectedVersion: 1,
})
fixture('invitation-admin-escalation', 'InvitationCreateRequest', false, {
  target: { kind: 'USER', value: 'user_example' },
  role: 'ADMIN',
})
fixture('seat-member-actor-injection', 'SeatAssignRequest', false, {
  ...(sample(defs.SeatAssignRequest) as object),
  userId: 'victim',
})
fixture('personal-subscription-seat-quantities', 'SubscriptionCreateRequest', false, {
  ...(sample(defs.SubscriptionCreateRequest) as object),
  seatQuantities: { demo: 1 },
})
fixture('subscription-empty-patch', 'SubscriptionUpdateRequest', false, {
  expectedVersion: 1,
  reason: 'test-only',
})
fixture('seat-negative-quantity', 'SeatQuantities', false, { demo: -1 })
fixture('seat-fractional-quantity', 'SeatQuantities', false, { demo: 1.5 })
fixture('ended-assignment-missing-end-reason', 'Assignment', false, {
  ...(sample(defs.Assignment) as object),
  status: 'ENDED',
})
fixture('deny-with-source', 'EntitlementDecision', false, {
  featureId: 'demo.feature',
  allowed: false,
  reason: 'FEATURE_NOT_GRANTED',
  validUntil: '2026-11-04T08:00:00Z',
  sources: [{ kind: 'PERSONAL_SUBSCRIPTION', subscriptionId: 'sub_example' }],
})
fixture('grant-without-source', 'EntitlementDecision', false, {
  featureId: 'demo.feature',
  allowed: true,
  reason: 'GRANTED',
  validUntil: '2026-11-04T08:00:00Z',
  sources: [],
})
fixture('entitlement-duplicate-features', 'EntitlementCheckRequest', false, {
  scope: { kind: 'PERSONAL' },
  featureIds: ['demo.feature', 'demo.feature'],
})
fixture('entitlement-101-features', 'EntitlementCheckRequest', false, {
  scope: { kind: 'PERSONAL' },
  featureIds: Array.from({ length: 101 }, (_, i) => `demo.${i}`),
})
fixture('browser-token-leak', 'AccountView', false, {
  state: 'ANONYMOUS',
  accessToken: 'x'.repeat(40),
})
fixture('browser-identity-assertion', 'ProductSubmitRequest', false, {
  step: 'START_PROVIDER',
  subject: 'victim',
})
fixture('browser-proof-injection', 'ProductBindRequest', false, {
  ...(sample(defs.ProductBindRequest) as object),
  operationProof: 'x'.repeat(40),
})
fixture('browser-absolute-return-url', 'ProductTransactionRequest', false, {
  purpose: 'LOGIN',
  method: 'GOOGLE',
  returnTo: 'https://evil.example.invalid',
})
fixture('browser-protocol-relative-return-url', 'ProductTransactionRequest', false, {
  purpose: 'LOGIN',
  method: 'GOOGLE',
  returnTo: '//evil.example.invalid',
})
fixture('browser-backslash-return-url', 'ProductTransactionRequest', false, {
  purpose: 'LOGIN',
  method: 'GOOGLE',
  returnTo: '/\\evil.example.invalid',
})
fixture('config-production-mock', 'EnvironmentConfig', false, {
  ...(sample(defs.EnvironmentConfig) as object),
  kind: 'PRODUCTION',
})
fixture('config-origin-path', 'EnvironmentConfig', false, {
  ...(sample(defs.EnvironmentConfig) as object),
  authOrigin: 'https://auth.example.invalid/path',
})
fixture('provider-without-email', 'ProviderIdentity', true, {
  issuer: 'https://github.com',
  subject: 'test_subject_1',
})
fixture('provider-browser-authority-injection', 'ProviderIdentity', false, {
  issuer: 'https://github.com',
  subject: 'test_subject_1',
  userId: 'victim',
})
fixture('invalid-calendar-date', 'Timestamp', false, '2026-02-30T00:00:00Z')
fixture('timestamp-offset-not-utc', 'Timestamp', false, '2026-11-04T08:00:00+08:00')
fixture('error-does-not-echo-secret', 'ErrorResponse', false, {
  requestId: 'req_example',
  error: { code: 'INVALID_CREDENTIALS', password: 'test-secret-do-not-use' },
})
fixture('error-code-unknown', 'ErrorResponse', false, {
  requestId: 'req_example',
  error: { code: 'UNKNOWN' },
})
fixture('rate-limit-needs-wait', 'Error429', false, {
  requestId: 'req_example',
  error: { code: 'RATE_LIMITED' },
})
fixture('initial-resource-version-zero', 'ExpectedVersionRequest', true, { expectedVersion: 0 })
fixture('initial-session-revision-zero', 'SessionView', true, {
  ...(sample(defs.SessionView) as object),
  sessionRevision: 0,
})
fixture('plan-version-zero-rejected', 'PlanVersionNumber', false, 0)
fixture('existing-eight-character-password-login', 'PasswordLoginRequest', true, {
  email: 'sample@example.invalid',
  password: 'DemoAb9!',
})
fixture('new-password-eight-characters-transport', 'NewPassword', true, 'DemoAb9!')
fixture('new-password-seven-rejected', 'NewPassword', false, 'DemoA9!')
fixture('provider-short-opaque-code', 'ProviderCallback', true, {
  state: 'x'.repeat(40),
  code: '0123456789abcdefghij',
})
fixture('provider-subject-not-local-id', 'ProviderIdentity', true, {
  issuer: 'https://provider.example.invalid',
  subject: 'opaque|subject/with spaces',
})
fixture('product-consumed-cannot-complete-again', 'ProductTransactionView', false, {
  handle: 'handle_example',
  status: 'CONSUMED',
  nextStep: 'COMPLETE',
  expiresAt: '2026-11-04T08:00:00Z',
})
fixture('id-trailing-newline', 'Id', false, 'user_example\n')
fixture('email-trailing-newline', 'Email', false, 'sample@example.invalid\n')
fixture('token-trailing-newline', 'OpaqueSecret', false, 'x'.repeat(40) + '\n')
fixture('url-unicode-host-must-be-punycode', 'HttpUrl', false, 'https://例子.example/path')
fixture(
  'url-unicode-path-must-be-percent-encoded',
  'HttpUrl',
  false,
  'https://auth.example.invalid/回调',
)
fixture(
  'url-percent-encoded-path',
  'HttpUrl',
  true,
  'https://auth.example.invalid/%E5%9B%9E%E8%B0%83',
)

const outputs = {
  'schemas.json': schemas,
  'openapi.json': openapi,
  'policy.json': policy,
  'fixtures.json': { contractVersion: '1.2.0', syntheticOnly: true, fixtures },
}
const check = process.argv.includes('--check')
let stale = false
for (const [filename, value] of Object.entries(outputs)) {
  const target = fileURLToPath(new URL(filename, import.meta.url))
  const content = `${JSON.stringify(value, null, 2)}\n`
  if (check) {
    try {
      if (readFileSync(target, 'utf8') !== content) {
        console.error(`stale contract: ${filename}`)
        stale = true
      }
    } catch {
      console.error(`missing contract: ${filename}`)
      stale = true
    }
  } else writeFileSync(target, content)
}
if (stale) process.exitCode = 1
