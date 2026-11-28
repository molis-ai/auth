import { ReadOnlyCache } from "./read-only-cache.ts";
import { reportApiIssue, reportCache } from "../telemetry.ts";

/** Same-origin account client. Central credentials and proofs belong to the same-origin Host/BFF. */
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

export class AccountClient {
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly timeout: number;
  private closed = false;
  private csrf = "";
  private generation = 0;
  private readonly readCache = new ReadOnlyCache();
  private readonly pending = new Set<AbortController>();
  private bootstrap?: Promise<AccountView>;
  private signout?: Promise<unknown>;
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
    if (!this.csrf && !this.signout) return this.bootstrapSession();
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
    const signout = path === LOGIN_CAPABILITIES_PATH ? undefined : this.signout;
    return this.track(async (generation, signal) => {
      if (signout) await signout;
      this.checkGeneration(generation);
      if (method !== "GET" && !this.csrf) await this.bootstrapSession();
      const cached = method === "GET" && body === undefined && !key ? this.readCache.read(path) : undefined;
      if (cached) reportCache(path, cached.hit);
      if (cached?.hit) return cached.value as T;
      const fetch = (requestSignal: AbortSignal) => this.send<T>(path, body, method, generation, requestSignal, key);
      return cached ? this.readCache.load(path, signal, fetch) : fetch(signal);
    }, signal);
  }

  peekRead<T>(path: string): T | undefined {
    const cached = this.readCache.read(path);
    return cached?.hit ? cached.value as T : undefined;
  }

  hasCachedRead(path: string): boolean {
    return this.readCache.read(path)?.hit === true;
  }

  invalidateReads(prefix = ""): void {
    this.readCache.invalidate(prefix);
  }

  private accountScope(view: AccountView | undefined): void {
    this.readCache.setScope(view?.state === "AUTHENTICATED" ? view.user?.userId : undefined);
  }

  private bootstrapSession(): Promise<AccountView> {
    if (this.bootstrap) return this.bootstrap;
    const bootstrap = this.track((generation, signal) =>
      this.send<AccountView>("/session", undefined, "GET", generation, signal),
    );
    this.bootstrap = bootstrap;
    const clear = () => { if (this.bootstrap === bootstrap) this.bootstrap = undefined; };
    void bootstrap.then(clear, clear);
    return bootstrap;
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
    this.bootstrap = undefined;
    this.readCache.setScope();
    // Logout fences in-flight responses and reaches the server without waiting for old work.
    const result = this.track(async (generation, signal) => {
      if (!this.csrf) await this.bootstrapSession();
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
          // A refresh can replace the session revision before logout commits.
        }
      }
    });
    this.signout = result;
    const clear = () => { if (this.signout === result) this.signout = undefined; };
    void result.then(clear, clear);
    for (const controller of previous) controller.abort(CANCEL);
    return result;
  }
  close(): void {
    this.closed = true;
    this.readCache.setScope();
    this.generation++;
    for (const controller of this.pending) controller.abort(CANCEL);
  }
  private checkGeneration(generation: number): void {
    if (this.closed || generation !== this.generation)
      throw new AuthError("CANCELLED");
  }
  private async track<T>(
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
    const work = Promise.resolve().then(() => {
      this.checkGeneration(generation);
      if (controller.signal.aborted) throw new AuthError("CANCELLED");
      return run(generation, controller.signal);
    });
    void work.catch(() => undefined);
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
    const started = performance.now();
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
      const reply = await response.json().catch(() => {
        throw new AuthError(response.ok ? "INVALID_RESPONSE" : "AUTH_UNAVAILABLE",
          response.status, response.headers.get("X-Request-ID") ?? "");
      });
      this.checkGeneration(generation);
      controller.signal.throwIfAborted();
      const csrf = response.headers.get("X-CSRF-Token");
      // Another response may already have supplied a newer token.
      if (path !== LOGIN_CAPABILITIES_PATH && csrf && this.csrf === sentCsrf) this.csrf = csrf;
      if (!response.ok) {
        if (response.status === 401) this.readCache.setScope();
        const code = /^[A-Z][A-Z0-9_]{1,63}$/.test(reply?.error?.code ?? "")
          ? reply.error.code : "AUTH_UNAVAILABLE";
        const requestId = typeof reply?.requestId === "string" ? reply.requestId : "";
        throw new AuthError(code, response.status, requestId);
      }
      if (!reply || !Object.hasOwn(reply, "data"))
        throw new AuthError("INVALID_RESPONSE");
      if (path === "/session") this.accountScope(reply.data);
      if (path.startsWith("/auth/login/")) this.accountScope(reply.data?.account);
      if (method !== "GET") {
        if (path.startsWith("/billing/")) this.readCache.invalidate("/billing/");
        else {
          for (const prefix of ["/tenants", "/tenant-creation-policy", "/login-methods"])
            this.readCache.invalidate(prefix);
        }
      }
      return reply.data as T;
    } catch (error) {
      this.checkGeneration(generation);
      if (controller.signal.reason === CANCEL) throw new AuthError("CANCELLED");
      if (controller.signal.reason === TIMEOUT) {
        reportApiIssue(path, 0, "TIMEOUT", started, "");
        throw new AuthError("RESULT_UNKNOWN");
      }
      if (error instanceof AuthError) {
        const status = error.code === "INVALID_RESPONSE" && error.status < 400 ? 0 : error.status;
        reportApiIssue(path, status, error.code, started, error.requestId);
        throw error;
      }
      reportApiIssue(path, 0, "NETWORK_ERROR", started, "");
      throw new AuthError("RESULT_UNKNOWN");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
}
