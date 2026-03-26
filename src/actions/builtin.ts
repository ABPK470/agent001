/**
 * Built-in action handlers.
 *
 * The platform ships with these. Users register domain-specific handlers
 * at startup. The engine looks them up by name at runtime.
 *
 * This makes the platform generic: business logic lives in action handlers
 * and workflow definitions, not in the orchestrator.
 */

import type { ActionHandler, ExecutionContext } from "../engine/executor.js"

// ── HTTP Request ─────────────────────────────────────────────────

export class HttpRequestAction implements ActionHandler {
  readonly name = "http.request"

  async execute(
    input: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const url = String(input["url"] ?? "")
    const method = String(input["method"] ?? "GET").toUpperCase()
    const headers = (input["headers"] as Record<string, string>) ?? {}
    const body = input["body"]
    const timeoutMs = Number(input["timeoutMs"] ?? 30_000)

    if (!url) throw new Error("http.request: 'url' is required")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      })
      const responseBody = await resp.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(responseBody)
      } catch {
        parsed = responseBody
      }
      return { status: resp.status, body: parsed }
    } finally {
      clearTimeout(timer)
    }
  }
}

// ── Data Transform ───────────────────────────────────────────────

export class TransformAction implements ActionHandler {
  readonly name = "transform"

  async execute(
    input: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const data = input["data"]
    const mapping = input["mapping"] as Record<string, string> | undefined

    if (!mapping || typeof mapping !== "object") {
      return { result: data }
    }

    // Simple field mapping: { targetField: "sourceField" }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const source = data as Record<string, unknown>
      const result: Record<string, unknown> = {}
      for (const [target, sourceKey] of Object.entries(mapping)) {
        result[target] = source[sourceKey]
      }
      return { result }
    }

    return { result: data }
  }
}

// ── Filter ──────────────────────────────────────────────────────

export class FilterAction implements ActionHandler {
  readonly name = "filter"

  async execute(
    input: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const items = input["items"]
    const field = String(input["field"] ?? "")
    const op = String(input["op"] ?? "==")
    const value = input["value"]

    if (!Array.isArray(items)) return { result: [] }

    const result = items.filter((item) => {
      if (typeof item !== "object" || item === null) return false
      const fieldVal = (item as Record<string, unknown>)[field]
      switch (op) {
        case "==":
          return fieldVal === value
        case "!=":
          return fieldVal !== value
        case ">":
          return Number(fieldVal) > Number(value)
        case "<":
          return Number(fieldVal) < Number(value)
        case "contains":
          return String(fieldVal).includes(String(value))
        default:
          return false
      }
    })

    return { result, count: result.length }
  }
}

// ── No-op (for testing / placeholders) ──────────────────────────

export class NoopAction implements ActionHandler {
  readonly name = "noop"

  async execute(
    input: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    return { ...input, noop: true }
  }
}

// ── Log ─────────────────────────────────────────────────────────

export class LogAction implements ActionHandler {
  readonly name = "log"
  readonly logs: Array<{ message: unknown; ctx: ExecutionContext }> = []

  async execute(
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    const message = input["message"] ?? input
    this.logs.push({ message, ctx })
    return { logged: true }
  }
}

/** Registers all built-in action handlers. */
export function builtinActions(): ActionHandler[] {
  return [
    new HttpRequestAction(),
    new TransformAction(),
    new FilterAction(),
    new NoopAction(),
    new LogAction(),
  ]
}
