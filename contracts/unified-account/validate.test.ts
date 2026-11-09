import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  compileDocument,
  validateNamed,
  validateWithDocument,
  type SchemaDocument,
} from "./validate.ts";

const read = (file: string) =>
  JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const schema = read("schemas.json");
const fixtures = read("fixtures.json").fixtures as {
  name: string;
  schema: string;
  valid: boolean;
  value: unknown;
}[];
const policy = read("policy.json");
const openapi = read("openapi.json");

test("V2C-01 retired service credentials have no public schema, capability or operation", () => {
  for (const capability of ["SERVICE_READ", "SERVICE_WRITE"])
    assert.equal(validateNamed("PlatformCapability", capability), false);
  assert.equal(
    validateNamed("TokenRequest", {
      grant_type: "client_credentials",
      client_id: "retired",
      client_secret: "retired",
    }),
    false,
  );
  for (const name of [
    "PlatformService",
    "PlatformServicePage",
    "ServiceCreateRequest",
    "ServiceChangeRequest",
    "ServiceCredentialResult",
  ])
    assert.equal(Object.hasOwn(schema.$defs, name), false);
  for (const path of Object.keys(openapi.paths))
    assert.doesNotMatch(
      path,
      /\/platform\/(?:applications\/\{applicationId\}\/services|services)(?:\/|$)/,
    );
});

test("AUTH-01 / UAS-01,11,26: the same redacted positive and negative fixtures are consumed by Rust and TypeScript", () => {
  for (const fixture of fixtures)
    assert.equal(
      validateNamed(fixture.schema, fixture.value),
      fixture.valid,
      fixture.name,
    );
  const covered = new Set(fixtures.map((f) => f.schema));
  assert.deepEqual([...covered].sort(), Object.keys(schema.$defs).sort());
  for (const name of covered) {
    assert.ok(
      fixtures.some((f) => f.schema === name && f.valid),
      `missing positive ${name}`,
    );
    assert.ok(
      fixtures.some((f) => f.schema === name && !f.valid),
      `missing negative ${name}`,
    );
  }
});

test("AUTH-01: generated artifacts are reproducible without changing files", () => {
  execFileSync(
    process.execPath,
    [new URL("generate.ts", import.meta.url).pathname, "--check"],
    {
      stdio: "pipe",
    },
  );
});

test("AUTH-01: unsupported schemas fail closed instead of silently ignoring constraints", () => {
  for (const definition of [
    { type: "string", unknown: true },
    { type: "string", format: "uuid" },
    { type: "string", pattern: "(?=x)x" },
    { $ref: "https://external.invalid/schema" },
    { $ref: "#/$defs/Example" },
    { required: ["x", "x"] },
    { anyOf: [] },
    { type: ["string", "null"] },
    { items: true },
    { minLength: -1 },
    { format: false },
  ])
    assert.throws(() => compileDocument({ $defs: { Example: definition } }));
  assert.throws(() => validateNamed("NotAContract", {}));
});

test("AUTH-01: JSON Schema conjunction, references and Unicode lengths are evaluated", () => {
  const document: SchemaDocument = {
    $defs: {
      Label: { type: "string", minLength: 1, maxLength: 1 },
      Example: { allOf: [{ $ref: "#/$defs/Label" }, { not: { const: "x" } }] },
      Unique: { type: "array", uniqueItems: true, items: { type: "object" } },
      Numeric: { const: 1 },
      NumericEnum: { enum: [1] },
      NumericUnique: { type: "array", uniqueItems: true },
    },
  };
  assert.equal(validateWithDocument(document, "Example", "🦊"), true);
  assert.equal(validateWithDocument(document, "Example", "xx"), false);
  assert.equal(validateWithDocument(document, "Example", "x"), false);
  assert.equal(
    validateWithDocument(document, "Unique", [
      { a: 1, b: 2 },
      { b: 2, a: 1 },
    ]),
    false,
  );
  assert.equal(
    validateWithDocument(document, "Numeric", JSON.parse("1.0")),
    true,
  );
  assert.equal(
    validateWithDocument(document, "NumericEnum", JSON.parse("1.0")),
    true,
  );
  assert.equal(
    validateWithDocument(document, "NumericUnique", JSON.parse("[1,1.0]")),
    false,
  );
});

