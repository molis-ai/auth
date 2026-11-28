import assert from "node:assert/strict";
import test from "node:test";

test("script telemetry ignores external resources and preserves Auth chunk failures", async () => {
  const origin = "https://auth.test.molis.ai";
  const handlers = new Map<string, (event: Event) => void>();
  const beacons: Blob[] = [];
  class Script {
    readonly src: string;
    constructor(src: string) { this.src = src; }
  }
  Object.assign(globalThis, {
    location: { origin, pathname: "/login", search: "" },
    document: { visibilityState: "visible", querySelector: () => ({ content: "TEST" }), addEventListener() {} },
    window: {
      addEventListener(name: string, handler: (event: Event) => void) {
        handlers.set(name, handler);
      },
    },
    HTMLScriptElement: Script,
    ErrorEvent: class extends Event {},
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { sendBeacon(_: string, body: Blob) { beacons.push(body); return true; } },
  });

  function scriptError(src: string) {
    const event = new Event("error");
    Object.defineProperty(event, "target", { value: new Script(src) });
    handlers.get("error")?.(event);
  }

  const { startBrowserTelemetry } = await import("../src/shared/telemetry.ts");
  startBrowserTelemetry();
  scriptError("https://static.cloudflareinsights.com/beacon.js");
  scriptError(`${origin}/auth-ui/assets/login.js`);
  const preload = new Event("vite:preloadError");
  Object.defineProperty(preload, "payload", { value: new TypeError("private fixture detail") });
  handlers.get(preload.type)?.(preload);
  handlers.get("pagehide")?.(new Event("pagehide"));

  const body = await beacons[0].text();
  const errors = JSON.parse(body).filter((event: { kind: string }) => event.kind === "error");
  assert.deepEqual(errors.map((event: { error_kind: string; name: string }) => [event.error_kind, event.name]), [
    ["chunk_load", "Other"],
    ["chunk_load", "TypeError"],
  ]);
  assert.ok(!body.includes("private fixture detail"));
});
