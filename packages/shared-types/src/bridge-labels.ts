/**
 * Short human labels for Bridge read/write specs — event payloads & Pipelines.
 */

import type { ReadSpec, WriteSpec } from "./connectors.js"

function clip(text: string, max = 72): string {
  const t = text.replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

/** Short human label for a read spec (SQL / path / view). */
export function summarizeBridgeReadSpec(spec: ReadSpec): string {
  if (spec.kind === "sql") return clip(spec.sql || "(empty SQL)")
  if (spec.kind === "denodo") return clip(`view ${spec.view}`)
  if (spec.kind === "aqueduct") return "aqueduct pipeline"
  if (spec.kind === "httpApi") return clip(`${spec.method} ${spec.path}`)
  // Remaining kinds are file-like (path + format).
  return clip(`${String(spec.path)} · ${String(spec.format ?? "file")}`)
}

/** Short human label for a write spec (table / path). */
export function summarizeBridgeWriteSpec(spec: WriteSpec): string {
  if (spec.kind === "sql") {
    const flags: string[] = []
    if (spec.allowIdentityInsert) flags.push("identity")
    if (spec.relaxConstraints) flags.push("relax")
    const base = spec.table || "(no table)"
    return flags.length > 0 ? `${clip(base, 48)} · ${flags.join("+")}` : clip(base)
  }
  if (spec.kind === "httpApi") return clip(`${spec.method} ${spec.path}`)
  return clip(`${String(spec.path)} · ${String(spec.format ?? "file")} · ${String(spec.mode)}`)
}
