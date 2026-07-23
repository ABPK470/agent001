/** Minimal catalog shape for schema-token vocabulary (domain layer). */
export interface CatalogSchemaSource {
  readonly tables: ReadonlyMap<string, { readonly schema: string }>
}
