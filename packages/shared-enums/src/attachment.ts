/**
 * Attachment lifecycle enum shared by agent + server.
 *
 * Server persists this in `attachments.scope`; agent-side
 * `AttachmentMetadata.scope` and `AttachmentService.list({ scope })` use
 * the same enum so values flow without runtime conversion.
 */
export const AttachmentScope = {
  Run:            "run",
  /** Pre-run file staging owned by `owner_upn` — not an auth cookie session. */
  UserDraft:      "user_draft",
  WorkspaceAsset: "workspace_asset",
} as const

export type AttachmentScope = (typeof AttachmentScope)[keyof typeof AttachmentScope]

export const ATTACHMENT_SCOPES: ReadonlyArray<AttachmentScope> =
  Object.values(AttachmentScope)

export const isAttachmentScope = (value: unknown): value is AttachmentScope =>
  typeof value === "string" && (ATTACHMENT_SCOPES as readonly string[]).includes(value)
