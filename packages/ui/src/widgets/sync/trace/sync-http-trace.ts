/** Sync HTTP flow-step telemetry (`sync.execute.http`). */

export function isSyncHttpEventType(type: string): boolean {
  return type === "sync.execute.http"
}

export interface HttpTraceFields {
  method: string
  url: string
  status: number
  durationMs?: number | null
  requestBody?: unknown
  responseBody?: unknown
  error?: string | null
  step?: string | null
}

export function readHttpTraceFields(data: Record<string, unknown>): HttpTraceFields | null {
  const method = typeof data.method === "string" ? data.method : null
  const url = typeof data.url === "string" ? data.url : null
  if (!method || !url) return null
  const status = typeof data.status === "number" ? data.status : 0
  return {
    method,
    url,
    status,
    durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
    requestBody: data.requestBody,
    responseBody: data.responseBody,
    error: typeof data.error === "string" ? data.error : null,
    step: typeof data.step === "string" ? data.step : null,
  }
}

export function formatHttpTraceSummary(fields: HttpTraceFields): string {
  const path = (() => {
    try {
      return new URL(fields.url).pathname
    } catch {
      return fields.url
    }
  })()
  const statusPart = fields.status > 0 ? String(fields.status) : (fields.error ? "err" : "—")
  return `${fields.method} ${path} · ${statusPart}`
}
