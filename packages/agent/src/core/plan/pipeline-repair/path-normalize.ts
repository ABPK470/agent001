/** Normalize artifact / tool-call paths for contract reconciliation. */
export function normalizeToolCallPath(value: unknown): string {
  if (typeof value !== "string") return ""
  return value.replace(/\\/g, "/").replace(/^\.\//, "").trim()
}
