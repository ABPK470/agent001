/**
 * Agent runtime enums covering ingestion mode for attachments.
 *
 * @module
 */

// ── IngestionMode ───────────────────────────────────────────────────────
export const IngestionMode = {
  TextInline: "text_inline",
  TextRetrieval: "text_retrieval",
  BinaryReference: "binary_reference",
  ProviderFileApi: "provider_file_api"
} as const

export type IngestionMode = (typeof IngestionMode)[keyof typeof IngestionMode]

export const INGESTION_MODE_VALUES: ReadonlyArray<IngestionMode> = Object.values(IngestionMode)

export const isIngestionMode = (value: unknown): value is IngestionMode =>
  typeof value === "string" && (INGESTION_MODE_VALUES as readonly string[]).includes(value)
