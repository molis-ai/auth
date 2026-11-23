import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorCollection } from "../src/cursor-collection.ts";

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
  collection.remove(item => item === "first");
  assert.deepEqual(collection.items.value, ["second"]);
});

test("a late page from a previous tenant cannot replace the current selection", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const collection = cursorCollection<string>({
    async request<T>(path: string) {
      if (path.includes("old")) await pending;
      return { items: [path], nextCursor: null } as T;
    },
  });
  const old = collection.first("/tenants/old/members");
  collection.clear();
  await collection.first("/tenants/current/members", 50);
  release();
  assert.equal(await old, false);
  assert.deepEqual(collection.items.value, ["/tenants/current/members?limit=50"]);
  assert.equal(collection.loading.value, false);
});
