import { inject, provide, type InjectionKey } from "vue";
import type { AccountClient } from "./account-client.ts";
import type { WriteOptions } from "./idempotent-submit.ts";

type Write = <T>(path: string, body: unknown, options: WriteOptions<T>) => Promise<void>;

interface AccountContext {
  client: AccountClient;
  mutate: Write;
  submitWrite: Write;
  submitBusyWrite: Write;
  discard: (action: string) => void;
  run: (task: () => Promise<void>) => Promise<void>;
  expireAccount: (error: unknown) => boolean;
  expireWithToast: (error: unknown) => void;
}

const accountContext: InjectionKey<AccountContext> = Symbol("accountContext");

export function provideAccountContext(context: AccountContext) {
  provide(accountContext, context);
}

export function useAccountContext() {
  const context = inject(accountContext);
  if (!context) throw new Error("Account context is unavailable");
  return context;
}
