import { api } from "../../../client/index"

const cache = new Map<number, string>()
const inflight = new Map<number, Promise<string>>()

const FETCH_TIMEOUT_MS = 15_000

export function peekSqlLogText(id: number): string | undefined {
  return cache.get(id)
}

/** Fetch full SQL text from sync_sql_log — cached, deduped in-flight, bounded wait. */
export async function fetchSqlLogText(id: number): Promise<string> {
  const hit = cache.get(id)
  if (hit != null) return hit

  const pending = inflight.get(id)
  if (pending) return pending

  const request = (async () => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    try {
      const row = await api.getSqlLog(id, { signal: controller.signal })
      const sql = typeof row.sql === "string" ? row.sql : ""
      cache.set(id, sql)
      return sql
    } finally {
      clearTimeout(timer)
      inflight.delete(id)
    }
  })()

  inflight.set(id, request)
  return request
}
