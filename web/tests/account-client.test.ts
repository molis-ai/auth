import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/shared/api/account-client.ts";
test("AUTH-U-07 client uses same-origin cookies/CSRF and never installs bearer credentials", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new AccountClient({
    origin: "http://127.0.0.1:8787",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify({ data: { state: "ANONYMOUS" } }), {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": "csrf-fixture",
        },
      });
    },
  });
  await client.request("/auth/transactions", {
    purpose: "LOGIN",
    method: "PHONE_OTP",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:8787/api/account/session");
  assert.equal(calls[1].init.credentials, "same-origin");
  assert.equal(
    (calls[1].init.headers as Record<string, string>)["X-CSRF-Token"],
    "csrf-fixture",
  );
  assert.ok(
    !Object.keys(calls[1].init.headers!).some(
      (k) => k.toLowerCase() === "authorization",
    ),
  );
  for (const path of [
    "//evil.example",
    "/../sessions",
    "/%2fapi",
    "https://evil.example",
  ])
    await assert.rejects(() => client.request(path));
  client.close();
});
test("AUTH-U-07 canceled generation cannot deliver a late login result", async () => {
  let release!: () => void;
  const client = new AccountClient({
    origin: "http://127.0.0.1:8787",
    fetch: async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json({ data: { state: "AUTHENTICATED" } });
    },
  });
  const read = client.session();
  await new Promise((r) => setTimeout(r, 0));
  client.close();
  release();
  await assert.rejects(read, /CANCELLED/);
});

const origin = "http://127.0.0.1:8787";
const reply = (csrf = "current-csrf", data: unknown = { state: "ANONYMOUS" }) =>
  Response.json({ data }, { headers: { "X-CSRF-Token": csrf } });
const unknownResult = { code: "RESULT_UNKNOWN", status: 0, requestId: "" };
const cancelled = { code: "CANCELLED", status: 0, requestId: "" };
const conflict = { code: "VERSION_CONFLICT", status: 409, requestId: "conflict-id" };
const holdUntilAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
const accountPath = (url: RequestInfo | URL) => String(url).slice((origin + "/api/account").length);
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test("login capabilities and initial session run in parallel without sharing CSRF", async () => {
  const bootstrap = Promise.withResolvers<Response>();
  const calls: [string, string | null][] = [];
  const capabilities = { methods: ["ACCOUNT_PASSWORD"] };
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      calls.push([path, new Headers(init!.headers).get("X-CSRF-Token")]);
      if (path === "/session") return bootstrap.promise;
      if (path === "/auth/capabilities") return reply("unexpected-csrf", capabilities);
      return reply();
    },
  });
  try {
    const session = client.session();
    const typed = client.loginCapabilities();
    const generic = client.request("/auth/capabilities");
    await nextTurn();
    assert.deepEqual(calls.toSorted(), [
      ["/auth/capabilities", null], ["/auth/capabilities", null], ["/session", null],
    ]);
    assert.deepEqual(await typed, capabilities);
    assert.deepEqual(await generic, capabilities);
    const write = client.request("/profile", {}, "PATCH");
    bootstrap.resolve(reply());
    await Promise.all([session, write]);
    assert.deepEqual(calls.at(-1), ["/profile", "current-csrf"]);
  } finally {
    bootstrap.resolve(reply());
    client.close();
  }
});

test("LOGIN-P1-04 capability failures stay explicit and leave a fresh write to bootstrap", async () => {
  const calls: [string, string | null][] = [];
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      calls.push([path, new Headers(init!.headers).get("X-CSRF-Token")]);
      if (path !== "/auth/capabilities") return reply();
      if (calls.length === 1) return Response.json(
        { error: { code: "POLICY_MISMATCH" }, requestId: "forbidden-capabilities" },
        { status: 403, headers: { "X-CSRF-Token": "unexpected-csrf" } },
      );
      return reply("unexpected-csrf", { methods: null });
    },
  });
  try {
    await assert.rejects(client.loginCapabilities(), {
      code: "POLICY_MISMATCH", status: 403, requestId: "forbidden-capabilities",
    });
    await assert.rejects(client.loginCapabilities(), { code: "INVALID_RESPONSE" });
    await client.request("/profile", {}, "PATCH");
    assert.deepEqual(calls, [
      ["/auth/capabilities", null], ["/auth/capabilities", null],
      ["/session", null], ["/profile", "current-csrf"],
    ]);
  } finally {
    client.close();
  }
});

