import { requireThat as ok } from '../shared/http.ts'
import { Store } from './database.ts'
export function pageParams(url: URL) {
  const limit = Number(url.searchParams.get('limit') ?? 25),
    page = Number(url.searchParams.get('page') ?? 1)
  ok(
    Number.isInteger(limit) &&
      limit > 0 &&
      limit <= 100 &&
      Number.isInteger(page) &&
      page > 0 &&
      page <= 1000000,
  )
  return { limit, page }
}
export async function paginate<T>(
  s: Store,
  url: URL,
  sql: string,
  values: (string | number | null)[],
  order: string,
) {
  const { limit, page } = pageParams(url)
  if (url.searchParams.has('page')) {
    const total = (await s.one<{ n: number }>(`SELECT count(*) n FROM (${sql})`, ...values))!.n
    const actual = Math.min(page, Math.max(1, Math.ceil(total / limit)))
    return {
      items: await s.all<T>(
        `SELECT * FROM (${sql}) page_rows ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...values,
        limit,
        (actual - 1) * limit,
      ),
      total,
      page: actual,
      pageSize: limit,
    }
  }
  const cursor = url.searchParams.get('cursor') ?? '0'
  ok(/^\d{1,9}$/.test(cursor))
  const rows = await s.all<T>(
    `SELECT * FROM (${sql}) page_rows ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...values,
    limit + 1,
    Number(cursor),
  )
  return {
    items: rows.slice(0, limit),
    nextCursor: rows.length > limit ? String(Number(cursor) + limit) : null,
  }
}
