import test from "node:test";
import assert from "node:assert/strict";
import { AccountClient } from "../src/index.ts";
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
