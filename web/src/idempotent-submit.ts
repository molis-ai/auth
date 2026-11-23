import { AuthError } from "./account-client.ts";

interface Submission {
  fingerprint: string;
  key: string;
}

const retryableCodes = new Set([
  "RESULT_UNKNOWN",
  "VERSION_CONFLICT",
  "AUTH_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
]);

export class IdempotentSubmit {
  private account?: string;
  private readonly pending = new Map<string, Submission>();

  setAccount(account?: string): void {
    if (account === this.account) return;
    this.account = account;
    this.pending.clear();
  }

  discard(action: string): void {
    this.pending.delete(action);
  }

  async send<T>(
    action: string,
    method: string,
    path: string,
    fields: unknown,
    write: (key: string) => Promise<T>,
  ): Promise<T> {
    if (!this.account) throw new AuthError("CANCELLED");
    const fingerprint = JSON.stringify([method, path, fields]);
    let submission = this.pending.get(action);
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, key: crypto.randomUUID() };
      this.pending.set(action, submission);
    }
    let result: T;
    try {
      result = await write(submission.key);
    } catch (error) {
      if (this.pending.get(action) !== submission) throw new AuthError("CANCELLED");
      if (error instanceof AuthError && !retryableCodes.has(error.code) &&
        error.status < 500 && error.status !== 429 &&
        (error.status >= 400 || error.code === "INVALID_REQUEST" || error.code === "IDEMPOTENCY_CONFLICT")) {
        this.discard(action);
      }
      throw error;
    }
    if (this.pending.get(action) !== submission) throw new AuthError("CANCELLED");
    this.discard(action);
    return result;
  }
}

export async function refreshAfterWrite<T>(
  write: () => Promise<T>,
  committed: (result: T) => void,
  refresh: (result: T) => Promise<void>,
  refreshFailed: (error: unknown, retry: () => Promise<void>) => void,
): Promise<void> {
  const result = await write();
  committed(result);
  const retry = () => refresh(result);
  try {
    await retry();
  } catch (error) {
    refreshFailed(error, retry);
  }
}
