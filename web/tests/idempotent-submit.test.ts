import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient, AuthError } from "../src/lib/account-client.ts";
import { IdempotentSubmit, refreshAfterWrite } from "../src/lib/idempotent-submit.ts";
import { syncCreatedTenant } from "../src/lib/tenant-selection.ts";

test("uncertain create results replay the exact request against one committed tenant", async (t) => {
  const scenarios = [
    ["the first finish returns a conflict after commit", [[409, "VERSION_CONFLICT"]]],
    ["a lost response is followed by temporary server errors", [
      [0, "RESULT_UNKNOWN"],
      [503, "AUTH_UNAVAILABLE"],
      [503, "UPSTREAM_UNAVAILABLE"],
      [429, "RATE_LIMITED"],
      [409, "VERSION_CONFLICT"],
      [502, "GATEWAY_FAILURE"],
    ]],
  ] as const;
  for (const [name, failures] of scenarios) {
    await t.test(name, async () => {
      const submissions = new IdempotentSubmit();
      submissions.setAccount("account-a");
      const database = new Map<string, { tenantId: string }>();
      const wire: { body: BodyInit | null | undefined; key: string }[] = [];
      const client = new AccountClient({
        origin: "http://127.0.0.1:8787",
        fetch: async (_, init) => {
          if (init!.method === "GET") {
            return Response.json({ data: {} }, { headers: { "X-CSRF-Token": "fixture" } });
          }
          const key = new Headers(init!.headers).get("Idempotency-Key");
          assert.ok(key);
          const failure = failures[wire.length];
          wire.push({ body: init!.body, key });
          if (!database.has(key)) database.set(key, { tenantId: "tenant-" + database.size });
          if (failure) {
            const [status, code] = failure;
            if (!status) throw new TypeError("response lost after commit");
            return Response.json({ error: { code }, requestId: "request-" + wire.length }, { status });
          }
          return Response.json({ data: database.get(key) });
        },
      });
      const submit = () => {
        const body = { name: "  Research  ".trim() };
        return submissions.send("tenant", "POST", "/tenants", body,
          key => client.request("/tenants", body, "POST", key));
      };
      for (const [index, [status, code]] of failures.entries()) {
        await assert.rejects(submit(), { code, status, requestId: status ? "request-" + (index + 1) : "" });
        assert.equal(wire.length, index + 1, "each user submission sends exactly one POST");
      }
      assert.deepEqual(await submit(), { tenantId: "tenant-0" });
      assert.deepEqual(wire, Array(failures.length + 1).fill({ body: '{"name":"Research"}', key: wire[0].key }));
      assert.equal(database.size, 1);
    });
  }
});

test("terminal client errors end the attempted submission", async () => {
  for (const [status, code] of [
    [400, "INVALID_REQUEST"], [401, "SESSION_EXPIRED"], [403, "FORBIDDEN"],
    [404, "NOT_FOUND"], [409, "IDEMPOTENCY_CONFLICT"],
  ] as const) {
    const submissions = new IdempotentSubmit();
    submissions.setAccount("account-a");
    const keys: string[] = [];
    const submit = (error?: AuthError) =>
      submissions.send("tenant", "POST", "/tenants", { name: "Research" }, async key => {
        keys.push(key);
        if (error) throw error;
      });
    await assert.rejects(submit(new AuthError("RESULT_UNKNOWN")), { code: "RESULT_UNKNOWN" });
    const terminal = new AuthError(code, status, "terminal-request");
    await assert.rejects(submit(terminal), error => error === terminal);
    await submit();
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[1], keys[2]);
  }
});