test("AUTH-01: OpenAPI operations have resolved schemas, authority and complete error responses", () => {
  assert.equal(openapi.openapi, "3.1.0");
  const ids = new Set<string>();
  const refs: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref") refs.push(String(child));
      else visit(child);
    }
  };
  for (const [path, methods] of Object.entries(openapi.paths) as [
    string,
    Record<string, Record<string, unknown>>,
  ][]) {
    assert.ok(path.startsWith("/api/v2/") || path.startsWith("/api/account/"));
    for (const operation of Object.values(methods)) {
      const operationId = String(operation.operationId);
      assert.equal(ids.has(operationId), false, `duplicate ${operationId}`);
      ids.add(operationId);
      assert.equal(operation["x-implementation-status"], "CONTRACT_ONLY");
      assert.ok(
        policy.permissions.some(
          (p: { operationId: string }) => p.operationId === operationId,
        ),
      );
      const responses = operation.responses as Record<string, unknown>;
      assert.ok(responses["200"]);
      for (const status of Object.keys(policy.errors))
        assert.ok(responses[status], `${operationId} missing ${status}`);
      visit(operation);
    }
  }
  for (const reference of refs) {
    assert.ok(reference.startsWith("./schemas.json#/$defs/"), reference);
    assert.ok(
      Object.hasOwn(
        schema.$defs,
        reference.slice("./schemas.json#/$defs/".length),
      ),
      reference,
    );
  }
  assert.equal(ids.size, policy.permissions.length);
  assert.ok(
    ids.size >= 100,
    "central and product fixed mappings must both be present",
  );
  for (const name of policy.portSchemas) assert.ok(schema.$defs[name], name);
});

test("AUTH-01: purpose/method combinations are closed and each has one proof kind", () => {
  const base = {
    clientId: "client_test",
    redirectUri: "http://127.0.0.1:4207/account/callback",
    state: "state_test_123456",
    codeChallenge: "x".repeat(43),
    codeChallengeMethod: "S256",
    initiatorChallenge: "x".repeat(43),
  };
  for (const purpose of [
    "LOGIN",
    "EMAIL_SIGNUP",
    "REAUTH",
    "BIND",
    "REPLACE",
    "PASSWORD_RESET",
  ]) {
    for (const method of [
      "EMAIL_PASSWORD",
      "PHONE_OTP",
      "GOOGLE",
      "GITHUB",
      "EMAIL_CODE",
    ]) {
      const input = {
        ...base,
        purpose,
        method,
        ...(purpose === "REAUTH"
          ? { operation: "CHANGE_PASSWORD", target: { kind: "PASSWORD" } }
          : {}),
        ...(purpose === "REPLACE" ? { bindingId: "binding_test" } : {}),
      };
      const rules = policy.authenticationFlows.filter(
        (f: { purpose: string; methods: string[] }) =>
          f.purpose === purpose && f.methods.includes(method),
      );
      assert.equal(
        validateNamed("CreateTransactionRequest", input),
        rules.length === 1,
        `${purpose}/${method}`,
      );
      if (rules.length)
        assert.ok(
          [
            "LOGIN_CODE",
            "OPERATION_PROOF",
            "NEW_IDENTITY_PROOF",
            "RESET_PROOF",
          ].includes(rules[0].completion),
        );
    }
  }
});

test("AUTH-01: terminal states cannot resurrect; lifecycle and entitlement policy match confirmed rules", () => {
  for (const machine of Object.values(policy.stateMachines) as {
    terminal: string[];
    transitions: string[][];
  }[]) {
    for (const terminal of machine.terminal)
      assert.equal(
        machine.transitions.some(([from]) => from === terminal),
        false,
        terminal,
      );
  }
  assert.equal(policy.defaults.loginIdleSeconds, 30 * 86400);
  assert.equal(policy.defaults.loginAbsoluteSeconds, 90 * 86400);
  assert.equal(policy.sessionRules.refreshCountsAsActivity, false);
  assert.equal(
    policy.sessionRules.sensitiveReauthenticationResetsAbsolute,
    false,
  );
  assert.equal(policy.roleRules.transferAccepted.previousOwnerRole, "MEMBER");
  assert.equal(
    policy.roleRules.transferAccepted.existingAssignments,
    "PRESERVE",
  );
  assert.equal(policy.entitlementRules.adminGrantsPaidFeatures, false);
  assert.equal(policy.entitlementRules.sharedReadRequiresPaidFeature, false);
  assert.equal(policy.identityRules.automaticEmailMerge, false);
  assert.equal(policy.deliveryRules.mockProductionAllowed, false);
});
