import type { AccountView } from "../../shared/api/account-client.ts";

export interface AuthCompletion {
  handle: string;
  account?: AccountView;
}

/** Owns one panel's async lifetime, authorization window and scheduled poll. */
export class AuthFlow {
  private revision = 0;
  private disposed = false;
  private popup: Window | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  current(revision: number) {
    return !this.disposed && revision === this.revision;
  }
  async request<T>(
    operation: () => Promise<T>,
    discard?: (value: T) => Promise<void>,
  ): Promise<T> {
    const revision = this.revision;
    if (!this.current(revision)) throw new FlowCancelled();
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      if (!this.current(revision)) throw new FlowCancelled();
      throw error;
    }
    if (!this.current(revision)) {
      if (discard) await discard(value);
      throw new FlowCancelled();
    }
    return value;
  }
  reserve(existing?: Window | null) {
    const popup = existing && !existing.closed ? existing : window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    return popup;
  }
  open(reserved?: Window | null) {
    this.popup = this.reserve(reserved);
    return Boolean(this.popup);
  }
  navigate(url: string) {
    if (!this.popup || this.popup.closed) throw Error("授权窗口不可用");
    this.popup.location.replace(url);
  }
  get closed() {
    return this.popup?.closed ?? false;
  }
  closeWindow() {
    this.popup?.close();
    this.popup = null;
  }
  schedule(callback: () => Promise<void>, delay: number) {
    clearTimeout(this.timer);
    const revision = this.revision;
    this.timer = setTimeout(() => {
      if (this.current(revision)) void callback();
    }, delay);
  }
  cancel() {
    this.revision++;
    clearTimeout(this.timer);
    this.closeWindow();
  }
  dispose() {
    this.cancel();
    this.disposed = true;
  }
}
export class FlowCancelled extends Error {}

export function mayChooseAuthMethod(current: string, next: string, providerPending: boolean) {
  return !providerPending && (current !== next || next === "GOOGLE" || next === "GITHUB");
}

export function watchProvider(flow: AuthFlow, target: string | undefined, hooks: {
  start(): void;
  active(): boolean;
  read(): Promise<{ status?: string }>;
  complete(): Promise<void>;
  failed(error?: unknown): Promise<void>;
}) {
  if (!target) throw Error("授权地址不可用");
  const url = new URL(target);
  if (url.origin !== location.origin) throw Error("授权地址不匹配");
  flow.navigate(url.href);
  hooks.start();

  let delay = 500;
  async function poll() {
    if (!hooks.active()) return;
    try {
      const { status } = await hooks.read();
      if (status === "CONSUMED") {
        await hooks.complete();
      } else if (status === "CANCELLED" || status === "EXPIRED" || flow.closed) {
        await hooks.failed();
      } else {
        delay = Math.min(4000, delay * 2);
        flow.schedule(poll, delay);
      }
    } catch (error) {
      if (!(error instanceof FlowCancelled)) await hooks.failed(error);
    }
  }
  flow.schedule(poll, delay);
}
