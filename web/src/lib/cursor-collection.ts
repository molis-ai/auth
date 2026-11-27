import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from "vue";
import type { AccountClient } from "./account-client.ts";

interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function cursorCollection<T>(client: Pick<AccountClient, "request">) {
  const pages = shallowRef<Page<T>[]>([]);
  const items = computed(() => pages.value.flatMap(page => page.items));
  const nextCursor = computed(() => pages.value.at(-1)?.nextCursor ?? null);
  const loading = ref(false);
  let inFlight: AbortController | undefined;
  let path = "";
  let limit = 20;

  function cancel() {
    inFlight?.abort();
    inFlight = undefined;
    loading.value = false;
  }
  if (getCurrentScope()) onScopeDispose(cancel);

  function clear() {
    cancel();
    pages.value = [];
  }

  async function read(cursor: string | null) {
    inFlight?.abort();
    const request = new AbortController();
    inFlight = request;
    loading.value = true;
    try {
      const page = await client.request<Page<T>>(
        path + (path.includes("?") ? "&" : "?") + "limit=" + limit +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        undefined, "GET", undefined, request.signal,
      );
      if (request.signal.aborted) return false;
      if (cursor && page.nextCursor && pages.value.some(previous => previous.nextCursor === page.nextCursor)) {
        throw Error("分页状态发生变化，请刷新");
      }
      pages.value = cursor ? [...pages.value, page] : [page];
      return true;
    } catch (error) {
      if (request.signal.aborted) return false;
      throw error;
    } finally {
      if (inFlight === request) {
        inFlight = undefined;
        loading.value = false;
      }
    }
  }

  function first(resource: string, size = 20) {
    path = resource;
    limit = size;
    return read(null);
  }

  function more() {
    return !loading.value && nextCursor.value ? read(nextCursor.value) : Promise.resolve(false);
  }

  function remove(predicate: (item: T) => boolean) {
    pages.value = pages.value.map(page => ({
      ...page,
      items: page.items.filter(item => !predicate(item)),
    }));
  }

  function replace(predicate: (item: T) => boolean, value: T) {
    pages.value = pages.value.map(page => ({
      ...page,
      items: page.items.map(item => predicate(item) ? value : item),
    }));
  }

  return { pages, items, nextCursor, loading, first, more, clear, remove, replace };
}