test("logout and close cancel in-flight login capability reads", async () => {
  for (const action of ["logout", "close"] as const) {
    const capabilities = Promise.withResolvers<Response>();
    let signal: AbortSignal | null | undefined;
    const client = new AccountClient({
      origin,
      fetch: async (url, init) => {
        if (accountPath(url) !== "/auth/capabilities") return reply();
        signal = init!.signal;
        return capabilities.promise;
      },
    });
    try {
      const pending = client.loginCapabilities();
      const rejected = assert.rejects(pending, cancelled);
      await nextTurn();
      assert.ok(signal);
      await client[action]();
      await rejected;
      assert.equal(signal.aborted, true);
    } finally {
      capabilities.resolve(reply("unexpected-csrf", { methods: ["ACCOUNT_PASSWORD"] }));
      client.close();
    }
  }
});

test("P1-4 team and pending page reads can run together after CSRF bootstrap", { timeout: 1500 }, async () => {
  const paths = [
    "/tenant-creation-policy",
    "/tenants?limit=20",
    "/invitations?limit=20",
    "/ownership-transfers?limit=20",
  ];
  const allStarted = Promise.withResolvers<void>();
  const page = Promise.withResolvers<void>();
  const calls: string[] = [];
  const client = new AccountClient({
    origin,
    timeoutMs: 1000,
    fetch: async (url, init) => {
      const path = accountPath(url);
      calls.push(path);
      if (path === "/session") return reply();
      assert.equal(init!.method, "GET");
      assert.equal(init!.credentials, "same-origin");
      assert.equal(new Headers(init!.headers).get("Authorization"), null);
      assert.equal(new Headers(init!.headers).get("X-CSRF-Token"), null);
      if (calls.length === 5) allStarted.resolve();
      await page.promise;
      return reply("current-csrf", path);
    },
  });
  try {
    await client.session();
    const reads = Promise.all(paths.map(path => client.request<string>(path)));
    void reads.catch(() => undefined);
    await allStarted.promise;
    assert.deepEqual(calls, ["/session", ...paths]);
    page.resolve();
    assert.deepEqual(await reads, paths);
  } finally {
    page.resolve();
    client.close();
  }
});

test("tenant member reads are not blocked by slow invitation and transfer reads", async () => {
  const tenants = Promise.withResolvers<Response>();
  const slow = Promise.withResolvers<void>();
  const calls: string[] = [];
  const client = new AccountClient({
    origin,
    fetch: async url => {
      const path = accountPath(url);
      calls.push(path);
      if (path === "/tenants?limit=20") return tenants.promise;
      if (path === "/invitations?limit=20" || path === "/ownership-transfers?limit=20") await slow.promise;
      return reply();
    },
  });
  try {
    await client.session();
    const overview = ["/tenants?limit=20", "/invitations?limit=20", "/ownership-transfers?limit=20"];
    const members = client.request<string>(overview[0]).then(id => client.request(`/tenants/${id}/members?limit=10`));
    const background = Promise.all(overview.slice(1).map(path => client.request(path)));
    void members.catch(() => undefined);
    void background.catch(() => undefined);
    await nextTurn();
    assert.deepEqual(calls, ["/session", ...overview]);
    tenants.resolve(reply("current-csrf", "tenant-1"));
    await nextTurn();
    assert.deepEqual(calls, ["/session", ...overview, "/tenants/tenant-1/members?limit=10"]);
    await members;
    slow.resolve();
    await background;
  } finally {
    tenants.resolve(reply());
    slow.resolve();
    client.close();
  }
});

