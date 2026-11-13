import test from "node:test";
import assert from "node:assert/strict";
import { AuthFlow, FlowCancelled } from "../src/auth-flow.ts";
for (const outcome of ["resolve", "reject"] as const)
  test(`cancel fences a delayed ${outcome} and leaves the next operation usable`, async () => {
    const flow = new AuthFlow();
    let resolve!: (value: { handle: string }) => void,
      reject!: (reason: Error) => void;
    const discarded: string[] = [];
    const pending = flow.request(
      () =>
        new Promise<{ handle: string }>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      async (value) => {
        discarded.push(value.handle);
      },
    );
    const assertion = assert.rejects(pending, FlowCancelled);
    flow.cancel();
    assert.equal(await flow.request(async () => "new"), "new");
    if (outcome === "resolve") resolve({ handle: "old" });
    else reject(Error("old failure"));
    await assertion;
    assert.deepEqual(discarded, outcome === "resolve" ? ["old"] : []);
  });
test("dispose closes the owned window, cancels its poll and refuses later delivery", async () => {
  const flow = new AuthFlow();
  let closed = 0,
    polls = 0;
  flow.open({
    closed: false,
    opener: null,
    close() {
      closed++;
    },
  } as Window);
  flow.schedule(async () => {
    polls++;
  }, 0);
  flow.dispose();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, 1);
  assert.equal(polls, 0);
  await assert.rejects(
    flow.request(async () => 1),
    FlowCancelled,
  );
});
