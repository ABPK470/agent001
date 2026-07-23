/** Normalize a schema-qualified name for per-run verification sets. */
export function verifiedTableKey(qualifiedName: string): string {
  return qualifiedName.trim().toLowerCase()
}
