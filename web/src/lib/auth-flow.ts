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
  open(reserved?: Window | null) {
    this.popup =
      reserved && !reserved.closed
        ? reserved
        : window.open("about:blank", "_blank");
    if (this.popup) this.popup.opener = null;
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