test("leaving a Billing subject cancels only its attached reads", async () => {
  const scope = new AbortController();
  const held = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<AbortSignal>();
  const balance = "/billing/credits/balance?ownerKind=TENANT&ownerId=team-a";
  const catalog = "/billing/catalog/plans?ownerKind=TENANT&ownerId=team-a";
  const paths: string[] = [];
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      paths.push(path);
      if (path === balance) {
        started.resolve(init!.signal!);
        return held.promise;
      }
      return reply();
    },
  });
  try {
    await client.session();
    const pending = client.request(balance, undefined, "GET", undefined, scope.signal);
    const cancelled = assert.rejects(pending, /CANCELLED/);
    const fetchSignal = await started.promise;
    await client.request(catalog, undefined, "GET", undefined, scope.signal);
    const profile = client.request("/profile", {}, "PATCH");
    scope.abort();
    await cancelled;
    assert.equal(fetchSignal.aborted, true);
    await profile;
    held.resolve(reply("stale-csrf"));
    await assert.rejects(client.request(catalog, undefined, "GET", undefined, scope.signal), /CANCELLED/);
    assert.deepEqual(paths, ["/session", balance, catalog, "/profile"]);
  } finally {
    held.resolve(reply());
    client.close();
  }
});

test("one cold bootstrap serves concurrent writes while reads proceed", async () => {
  const calls: [string, string | null][] = [];
  const bootstrap = Promise.withResolvers<Response>();
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      calls.push([path, new Headers(init!.headers).get("X-CSRF-Token")]);
      return path === "/session" ? bootstrap.promise : reply();
    },
  });
  const results = Promise.all([
    client.request("/profile", {}, "PATCH"),
    client.request("/tenant-creation-policy"),
    client.request("/tenants", {}),
  ]);
  try {
    await nextTurn();
    assert.deepEqual(calls.sort(), [["/session", null], ["/tenant-creation-policy", null]]);
    bootstrap.resolve(reply());
    await results;
    assert.deepEqual(calls.sort(), [
      ["/profile", "current-csrf"], ["/session", null],
      ["/tenant-creation-policy", null], ["/tenants", "current-csrf"],
    ]);
  } finally {
    bootstrap.resolve(reply());
    client.close();
  }
});

test("a managed write and later reads proceed while an earlier read is suspended", async () => {
  const held = Promise.withResolvers<Response>();
  const seen: string[] = [];
  const client = new AccountClient({ origin, fetch: async url => {
    const path = accountPath(url);
    seen.push(path);
    if (path === "/tenants") return held.promise;
    if (path === "/invitations") return Response.json({ error: { code: "VERSION_CONFLICT" } }, { status: 409 });
    return reply();
  }});
  try {
    await client.session();
    const early = client.request("/tenants");
    await client.request("/profile", {}, "PATCH");
    await client.request("/login-methods");
    await assert.rejects(client.request("/invitations"), /VERSION_CONFLICT/);
    assert.deepEqual(seen, ["/session", "/tenants", "/profile", "/login-methods", "/invitations"]);
    held.resolve(reply());
    await early;
  } finally {
    held.resolve(reply());
    client.close();
  }
});

test("P1-4 a late parallel response cannot restore a superseded CSRF token", async () => {
  const old = Promise.withResolvers<Response>();
  let writeCsrf: string | null = null;
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      if (path === "/session") return reply();
      if (path === "/tenant-creation-policy") return old.promise;
      if (path === "/login-methods") return reply("new-csrf");
      writeCsrf = new Headers(init!.headers).get("X-CSRF-Token");
      return reply("new-csrf");
    },
  });
  await client.session();
  const earlier = client.request("/tenant-creation-policy");
  await client.request("/login-methods");
  old.resolve(reply());
  await earlier;
  await client.request("/profile", {}, "PATCH");
  assert.equal(writeCsrf, "new-csrf");
  client.close();
});

test("a POST timeout and a network failure both leave its result unknown", async () => {
  const calls: string[] = [];
  const client = new AccountClient({
    origin,
    timeoutMs: 20,
    fetch: async (_, init) => {
      calls.push(init!.method!);
      if (init!.method === "GET") return reply();
      if (calls.length === 2) return holdUntilAbort(init!.signal!);
      throw new TypeError("offline");
    },
  });
  await assert.rejects(client.request("/tenants", { name: "Team" }), unknownResult);
  await assert.rejects(client.request("/tenants", { name: "Team" }), unknownResult);
  assert.deepEqual(calls, ["GET", "POST", "POST"]);
});

