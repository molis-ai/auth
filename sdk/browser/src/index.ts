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
export class AccountClient {
  private readonly transport: typeof fetch;
  private readonly origin: string;
  private readonly timeout: number;
  private closed = false;
  private csrf = "";
  private generation = 0;
  private readonly pending = new Set<AbortController>();
  private tail: Promise<unknown> = Promise.resolve();
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
  async session(): Promise<AccountView> {
    const generation = this.generation;
    for (let attempt = 0; ; attempt++) {
      if (generation !== this.generation || this.closed) throw new AuthError("CANCELLED");
      try { return await this.request<AccountView>("/session"); }
      catch (error) {
        if (!(error instanceof AuthError) || error.code !== "VERSION_CONFLICT" || attempt >= 3) throw error;
        await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
      }
    }
  }
  request<T>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    key?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new AuthError("CANCELLED"));
    if (
      !/^\/[A-Za-z0-9/_?=&%.-]+$/.test(path) ||
      /\.\.|%2e|%2f|%5c/i.test(path) ||
      path.startsWith("//") ||
      !["GET", "POST", "PATCH"].includes(method)
    )
      return Promise.reject(new AuthError("INVALID_REQUEST"));
    const generation = this.generation;
    const run = async () => {
      if (generation !== this.generation) throw new AuthError("CANCELLED");
      if (method !== "GET" && !this.csrf)
        await this.send("/session", undefined, "GET", generation);
      return this.send<T>(path, body, method, generation, key);
    };
    const result = this.tail.catch(() => undefined).then(run);
    this.tail = result.catch(() => undefined);
    return result;
  }
  async logout(
    all = false,
  ): Promise<{
    localCleared: boolean;
    remoteRevocation: "CONFIRMED" | "UNCONFIRMED";
  }> {
    if (this.closed) throw new AuthError("CANCELLED");
    this.generation++;
    for (const controller of this.pending) controller.abort();
    // Logout fences in-flight responses and reaches the server without waiting for old work.
    if (!this.csrf)
      await this.send("/session", undefined, "GET", this.generation);
    const generation = this.generation, key = crypto.randomUUID();
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<{localCleared:boolean;remoteRevocation:"CONFIRMED"|"UNCONFIRMED"}>(
          "/logout", { scope: all ? "ALL_MOLIS_PRODUCTS" : "CURRENT_LOGIN" }, "POST", generation, key,
        );
      } catch (error) {
        if (!(error instanceof AuthError) || error.code !== "VERSION_CONFLICT" || attempt >= 3) throw error;
        // Another tab may finish a profile save while logout reads the current session.
        // Keep the original generation so a superseded logout cannot affect a new account.
      }
    }
  }
  close(): void {
    this.closed = true;
    this.generation++;
    for (const controller of this.pending) controller.abort();
  }
  private async send<T>(
    path: string,
    body: unknown,
    method: string,
    generation: number,
    key?: string,
  ): Promise<T> {
    const controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(() => controller.abort(), this.timeout);
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
                  "X-CSRF-Token": this.csrf,
                }),
            ...(key ? { "Idempotency-Key": key } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      const reply = await response.json();
      if (generation !== this.generation) throw new AuthError("CANCELLED");
      const csrf = response.headers.get("X-CSRF-Token");
      if (csrf) this.csrf = csrf;
      if (!response.ok)
        throw new AuthError(
          /^[A-Z][A-Z0-9_]{1,63}$/.test(reply?.error?.code ?? "")
            ? reply.error.code
            : "AUTH_UNAVAILABLE",
          response.status,
          typeof reply?.requestId === "string" ? reply.requestId : "",
        );
      if (!reply || !Object.hasOwn(reply, "data"))
        throw new AuthError("INVALID_RESPONSE");
      return reply.data as T;
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        controller.signal.aborted ? "CANCELLED" : "RESULT_UNKNOWN",
      );
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
    }
  }
}
