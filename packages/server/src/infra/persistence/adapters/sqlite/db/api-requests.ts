/**
 * API request logging persistence.
 */

import { getPlatformDb } from "../../../schema/kysely.js"
import { runAll, runExec } from "../../../schema/execute.js"

export interface DbApiRequest {
  id?: number
  method: string
  url: string
  status_code: number
  duration_ms: number
  request_body: string | null
  response_summary: string | null
  created_at: string
}

export function saveApiRequest(entry: Omit<DbApiRequest, "id">): void {
  const compiled = getPlatformDb()
    .insertInto("api_request_log")
    .values({
      method: entry.method,
      url: entry.url,
      status_code: entry.status_code,
      duration_ms: entry.duration_ms,
      request_body: entry.request_body,
      response_summary: entry.response_summary,
      created_at: entry.created_at,
    })
    .compile()
  runExec(compiled)
}

export function listApiRequests(limit = 200): DbApiRequest[] {
  const compiled = getPlatformDb()
    .selectFrom("api_request_log")
    .selectAll()
    .orderBy("created_at", "desc")
    .limit(limit)
    .compile()
  return runAll<DbApiRequest>(compiled)
}
