/**
 * API request logging persistence.
 */

import { getDb } from "./connection.js"

export function migrateApiRequests(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS api_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      duration_ms REAL NOT NULL,
      request_body TEXT,
      response_summary TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_requests_time ON api_requests(created_at DESC);
  `)
}

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
  getDb().prepare(`
    INSERT INTO api_requests (method, url, status_code, duration_ms, request_body, response_summary, created_at)
    VALUES (@method, @url, @status_code, @duration_ms, @request_body, @response_summary, @created_at)
  `).run(entry)
}

export function listApiRequests(limit = 200): DbApiRequest[] {
  return getDb()
    .prepare("SELECT * FROM api_requests ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DbApiRequest[]
}
