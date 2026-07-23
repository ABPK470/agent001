import type { HttpPort } from "../../ports/http.js"

function parseFlatJsonText(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { raw: trimmed }
  }
}

/** Default fetch-backed HTTP port for sync flow steps. */
export const fetchHttpPort: HttpPort = {
  async json(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${method} ${url} failed with ${response.status}: ${text || response.statusText}`)
    }
    return { status: response.status, responseBody: parseFlatJsonText(text) }
  },
}
