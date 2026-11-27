import { inject, provide, type InjectionKey } from "vue";

type UnionToIntersection<T> =
  (T extends unknown ? (value: T) => void : never) extends (value: infer I) => void ? I : never;

export type EmitFor<T extends { [K in keyof T]: unknown[] }> = UnionToIntersection<{
  [K in keyof T]: (name: K, ...args: T[K]) => void;
}[keyof T]>;

export function createRequiredContext<T>(name: string) {
  const key: InjectionKey<T> = Symbol(name);
  return {
    provide(value: T) { provide(key, value); },
    use() {
      const value = inject(key);
      if (!value) throw Error(`Missing ${name} context`);
      return value;
    },
  };
}
