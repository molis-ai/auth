import { defineAsyncComponent, defineComponent, h, shallowRef, type AsyncComponentLoader, type Component } from "vue";

import { reportBrowserError } from "../telemetry.ts";

export function lazyComponent<T extends Component>(loader: AsyncComponentLoader<T>) {
  const retryLoad = shallowRef<() => void>();
  const status = defineComponent({
    setup: () => () => retryLoad.value
      ? h("div", { role: "alert" }, [
          h("p", "页面内容加载失败。"),
          h("button", { type: "button", onClick: () => retryLoad.value?.() }, "重试"),
        ])
      : h("p", { role: "status" }, "正在加载…"),
  });
  return defineAsyncComponent({
    loader,
    loadingComponent: status,
    onError: (error, retry) => {
      reportBrowserError("chunk_load", error);
      retryLoad.value = () => {
        retryLoad.value = undefined;
        retry();
      };
    },
  });
}
