import assert from "node:assert/strict";
import { test } from "node:test";
import { effectScope } from "vue";
import { cursorCollection } from "../src/lib/cursor-collection.ts";

test("collections request one page at a time and retry the same cursor after failure", async () => {
  const calls: string[] = [];
  let fail = true;
  const collection = cursorCollection<string>({
    async request<T>(path: string) {
      calls.push(path);
      if (path.includes("cursor") && fail) throw Error("network");
      return (path.includes("cursor")
        ? { items: ["second"], nextCursor: null }
        : { items: ["first"], nextCursor: "cursor-one" }) as T;
    },
  });
  await collection.first("/tenants", 10);
  assert.deepEqual(calls, ["/tenants?limit=10"]);
  await assert.rejects(collection.more(), /network/);
  assert.deepEqual(collection.items.value, ["first"]);
  assert.equal(collection.loading.value, false);
  fail = false;
  assert.equal(await collection.more(), true);
  assert.equal(await collection.more(), false);
  assert.deepEqual(calls.slice(1), Array(2).fill("/tenants?limit=10&cursor=cursor-one"));
  assert.deepEqual(collection.pages.value.map(page => page.items), [["first"], ["second"]]);
  collection.replace(item => item === "second", "updated");
  collection.remove(item => item === "first");
  assert.deepEqual(collection.items.value, ["updated"]);
});

test("a late page from a previous tenant cannot replace the current selection", async () => {
  let release!: () => void;
  let previousSignal: AbortSignal | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const collection = cursorCollection<string>({
    async request<T>(path: string, _body?: unknown, _method?: string, _key?: string, signal?: AbortSignal) {
      if (path.includes("old")) {
        previousSignal = signal;
        await pending;
      }
      return { items: [path], nextCursor: null } as T;
    },
  });
  const old = collection.first("/tenants/old/members");
  await collection.first("/tenants/current/members", 50);
  assert.equal(previousSignal?.aborted, true);
  release();
  assert.equal(await old, false);
  assert.deepEqual(collection.items.value, ["/tenants/current/members?limit=50"]);
  assert.equal(collection.loading.value, false);
});


test("disposing a collection aborts its pending requests", async () => {
  const scope = effectScope();
  let signal: AbortSignal | undefined;
  const collection = scope.run(() => cursorCollection({
    async request<T>(_path: string, _body?: unknown, _method?: string, _key?: string, abort?: AbortSignal) {
      signal = abort;
      await new Promise<void>((_, reject) => abort?.addEventListener("abort", () => reject(abort.reason), { once: true }));
      return { items: [], nextCursor: null } as T;
    },
  }))!;
  const pending = collection.first("/platform/tenants");
  scope.stop();
  assert.equal(signal?.aborted, true);
  assert.equal(await pending, false);
  assert.equal(collection.loading.value, false);
});
