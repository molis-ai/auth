export function teamListPath(query: string, status: string, order: string, cursor: string | null = null) {
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*\.]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return '/spaces/teams?limit=25&q=' + encode(query.trim()) + '&status=' + encode(status) + '&order=' + encode(order) + (cursor ? '&cursor=' + encode(cursor) : '')
}
