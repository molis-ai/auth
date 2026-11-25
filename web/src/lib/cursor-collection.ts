import { computed, ref, shallowRef } from "vue";
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
  let generation = 0;
  let path = "";
  let limit = 20;

  function clear() {
    generation++;
    loading.value = false;
    pages.value = [];
  }

  async function read(cursor: string | null) {
    const request = ++generation;
    loading.value = true;
    try {
      const page = await client.request<Page<T>>(
        path + (path.includes("?") ? "&" : "?") + "limit=" + limit +
          (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (generation !== request) return false;
      if (cursor && page.nextCursor && pages.value.some(previous => previous.nextCursor === page.nextCursor)) {
        throw Error("分页状态发生变化，请刷新");
      }
      pages.value = cursor ? [...pages.value, page] : [page];
      return true;
    } catch (error) {
      if (generation !== request) return false;
      throw error;
    } finally {
      if (generation === request) loading.value = false;
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

  return { pages, items, nextCursor, loading, first, more, clear, remove };
}
