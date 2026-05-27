/**
 * Canonical-JSON helper for fingerprint + signing.
 *
 * Strings produced by `canonicalJsonStringify()` are deterministic:
 *  - object keys sorted lexicographically at every depth
 *  - no insignificant whitespace
 *  - numbers serialised through JSON.stringify (no NaN/Infinity allowed)
 *  - arrays preserve order
 *
 * Used by:
 *   - F1.1 proposer finding fingerprints (dedup against open proposals)
 *   - F1.8 evidence envelope hash chain + detached signature
 *   - any other place that needs "same input → same bytes"
 */

import { createHash, createHmac } from "node:crypto"

export function canonicalJsonStringify(value: unknown): string {
  return serialise(value)
}

function serialise(v: unknown): string {
  if (v === null) return "null"
  if (typeof v === "boolean") return v ? "true" : "false"
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      throw new Error("canonicalJsonStringify: non-finite number is not permitted")
    }
    return JSON.stringify(v)
  }
  if (typeof v === "string") return JSON.stringify(v)
  if (typeof v === "bigint") return JSON.stringify(v.toString())
  if (Array.isArray(v))      return "[" + v.map(serialise).join(",") + "]"
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort()
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + serialise(o[k])).join(",") + "}"
  }
  throw new Error(`canonicalJsonStringify: unsupported value of type ${typeof v}`)
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

export function hmacSha256Hex(secret: string, input: string | Buffer): string {
  return createHmac("sha256", secret).update(input).digest("hex")
}

/** Convenience: SHA-256 of `canonicalJsonStringify(value)`. */
export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value))
}
