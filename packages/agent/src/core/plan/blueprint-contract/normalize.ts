import { canonicalizeRelative } from "../../../internal/index.js"

export function normalizeSpecPath(value: string): string {
  return canonicalizeRelative(value).trim()
}

export function normalizeBasename(value: string): string {
  const normalized = normalizeSpecPath(value)
  const parts = normalized.split("/")
  return (parts[parts.length - 1] ?? normalized).toLowerCase()
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}
