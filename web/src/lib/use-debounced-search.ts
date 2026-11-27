import { ref, watch, type Ref } from "vue";

export function useDebouncedSearch(query: Ref<string>) {
  const applied = ref(query.value.trim());
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(query, (value, _, onCleanup) => {
    timer = setTimeout(() => { applied.value = value.trim(); }, 250);
    onCleanup(() => clearTimeout(timer));
  });

  function reset() {
    clearTimeout(timer);
    query.value = "";
    applied.value = "";
  }

  return { applied, reset };
}
