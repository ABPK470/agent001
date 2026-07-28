/**
 * API request logging persistence.
 */

import { getDb } from "../connection.js"

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
  getDb()
    .prepare(
      `
    INSERT INTO api_request_log (method, url, status_code, duration_ms, request_body, response_summary, created_at)
    VALUES (@method, @url, @status_code, @duration_ms, @request_body, @response_summary, @created_at)
  `
    )
    .run(entry)
}

export function listApiRequests(limit = 200): DbApiRequest[] {
  return getDb()
    .prepare("SELECT * FROM api_request_log ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbApiRequest[]
}
