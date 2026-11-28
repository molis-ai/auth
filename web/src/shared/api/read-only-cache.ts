const TTL_MS = 30_000;
const MAX_ENTRIES = 64;
const CACHEABLE = new Set(["/tenants", "/tenant-creation-policy", "/login-methods", "/billing/catalog/plans"]);

type Pending = { result: Promise<unknown>; controller: AbortController; readers: number };
type Entry = { value: unknown; expires: number } | Pending;

export class ReadOnlyCache {
  private scope = "";
  private readonly entries = new Map<string, Entry>();

  setScope(scope = "") {
    if (scope === this.scope) return;
    this.scope = scope;
    this.invalidate();
  }

  read(path: string) {
    const [resource, query] = path.split("?", 2);
    if (!this.scope || !CACHEABLE.has(resource) || new URLSearchParams(query).has("cursor")) return;
    const entry = this.entries.get(path);
    if (entry && "expires" in entry) {
      if (entry.expires > Date.now()) return { hit: true as const, value: entry.value };
      this.entries.delete(path);
    }
    return { hit: false as const };
  }

  async load<T>(path: string, signal: AbortSignal, fetch: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const existing = this.entries.get(path);
    if (existing && "expires" in existing) return existing.value as T;
    if (signal.aborted) return fetch(signal);
    if (!existing && this.entries.size >= MAX_ENTRIES) {
      // Keep in-flight reads available to their callers and evict the oldest settled value.
      const oldest = Array.from(this.entries).find(([, entry]) => "expires" in entry);
      if (!oldest) return fetch(signal);
      this.entries.delete(oldest[0]);
    }
    const controller = existing?.controller ?? new AbortController();
    const forget = () => {
      if (this.entries.get(path) === entry) this.entries.delete(path);
    };
    const entry: Pending = existing ?? {
      controller,
      readers: 0,
      result: Promise.resolve().then(() => fetch(controller.signal)).then(value => {
        if (this.entries.get(path) === entry) {
          this.entries.delete(path);
          this.entries.set(path, { value, expires: Date.now() + TTL_MS });
        }
        return value;
      }, error => {
        forget();
        throw error;
      }),
    };
    this.entries.set(path, entry);
    entry.readers++;
    const cancel = () => {
      entry.readers--;
      if (entry.readers === 0) {
        forget();
        controller.abort(signal.reason);
      }
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await entry.result as T;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!signal.aborted) entry.readers--;
    }
  }

  invalidate(prefix = "") {
    for (const path of this.entries.keys()) {
      if (path.startsWith(prefix)) this.entries.delete(path);
    }
  }
}
