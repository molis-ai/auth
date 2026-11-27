const TTL_MS = 30_000;
const CACHEABLE = new Set(["/tenants", "/tenant-creation-policy", "/login-methods", "/billing/catalog/plans"]);

export class ReadOnlyCache {
  private scope = "";
  private epoch = 0;
  private readonly entries = new Map<string, { value: unknown; expires: number }>();

  setScope(scope = "") {
    if (scope === this.scope) return;
    this.scope = scope;
    this.invalidate();
  }

  read(path: string) {
    const [resource, query] = path.split("?", 2);
    if (!this.scope || !CACHEABLE.has(resource) || new URLSearchParams(query).has("cursor")) return;
    const key = this.scope + "\n" + path;
    const entry = this.entries.get(key);
    if (entry && entry.expires > Date.now()) return { hit: true as const, value: entry.value };
    if (entry) this.entries.delete(key);
    const epoch = this.epoch;
    return {
      hit: false as const,
      remember: (value: unknown) => {
        if (epoch === this.epoch) this.entries.set(key, { value, expires: Date.now() + TTL_MS });
      },
    };
  }

  invalidate(prefix = "") {
    this.epoch++;
    for (const key of this.entries.keys()) {
      const path = key.slice(key.indexOf("\n") + 1);
      if (path.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
