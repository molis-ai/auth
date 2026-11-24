import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/lib/account-client.ts";
test("V2U-07 client uses same-origin cookies/CSRF and never installs bearer credentials", async () => {
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
test("V2U-07 canceled generation cannot deliver a late login result", async () => {
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

test("AUTH-CYCLE-06 session conflicts retry within bounds and cancellation fences the retry", async () => {
  let calls = 0;
  const client = new AccountClient({origin:"http://127.0.0.1:8787",fetch:async()=>{
    calls++;
    return calls < 3 ? Response.json({error:{code:"VERSION_CONFLICT"}},{status:409}) : Response.json({data:{state:"ANONYMOUS"}});
  }});
  assert.equal((await client.session()).state,"ANONYMOUS");
  assert.equal(calls,3);
  client.close();
  let rejectedCalls=0;
  const rejected=new AccountClient({origin:"http://127.0.0.1:8787",fetch:async()=>{rejectedCalls++;return Response.json({error:{code:"VERSION_CONFLICT"}},{status:409});}});
  await assert.rejects(rejected.session(),/VERSION_CONFLICT/);
  assert.equal(rejectedCalls,4);
  rejected.close();
  let cancelledCalls=0;
  const cancelled=new AccountClient({origin:"http://127.0.0.1:8787",fetch:async()=>{cancelledCalls++;return Response.json({error:{code:"VERSION_CONFLICT"}},{status:409});}});
  const pending=cancelled.session();
  await new Promise(resolve=>setTimeout(resolve,10));cancelled.close();
  await assert.rejects(pending,/CANCELLED/);assert.equal(cancelledCalls,1);
});

const origin = "http://127.0.0.1:8787";
const reply = (csrf = "current-csrf", data: unknown = { state: "ANONYMOUS" }) =>
  Response.json({ data }, { headers: { "X-CSRF-Token": csrf } });
const unknownResult = { code: "RESULT_UNKNOWN", status: 0, requestId: "" };
const cancelled = { code: "CANCELLED", status: 0, requestId: "" };
const conflict = { code: "VERSION_CONFLICT", status: 409, requestId: "conflict-id" };
const conflictBeforeDispatch = () => Response.json(
  { error: { code: conflict.code }, requestId: conflict.requestId },
  { status: conflict.status, headers: { "Retry-After": "0" } },
);
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

test("P1-4 tenant overview starts four first-page GETs together after CSRF bootstrap", { timeout: 1500 }, async () => {
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

test("tenant members start when tenants completes while invitations and transfers are still pending", async () => {
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

test("new console collections retry only marked conflicts on their first pages", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const resources = [
    "/tenants/t-1/members", "/tenants/t-1/invitations", "/subscriptions", "/platform/applications",
    "/platform/applications/app-1/clients", "/platform/users", "/platform/users/user-1/permissions",
  ];
  const paths = resources.map((path, index) => index % 2 === 0 ? path : `${path}?limit=100`);
  const calls = new Map<string, number>();
  const client = new AccountClient({
    origin,
    fetch: async url => {
      const path = accountPath(url);
      const count = (calls.get(path) ?? 0) + 1;
      calls.set(path, count);
      if (path === "/session" || count > 1) return reply();
      if (path.endsWith("?limit=25")) {
        return Response.json({ error: { code: conflict.code }, requestId: conflict.requestId }, { status: conflict.status });
      }
      return conflictBeforeDispatch();
    },
  });
  try {
    await client.session();
    const requests = Promise.all(paths.map(path => client.request(path)));
    void requests.catch(() => undefined);
    await nextTurn();
    assert.deepEqual([...calls], [["/session", 1], ...paths.map(path => [path, 1])]);
    t.mock.timers.tick(40);
    await requests;
    assert.deepEqual([...calls], [["/session", 1], ...paths.map(path => [path, 2])]);
    for (const resource of resources) {
      for (const query of ["?limit=25", "?limit=100&cursor=opaque"]) {
        const path = resource + query;
        await assert.rejects(client.request(path), conflict);
        assert.equal(calls.get(path), 1);
      }
    }
  } finally {
    client.close();
  }
});

test("P1-4 one cold bootstrap orders the queued writes and read", async () => {
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
    assert.deepEqual(calls, [["/session", null]]);
    bootstrap.resolve(reply());
    await results;
    assert.deepEqual(calls, [
      ["/session", null], ["/profile", "current-csrf"],
      ["/tenant-creation-policy", null], ["/tenants", "current-csrf"],
    ]);
  } finally {
    bootstrap.resolve(reply());
    client.close();
  }
});

test("P1-4 an exclusive operation waits for earlier reads and holds later reads", async (t) => {
  for (const exclusive of [
    { path: "/profile", method: "PATCH", body: {} },
    { path: "/tenants?limit=20&cursor=opaque", method: "GET" },
    { path: "/auth/transactions/handle", method: "GET" },
    { path: "/session", method: "GET" },
  ]) {
    await t.test(exclusive.path, async () => {
      const before = Promise.withResolvers<Response>();
      const during = Promise.withResolvers<Response>();
      const calls: string[] = [];
      const client = new AccountClient({
        origin,
        fetch: async url => {
          const path = accountPath(url);
          calls.push(path);
          if (calls.length === 1) return reply();
          if (path === "/tenant-creation-policy") return before.promise;
          if (path === exclusive.path) return during.promise;
          return reply();
        },
      });
      await client.session();
      const readBefore = client.request("/tenant-creation-policy");
      const operation = client.request(exclusive.path, exclusive.body, exclusive.method);
      const readAfter = client.request("/login-methods");
      const all = Promise.all([readBefore, operation, readAfter]);
      void all.catch(() => undefined);
      try {
        await nextTurn();
        assert.deepEqual(calls, ["/session", "/tenant-creation-policy"]);
        before.resolve(reply());
        await nextTurn();
        assert.deepEqual(calls, ["/session", "/tenant-creation-policy", exclusive.path]);
        during.resolve(reply());
        await all;
        assert.deepEqual(calls, ["/session", "/tenant-creation-policy", exclusive.path, "/login-methods"]);
      } finally {
        before.resolve(reply());
        during.resolve(reply());
        client.close();
      }
    });
  }
});

test("P1-4 HTTP 409 retry requires an eligible GET and its expected code and marker", async () => {
  const calls = new Map<string, number>();
  const client = new AccountClient({
    origin,
    fetch: async (url, init) => {
      const path = accountPath(url);
      const count = (calls.get(path) ?? 0) + 1;
      calls.set(path, count);
      if (path === "/session" || (path === "/tenant-creation-policy" && count === 2)) return reply();
      assert.equal(init!.method, path === "/profile" ? "PATCH" : "GET");
      if (path === "/profile" || path.includes("cursor=") || path === "/auth/transactions/handle")
        return conflictBeforeDispatch();
      const status = path === "/tenants/wrong-status" ? 503 : 409;
      const code = path === "/tenants/wrong-code" || path.startsWith("/ownership-transfers")
        ? "IDEMPOTENCY_CONFLICT" : conflict.code;
      const headers = path.startsWith("/invitations") ? { "Retry-After": "1" }
        : path.startsWith("/ownership-transfers") ? { "Retry-After": "0" } : undefined;
      return Response.json({ error: { code }, requestId: conflict.requestId }, { status, headers });
    },
  });
  await client.session();
  await Promise.all([
    client.request("/tenant-creation-policy"),
    assert.rejects(client.request("/login-methods"), conflict),
    assert.rejects(client.request("/tenants?limit=20"), conflict),
    assert.rejects(client.request("/invitations?limit=20"), conflict),
    assert.rejects(client.request("/ownership-transfers?limit=20"), { ...conflict, code: "IDEMPOTENCY_CONFLICT" }),
    assert.rejects(client.request("/tenants?limit=20&cursor=opaque"), conflict),
    assert.rejects(client.request("/auth/transactions/handle"), conflict),
    assert.rejects(client.request("/profile", {}, "PATCH"), conflict),
    assert.rejects(client.request("/tenants/wrong-status"), { ...conflict, status: 503 }),
    assert.rejects(client.request("/tenants/wrong-code"), { ...conflict, code: "IDEMPOTENCY_CONFLICT" }),
  ]);
  assert.deepEqual(calls, new Map([
    ["/session", 1], ["/tenant-creation-policy", 2], ["/login-methods", 4],
    ["/tenants?limit=20", 1], ["/invitations?limit=20", 1],
    ["/ownership-transfers?limit=20", 1], ["/tenants?limit=20&cursor=opaque", 1],
    ["/auth/transactions/handle", 1], ["/profile", 1],
    ["/tenants/wrong-status", 1], ["/tenants/wrong-code", 1],
  ]));
  client.close();
});

test("P1-4 marked first-page conflicts wait out a slow in-flight refresh", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refresh = Promise.withResolvers<Response>();
  const calls: string[] = [];
  const paths = [
    "/tenant-creation-policy", "/tenants?limit=20", "/invitations?limit=20", "/ownership-transfers?limit=20",
  ];
  let refreshed = false;
  const client = new AccountClient({
    origin,
    fetch: async url => {
      const path = accountPath(url);
      calls.push(path);
      if (path === "/session") return reply();
      if (path === "/tenant-creation-policy") return refresh.promise;
      return refreshed ? reply("current-csrf", path) : conflictBeforeDispatch();
    },
  });
  await client.session();
  const reads = Promise.all(paths.map(path => client.request(path)));
  void reads.catch(() => undefined);
  try {
    await nextTurn();
    assert.deepEqual(calls, ["/session", ...paths]);
    t.mock.timers.tick(1000);
    await nextTurn();
    assert.deepEqual(calls, ["/session", ...paths]);
    refreshed = true;
    refresh.resolve(reply("current-csrf", paths[0]));
    await nextTurn();
    t.mock.timers.tick(40);
    assert.deepEqual(await reads, paths);
    assert.deepEqual(calls.slice(paths.length + 1).sort(), paths.slice(1).sort());
  } finally {
    refresh.resolve(reply());
    client.close();
  }
});

test("P1-4 a whole batch of marked conflicts retries within bounds before later operations", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: string[] = [];
  const paths = ["/tenants", "/invitations"];
  const client = new AccountClient({
    origin,
    fetch: async url => {
      const path = accountPath(url);
      calls.push(path);
      return paths.includes(path) ? conflictBeforeDispatch() : reply();
    },
  });
  await client.session();
  const results = Promise.all([
    ...paths.map(path => assert.rejects(client.request(path), conflict)),
    client.request("/profile", {}, "PATCH"),
    client.request("/login-methods"),
  ]);
  void results.catch(() => undefined);
  try {
    for (const delay of [40, 80, 120]) {
      await nextTurn();
      t.mock.timers.tick(delay);
    }
    await results;
    assert.deepEqual(calls.slice(0, 3), ["/session", ...paths]);
    assert.deepEqual(calls.slice(-2), ["/profile", "/login-methods"]);
    assert.deepEqual(calls.slice(3, -2).sort(), [...paths, ...paths, ...paths].sort());
  } finally {
    client.close();
  }
});

test("P1-4 close and logout cancel network, queued and retrying requests immediately", async (t) => {
  for (const fence of ["close", "logout"] as const) {
    await t.test(fence, async subtest => {
      subtest.mock.timers.enable({ apis: ["setTimeout"] });
      const lateFetch = Promise.withResolvers<Response>();
      const lateJson = Promise.withResolvers<{ data: unknown }>();
      const logoutReply = Promise.withResolvers<Response>();
      const signals: AbortSignal[] = [];
      const calls: string[] = [];
      const reads = ["/session", "/tenants", "/login-methods", "/tenants/waiting", "/invitations"];
      let oldResponseParsed = false;
      let oldHeaderRead = false;
      let writeCsrf: string | null = null;
      const old = reply("obsolete-csrf");
      old.headers.get = () => {
        oldHeaderRead = true;
        return "obsolete-csrf";
      };
      const client = new AccountClient({
        origin,
        fetch: async (url, init) => {
          const path = accountPath(url);
          calls.push(path);
          if (path === "/session") return reply();
          if (path === "/logout") return logoutReply.promise;
          if (path === "/tenants") {
            signals.push(init!.signal!);
            return lateFetch.promise;
          }
          if (path === "/login-methods") {
            signals.push(init!.signal!);
            old.json = () => lateJson.promise;
            return old;
          }
          if (path === "/tenants/waiting") {
            return Response.json({ error: { code: "VERSION_CONFLICT" } }, { status: 409 });
          }
          if (path === "/invitations") return conflictBeforeDispatch();
          writeCsrf = new Headers(init!.headers).get("X-CSRF-Token");
          return reply("logout-csrf");
        },
      });
      await client.session();
      const requests = [
        client.request("/tenants"),
        client.request("/login-methods"),
        client.request("/tenants/waiting"),
        client.request("/invitations"),
        client.request("/profile", {}, "PATCH"),
        client.request("/tenant-creation-policy"),
      ];
      const rejected = Promise.all(requests.map(request => assert.rejects(request, cancelled)));
      void rejected.catch(() => undefined);
      try {
        await nextTurn();
        assert.deepEqual(calls, reads);
        if (fence === "close") client.close();
        else {
          const signingOut = client.logout();
          const newWrite = client.request("/profile", {}, "PATCH");
          await nextTurn();
          assert.deepEqual(calls, [...reads, "/logout"]);
          logoutReply.resolve(reply("logout-csrf"));
          await Promise.all([signingOut, newWrite]);
          assert.equal(writeCsrf, "logout-csrf");
        }
        assert.ok(signals.every(signal => signal.aborted));
        await rejected;
        const late = reply("older-csrf");
        late.json = async () => { oldResponseParsed = true; };
        lateFetch.resolve(late);
        lateJson.resolve({ data: { private: true } });
        subtest.mock.timers.tick(500);
        await nextTurn();
        assert.equal(oldResponseParsed, false);
        assert.equal(oldHeaderRead, false);
        assert.deepEqual(calls, [
          ...reads,
          ...(fence === "logout" ? ["/logout", "/profile"] : []),
        ]);
      } finally {
        client.close();
        lateFetch.resolve(reply());
        lateJson.resolve({ data: null });
        logoutReply.resolve(reply());
      }
    });
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

test("close and logout cancel in-flight and queued requests before stale responses can take effect", async (t) => {
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
      const queued = client.request("/tenants", { name: "Never sent" });
      const old = Promise.all([
        assert.rejects(inFlight, cancelled),
        assert.rejects(queued, cancelled),
      ]);
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