test("a timeout reading the response body leaves the result unknown and preserves CSRF", async () => {
  let bodyRead = false;
  const csrfUsed: (string | null)[] = [];
  const client = new AccountClient({
    origin,
    timeoutMs: 20,
    fetch: async (_, init) => {
      if (init!.method === "GET") return reply();
      csrfUsed.push(new Headers(init!.headers).get("X-CSRF-Token"));
      if (csrfUsed.length > 1) return reply();
      const signal = init!.signal!;
      return new Response(new ReadableStream({
        pull(stream) {
          bodyRead = true;
          if (signal.aborted) stream.error(signal.reason);
          else signal.addEventListener("abort", () => stream.error(signal.reason), { once: true });
        },
      }), { headers: { "X-CSRF-Token": "late-csrf" } });
    },
  });
  await assert.rejects(client.request("/tenants", { name: "Team" }), unknownResult);
  assert.equal(bodyRead, true);
  await client.request("/tenants", { name: "Team" });
  assert.deepEqual(csrfUsed, ["current-csrf", "current-csrf"]);
});

test("close and logout cancel in-flight requests before stale responses can take effect", async (t) => {
  for (const fence of ["close", "logout"] as const) {
    await t.test(fence, async () => {
      const started = Promise.withResolvers<void>();
      const lateBody = Promise.withResolvers<{ data: { saved: boolean } }>();
      const startedPaths: string[] = [];
      let oldSignal: AbortSignal | undefined;
      let responseHeaderRead = false;
      let nextCsrf: string | null = null;
      const client = new AccountClient({
        origin,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          startedPaths.push(path);
          if (path.endsWith("/session")) return reply();
          if (path.endsWith("/profile")) {
            oldSignal = init!.signal!;
            const late = reply("obsolete-csrf");
            late.json = () => {
              started.resolve();
              return lateBody.promise;
            };
            late.headers.get = () => {
              responseHeaderRead = true;
              return "obsolete-csrf";
            };
            return late;
          }
          nextCsrf = new Headers(init!.headers).get("X-CSRF-Token");
          return reply("logout-csrf", { localCleared: true, remoteRevocation: "CONFIRMED" });
        },
      });
      await client.session();
      const inFlight = client.request("/profile", { displayName: "Updated" }, "PATCH");
      const old = assert.rejects(inFlight, cancelled);
      await started.promise;
      if (fence === "close") client.close();
      else await client.logout();
      assert.equal(oldSignal?.aborted, true);
      lateBody.resolve({ data: { saved: true } });
      await old;
      assert.equal(responseHeaderRead, false);
      if (fence === "logout") {
        await client.request("/next", {});
        assert.equal(nextCsrf, "logout-csrf");
      }
      assert.deepEqual(startedPaths, [
        "/api/account/session",
        "/api/account/profile",
        ...(fence === "logout" ? ["/api/account/logout", "/api/account/next"] : []),
      ]);
    });
  }
});

test("a timed-out CSRF bootstrap sends no POST for writes or logout", async () => {
  for (const logout of [false, true]) {
    const methods: string[] = [];
    const client = new AccountClient({
      origin,
      timeoutMs: 20,
      fetch: async (_, init) => {
        methods.push(init!.method!);
        return holdUntilAbort(init!.signal!);
      },
    });
    await assert.rejects(logout ? client.logout() : client.request("/tenants", {}), unknownResult);
    assert.deepEqual(methods, ["GET"]);
  }
});

test("logout POST timeout is unknown and a conflict retry uses the original key", async () => {
  const keys: (string | null)[] = [];
  const client = new AccountClient({
    origin,
    timeoutMs: 20,
    fetch: async (_, init) => {
      if (init!.method === "GET") return reply();
      keys.push(new Headers(init!.headers).get("Idempotency-Key"));
      if (keys.length === 1) {
        return Response.json({ error: { code: "VERSION_CONFLICT" } }, { status: 409 });
      }
      return holdUntilAbort(init!.signal!);
    },
  });
  await assert.rejects(client.logout(), unknownResult);
  assert.ok(keys[0]);
  assert.deepEqual(keys, [keys[0], keys[0]]);
});

test("a logout superseded during bootstrap cannot adopt a newer generation", async () => {
  const waiting = Promise.withResolvers<void>();
  const oldBootstrap = Promise.withResolvers<Response>();
  const methods: string[] = [];
  const client = new AccountClient({
    origin,
    fetch: async (_, init) => {
      methods.push(init!.method!);
      if (methods.length === 1) {
        waiting.resolve();
        return oldBootstrap.promise;
      }
      return reply();
    },
  });
  const first = assert.rejects(client.logout(), cancelled);
  await waiting.promise;
  await client.logout();
  oldBootstrap.resolve(reply("obsolete-csrf"));
  await first;
  assert.deepEqual(methods, ["GET", "GET", "POST"]);
});

