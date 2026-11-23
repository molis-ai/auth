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
const holdUntilAbort = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
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
