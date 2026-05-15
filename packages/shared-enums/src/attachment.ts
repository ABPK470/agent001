/**
 * Attachment lifecycle enum shared by agent + server.
 *
 * Server persists this in `attachments.scope`; agent-side
 * `AttachmentMetadata.scope` and `AttachmentService.list({ scope })` use
 * the same enum so values flow without runtime conversion.
 */
export const AttachmentScope = {
  Run:            "run",
  Session:        "session",
  WorkspaceAsset: "workspace_asset",
} as const

export type AttachmentScope = (typeof AttachmentScope)[keyof typeof AttachmentScope]

export const ATTACHMENT_SCOPES: ReadonlyArray<AttachmentScope> =
  Object.values(AttachmentScope)

export const isAttachmentScope = (value: unknown): value is AttachmentScope =>
  typeof value === "string" && (ATTACHMENT_SCOPES as readonly string[]).includes(value)