test("a completed logout bootstrap still fences the POST at the next generation", async (t) => {
  for (const fence of ["logout", "close"] as const) {
    await t.test(fence, async () => {
      const posts: { scope: string; csrf: string | null }[] = [];
      let bootstrapCalls = 0;
      let bootstrapAborted: boolean | undefined;
      let replacement: ReturnType<AccountClient["logout"]> | undefined;
      const client = new AccountClient({
        origin,
        fetch: async (url, init) => {
          const path = new URL(String(url)).pathname;
          if (init!.method === "GET") {
            assert.equal(path, "/api/account/session");
            bootstrapCalls++;
            const bootstrap = reply("bootstrap-csrf");
            const get = bootstrap.headers.get.bind(bootstrap.headers);
            bootstrap.headers.get = name => {
              assert.equal(name, "X-CSRF-Token");
              // The GET has passed its last generation check. Run the fence
              // after send() settles and before the old logout resumes.
              queueMicrotask(() => {
                if (fence === "logout") replacement = client.logout(true);
                else client.close();
                bootstrapAborted = init!.signal!.aborted;
              });
              return get(name);
            };
            return bootstrap;
          }
          assert.equal(init!.method, "POST");
          assert.equal(path, "/api/account/logout");
          posts.push({
            scope: JSON.parse(String(init!.body)).scope,
            csrf: new Headers(init!.headers).get("X-CSRF-Token"),
          });
          return reply("logout-csrf", { localCleared: true, remoteRevocation: "CONFIRMED" });
        },
      });
      await assert.rejects(client.logout(), cancelled);
      await replacement;
      assert.equal(bootstrapCalls, 1);
      assert.equal(bootstrapAborted, false);
      assert.deepEqual(posts, fence === "logout"
        ? [{ scope: "ALL_MOLIS_PRODUCTS", csrf: "bootstrap-csrf" }]
        : []);
    });
  }
});

test("server errors preserve code, HTTP status and request ID", async () => {
  const client = new AccountClient({
    origin,
    fetch: async () => Response.json(
      { error: { code: "FORBIDDEN" }, requestId: "request-fixture" },
      { status: 403 },
    ),
  });
  await assert.rejects(client.request("/login-methods"), {
    code: "FORBIDDEN", status: 403, requestId: "request-fixture",
  });
});

test("scoped lookups hit the cache, and mutations and account changes invalidate it", async () => {
  let account = "user-one";
  let calls = 0;
  const client = new AccountClient({
    origin,
    fetch: async url => {
      const path = accountPath(url);
      if (path === "/session") return reply("csrf", { state: "AUTHENTICATED", user: { userId: account } });
      if (path === "/tenants?limit=20") return reply("csrf", { sequence: ++calls });
      return reply();
    },
  });
  await client.session();
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 1 });
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 1 });
  await client.request("/tenants", {});
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 2 });
  account = "user-two";
  await client.session();
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 3 });
  await client.logout();
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 4 });
  assert.deepEqual(await client.request("/tenants?limit=20"), { sequence: 5 });
  client.close();
});

test("concurrent scoped reads share transport and keep other callers alive on cancellation", async () => {
  const started = Promise.withResolvers<AbortSignal>();
  const deliver = Promise.withResolvers<Response>();
  let calls = 0;
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      if (accountPath(url) === "/session")
        return reply("csrf", { state: "AUTHENTICATED", user: { userId: "one" } });
      calls++;
      started.resolve(init!.signal!);
      return deliver.promise;
    },
  });
  await client.session();
  const cancel = new AbortController();
  const first = client.request("/tenants?limit=20", undefined, "GET", undefined, cancel.signal);
  const second = client.request("/tenants?limit=20");
  const signal = await started.promise;
  cancel.abort();
  await assert.rejects(first, /CANCELLED/);
  assert.equal(signal.aborted, false);
  deliver.resolve(reply("csrf", { items: [] }));
  assert.deepEqual(await second, { items: [] });
  assert.equal(calls, 1);
});
