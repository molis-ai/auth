import type { AccountClient } from "./account-client.ts";

export async function readPages<T>(
  client: Pick<AccountClient, "request">,
  path: string,
  isActive: () => boolean = () => true,
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const suffix: string = (path.includes("?") ? "&" : "?") + "limit=100" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page: { items: T[]; nextCursor: string | null } = await client.request(path + suffix);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Error("分页状态发生变化，请刷新");
    if (cursor) seen.add(cursor);
  } while (cursor && isActive());
  return items;
}