test("effective input edits including A to B to A, account changes and success clear the key", async () => {
  const submissions = new IdempotentSubmit();
  submissions.setAccount("account-a");
  const keys: string[] = [];
  let draft = "A";
  function edit(next: string) {
    if (draft.trim() !== next.trim()) submissions.discard("tenant");
    draft = next;
  }
  function submit(succeed = false) {
    return submissions.send("tenant", "POST", "/tenants", { name: draft.trim() }, async key => {
      keys.push(key);
      if (!succeed) throw new AuthError("RESULT_UNKNOWN");
      return { tenantId: "tenant" };
    });
  }
  await assert.rejects(submit(), { code: "RESULT_UNKNOWN" });
  edit(" A ");
  await assert.rejects(submit(), { code: "RESULT_UNKNOWN" });
  assert.equal(keys[0], keys[1], "whitespace alone does not change the transmitted name");
  edit("B");
  edit("A");
  await assert.rejects(submit(), { code: "RESULT_UNKNOWN" });
  assert.notEqual(keys[1], keys[2]);
  submissions.setAccount("account-b");
  await submit(true);
  assert.notEqual(keys[2], keys[3]);
  await submit(true);
  assert.notEqual(keys[3], keys[4]);
  submissions.setAccount(undefined);
  await assert.rejects(submit(), { code: "CANCELLED" });
  assert.equal(keys.length, 5);
});

test("a failed list or member refresh leaves the write committed and retries only GETs", async (t) => {
  for (const failedPath of ["/tenants", "/tenants/created/members"]) {
    await t.test(failedPath, async () => {
      const submissions = new IdempotentSubmit();
      submissions.setAccount("account-a");
      const result = { tenantId: "created" };
      const calls: string[] = [];
      let committed: typeof result | undefined;
      let formOpen = true;
      let retry: (() => Promise<void>) | undefined;
      let fail = true;
      await refreshAfterWrite(
        () => submissions.send("tenant", "POST", "/tenants", { name: "Research" }, async () => {
          calls.push("POST /tenants");
          return result;
        }),
        created => {
          committed = created;
          formOpen = false;
        },
        async created => {
          assert.equal(committed, result);
          assert.equal(formOpen, false);
          for (const path of ["/tenants", "/tenants/" + created.tenantId + "/members"]) {
            calls.push("GET " + path);
            if (fail && path === failedPath) throw new AuthError("AUTH_UNAVAILABLE");
          }
        },
        (error, refresh) => {
          assert.ok(error instanceof AuthError);
          assert.equal(error.code, "AUTH_UNAVAILABLE");
          retry = refresh;
        },
      );
      assert.equal(committed, result);
      assert.equal(formOpen, false);
      assert.ok(retry);
      fail = false;
      await retry();
      assert.equal(calls.filter(call => call.startsWith("POST ")).length, 1);
      assert.deepEqual(calls.slice(-2), ["GET /tenants", "GET /tenants/created/members"]);
    });
  }
});

test("the tenant details converge to the refreshed list after creation", async (t) => {
  const created = { tenantId: "created", name: "Research", status: "ACTIVE", version: 0 };
  const disabled = { ...created, status: "DISABLED", version: 1 };
  const active = { ...created, name: "Latest name", version: 1 };
  const other = { ...created, tenantId: "other" };
  const scenarios = [
    { name: "disabled", listed: [disabled], selected: disabled, members: [], loads: [] },
    { name: "removed", listed: [other], selected: undefined, members: [], loads: [] },
    { name: "active", listed: [active], selected: active, members: ["latest"], loads: [active] },
    { name: "selection changed", listed: [disabled, other], selected: other, members: ["previous"], loads: [] },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const selection: { value: typeof created | undefined } = { value: created };
      const loads: (typeof created)[] = [];
      let members = ["previous"];
      await refreshAfterWrite(
        async () => created,
        saved => { selection.value = saved; },
        async saved => {
          if (scenario.selected === other) selection.value = other;
          await syncCreatedTenant(saved.tenantId, scenario.listed, selection,
            () => { members = []; },
            async tenant => { loads.push(tenant); members = ["latest"]; },
          );
        },
        error => { throw error; },
      );
      assert.equal(selection.value, scenario.selected);
      assert.deepEqual(members, scenario.members);
      assert.deepEqual(loads, scenario.loads);
    });
  }
});
