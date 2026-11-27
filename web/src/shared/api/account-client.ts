/** V2 product client. Central credentials and proofs belong to the same-origin Host/BFF. */
export interface AccountView {
  state: "ANONYMOUS" | "AUTHENTICATED" | "OFFLINE_CACHED" | "EXPIRED";
  user?: {
    userId: string;
    displayName: string;
    email?: string | null;
    avatarUrl: string | null;
    version: number;
  };
  capabilities?: string[];
}
export interface ClientOptions {
  origin?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export class AuthError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  constructor(code: string, status = 0, requestId = "") {
    super(code);
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}
const TIMEOUT = Symbol("timeout");
const CANCEL = Symbol("cancel");
const LOGIN_CAPABILITIES_PATH = "/auth/capabilities";

// The BFF marks conflicts before dispatch when a retry cannot replay a cursor write.
class ConflictBeforeDispatch extends AuthError {
  constructor(requestId: string) {
    super("VERSION_CONFLICT", 409, requestId);
  }
}

interface ReadBatch {
  after: Promise<void>;
  firstAttempts: Set<Promise<unknown>>;
}

function isIdempotentRead(path: string): boolean {
  return path === "/tenant-creation-policy" ||
    path === "/login-methods" ||
    path === "/login-sessions" ||
    /^\/tenants\/[A-Za-z0-9_-]+$/.test(path) ||
    /^\/platform\/tenants\/[A-Za-z0-9_-]+$/.test(path);
}

function isConcurrentFirstPage(path: string): boolean {
  // First pages can issue a separate cursor. Only a conflict before dispatch
  // warrants retrying one.
  const query = path.indexOf("?");
  const resource = query === -1 ? path : path.slice(0, query);
  if (query !== -1) {
    const params = new URLSearchParams(path.slice(query));
    if (params.has("cursor")) return false;
    if (!/^\/platform\/(audit-events|tenants|users)$/.test(resource) &&
        !/^\?limit=([1-9][0-9]?|100)$/.test(path.slice(query))) return false;
  }
  // These console collections also use web_session::read_without_lease.
  return /^\/(tenants|invitations|ownership-transfers|platform\/(applications|users|tenants|audit-events))$/.test(resource) ||
    /^\/tenants\/[A-Za-z0-9_-]+\/(members|invitations)$/.test(resource) ||
    /^\/platform\/(applications\/[A-Za-z0-9_-]+\/clients|users\/[A-Za-z0-9_-]+\/permissions|tenants\/[A-Za-z0-9_-]+\/members)$/.test(resource);
}

function isBillingRead(path: string): boolean {
  // All Billing GET routes use the Auth session's read-without-lease path.
  return path.startsWith("/billing/");
}

function settled(result: Promise<unknown>): Promise<void> {
  return result.then(() => undefined, () => undefined);
}

function retryDelay(signal: AbortSignal, attempt: number): Promise<void> {
  if (signal.aborted) return Promise.reject(new AuthError("CANCELLED"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, 40 * (attempt + 1));
    const cancel = () => {
      clearTimeout(timer);
      reject(new AuthError("CANCELLED"));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export class AccountClient {
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly timeout: number;
  private closed = false;
  private csrf = "";
  private generation = 0;
  private readonly pending = new Set<AbortController>();
  private readonly reads = new Set<Promise<void>>();
  private readBatch: ReadBatch = { after: Promise.resolve(), firstAttempts: new Set() };
  constructor(options: ClientOptions = {}) {
    this.origin = options.origin ?? globalThis.location?.origin ?? "";
    const url = new URL(this.origin);
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new AuthError("INVALID_CONFIGURATION");
    if (globalThis.location && globalThis.location.origin !== this.origin)
      throw new AuthError("SAME_ORIGIN_REQUIRED");
    this.timeout = options.timeoutMs ?? 15000;
    if (
      !Number.isFinite(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 120000
    )
      throw new AuthError("INVALID_CONFIGURATION");
    this.transport = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  session(): Promise<AccountView> {
    return this.request<AccountView>("/session");
  }
  async loginCapabilities(): Promise<{ methods: string[] }> {
    const data = await this.request<{ methods: string[] }>(LOGIN_CAPABILITIES_PATH);
    if (!Array.isArray(data?.methods) || data.methods.some(method => typeof method !== "string"))
      throw new AuthError("INVALID_RESPONSE");
    return data;
  }
  request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    key?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new AuthError("CANCELLED"));
    const pathname = path.split("?", 1)[0];
    if (
      !/^\/[A-Za-z0-9/_%.-]+(?:\?[A-Za-z0-9/_?=&%+.-]*)?$/.test(path) ||
      /\.\.|%2e|%2f|%5c/i.test(pathname) ||
      path.startsWith("//") ||
      !["GET", "POST", "PATCH"].includes(method)
    )
      return Promise.reject(new AuthError("INVALID_REQUEST"));
    const get = method === "GET" && body === undefined && key === undefined;
    // Capabilities are independent of the browser session and its write queue.
    if (get && path === LOGIN_CAPABILITIES_PATH) {
      return this.track(Promise.resolve(), (generation, signal) =>
        this.send<T>(path, body, method, generation, signal),
        signal,
      );
    }
    const idempotent = get && isIdempotentRead(path);
    const predispatchRetry = get && (isConcurrentFirstPage(path) || isBillingRead(path));
    // Session can create a browser session when its cookie
    // expires, even when the client still holds a CSRF token.
    const concurrent = Boolean(this.csrf) && (idempotent || predispatchRetry);
    const mayRetry = idempotent || (get && path === "/session");
    // Exclusive operations wait for the reads already queued. Later reads
    // wait for that operation, so an account write cannot overtake a read.
    const batch = this.readBatch;
    const ready = concurrent ? batch.after : Promise.all([batch.after, ...this.reads]);
    const result = this.track(ready, async (generation, signal) => {
      if (method !== "GET" && !this.csrf)
        await this.send("/session", undefined, "GET", generation, signal);
      for (let attempt = 0; ; attempt++) {
        const sent = this.send<T>(path, body, method, generation, signal, key);
        if (concurrent && attempt === 0) {
          batch.firstAttempts.add(sent);
          const remove = () => batch.firstAttempts.delete(sent);
          void sent.then(remove, remove);
        }
        try {
          return await sent;
        } catch (error) {
          const beforeDispatch = error instanceof ConflictBeforeDispatch;
          if (!(error instanceof AuthError) || error.status !== 409 ||
              error.code !== "VERSION_CONFLICT" || attempt >= 3 ||
              !(mayRetry || (predispatchRetry && beforeDispatch))) throw error;
          this.checkGeneration(generation);
          // Give the request holding the refresh lease time to finish, even
          // when refresh takes longer than the backoff. Waiting only for first
          // attempts keeps all retries independent of each other.
          if (concurrent && attempt === 0 && beforeDispatch) {
            await Promise.allSettled(batch.firstAttempts);
            this.checkGeneration(generation);
          }
          await retryDelay(signal, attempt);
        }
      }
    }, signal);
    const barrier = settled(result);
    if (concurrent) {
      this.reads.add(barrier);
      void barrier.then(() => this.reads.delete(barrier));
    } else {
      this.readBatch = { after: barrier, firstAttempts: new Set() };
    }
    return result;
  }
  async logout(
    all = false,
  ): Promise<{
    localCleared: boolean;
    remoteRevocation: "CONFIRMED" | "UNCONFIRMED";
  }> {
    if (this.closed) throw new AuthError("CANCELLED");
    const previous = [...this.pending];
    this.generation++;
    this.reads.clear();
    // Logout fences in-flight responses and reaches the server without waiting for old work.
    const result = this.track(Promise.resolve(), async (generation, signal) => {
      if (!this.csrf)
        await this.send("/session", undefined, "GET", generation, signal);
      const key = crypto.randomUUID();
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.send<{
            localCleared: boolean;
            remoteRevocation: "CONFIRMED" | "UNCONFIRMED";
          }>(
            "/logout",
            { scope: all ? "ALL_MOLIS_PRODUCTS" : "CURRENT_LOGIN" },
            "POST",
            generation,
            signal,
            key,
          );
        } catch (error) {
          if (!(error instanceof AuthError) || error.code !== "VERSION_CONFLICT" || attempt >= 3) throw error;
          // Another tab may finish a profile save while logout reads the current session.
          // Keep the original generation so a superseded logout cannot affect a new account.
        }
      }
    });
    this.readBatch = { after: settled(result), firstAttempts: new Set() };
    for (const controller of previous) controller.abort(CANCEL);
    return result;
  }
  close(): void {
    this.closed = true;
    this.generation++;
    for (const controller of this.pending) controller.abort(CANCEL);
  }
  private checkGeneration(generation: number): void {
    if (this.closed || generation !== this.generation)
      throw new AuthError("CANCELLED");
  }
  private async track<T>(
    ready: Promise<unknown>,
    run: (generation: number, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const generation = this.generation;
    const controller = new AbortController();
    this.pending.add(controller);
    const cancellation = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new AuthError("CANCELLED")), { once: true });
    });
    const cancel = () => controller.abort(CANCEL);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const work = ready.then(() => {
      this.checkGeneration(generation);
      if (controller.signal.aborted) throw new AuthError("CANCELLED");
      return run(generation, controller.signal);
    });
    try {
      const result = await Promise.race([work, cancellation]);
      this.checkGeneration(generation);
      return result;
    } finally {
      signal?.removeEventListener("abort", cancel);
      this.pending.delete(controller);
    }
  }
  private async send<T>(
    path: string,
    body: unknown,
    method: string,
    generation: number,
    signal: AbortSignal,
    key?: string,
  ): Promise<T> {
    this.checkGeneration(generation);
    if (signal.aborted) throw new AuthError("CANCELLED");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(TIMEOUT), this.timeout);
    const cancel = () => {
      clearTimeout(timer);
      controller.abort(CANCEL);
    };
    signal.addEventListener("abort", cancel, { once: true });
    const sentCsrf = this.csrf;
    try {
      const response = await this.transport(
        this.origin + "/api/account" + path,
        {
          method,
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            ...(method === "GET"
              ? {}
              : {
                  "Content-Type": "application/json",
                  "X-CSRF-Token": sentCsrf,
                }),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      this.checkGeneration(generation);
      controller.signal.throwIfAborted();
      const reply = await response.json();
      this.checkGeneration(generation);
      controller.signal.throwIfAborted();
      const csrf = response.headers.get("X-CSRF-Token");
      // Another response may already have supplied a newer token.
      if (path !== LOGIN_CAPABILITIES_PATH && csrf && this.csrf === sentCsrf) this.csrf = csrf;
      if (!response.ok) {
        const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(reply?.error?.code ?? "")
          ? reply.error.code : "AUTH_UNAVAILABLE";
        const requestId = typeof reply?.requestId === "string" ? reply.requestId : "";
        if (method === "GET" && response.status === 409 && code === "VERSION_CONFLICT" &&
            response.headers.get("Retry-After") === "0") {
          throw new ConflictBeforeDispatch(requestId);
        }
        throw new AuthError(code, response.status, requestId);
      }
      if (!reply || !Object.hasOwn(reply, "data"))
        throw new AuthError("INVALID_RESPONSE");
      return reply.data as T;
    } catch (error) {
      this.checkGeneration(generation);
      if (controller.signal.reason === CANCEL) throw new AuthError("CANCELLED");
      if (controller.signal.reason === TIMEOUT) throw new AuthError("RESULT_UNKNOWN");
      if (error instanceof AuthError) throw error;
      throw new AuthError("RESULT_UNKNOWN");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
}
