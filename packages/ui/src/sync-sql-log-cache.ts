import { api } from "./api"

const cache = new Map<number, string>()
const inflight = new Map<number, Promise<string>>()

/** Fetch full SQL text from sync_sql_log — cached, deduped in-flight. */
export async function fetchSqlLogText(id: number): Promise<string> {
  const hit = cache.get(id)
  if (hit != null) return hit

  const pending = inflight.get(id)
  if (pending) return pending

  const request = api
    .getSqlLog(id)
    .then((row) => {
      cache.set(id, row.sql)
      inflight.delete(id)
      return row.sql
    })
    .catch((e) => {
      inflight.delete(id)
      throw e
    })

  inflight.set(id, request)
  return request
}
