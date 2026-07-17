/**
 * Server-only enums for the `attachments` domain.
 *
 * AttachmentScope is shared with the agent (lives in `@mia/agent`'s
 * `engine/enums/attachment.ts`); we re-export it here so server code
 * can use a single import path. The remaining attachment enums are
 * server-only.
 */

export { ATTACHMENT_SCOPES, AttachmentScope, isAttachmentScope } from "@mia/agent"

/** How an attachment's content is exposed to the LLM. */
export const AttachmentIngestionMode = {
  TextInline: "text_inline",
  TextRetrieval: "text_retrieval",
  BinaryReference: "binary_reference",
  ProviderFileApi: "provider_file_api"
} as const

export type AttachmentIngestionMode = (typeof AttachmentIngestionMode)[keyof typeof AttachmentIngestionMode]

export const ATTACHMENT_INGESTION_MODES: ReadonlyArray<AttachmentIngestionMode> =
  Object.values(AttachmentIngestionMode)

export const isAttachmentIngestionMode = (value: unknown): value is AttachmentIngestionMode =>
  typeof value === "string" && (ATTACHMENT_INGESTION_MODES as readonly string[]).includes(value)

/** Attachment processing lifecycle status. */
export const AttachmentStatus = {
  Uploaded: "uploaded",
  Processed: "processed",
  Rejected: "rejected",
  Deleted: "deleted"
} as const

export type AttachmentStatus = (typeof AttachmentStatus)[keyof typeof AttachmentStatus]

export const ATTACHMENT_STATUSES: ReadonlyArray<AttachmentStatus> = Object.values(AttachmentStatus)

export const isAttachmentStatus = (value: unknown): value is AttachmentStatus =>
  typeof value === "string" && (ATTACHMENT_STATUSES as readonly string[]).includes(value)

/** Where the attachment originated from. */
export const AttachmentSource = {
  UserUpload: "user_upload",
  Generated: "generated",
  Promoted: "promoted"
} as const

export type AttachmentSource = (typeof AttachmentSource)[keyof typeof AttachmentSource]

export const ATTACHMENT_SOURCES: ReadonlyArray<AttachmentSource> = Object.values(AttachmentSource)

export const isAttachmentSource = (value: unknown): value is AttachmentSource =>
  typeof value === "string" && (ATTACHMENT_SOURCES as readonly string[]).includes(value)

/** How an attachment's bytes were stored when imported. */
export const AttachmentImportMode = {
  Copy: "copy",
  Reference: "reference"
} as const

export type AttachmentImportMode = (typeof AttachmentImportMode)[keyof typeof AttachmentImportMode]

export const ATTACHMENT_IMPORT_MODES: ReadonlyArray<AttachmentImportMode> =
  Object.values(AttachmentImportMode)

export const isAttachmentImportMode = (value: unknown): value is AttachmentImportMode =>
  typeof value === "string" && (ATTACHMENT_IMPORT_MODES as readonly string[]).includes(value)
