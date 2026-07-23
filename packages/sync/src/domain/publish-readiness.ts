/**
 * Publish readiness vocabulary — tip vs published SyncDefinition gate codes/errors.
 * Assert lives in `core/publish/`; port lives in `ports/publish-readiness`.
 */
export const PUBLISH_REQUIRED_CODE = "publish_required" as const

export function publishRequiredMessage(entityType: string): string {
  return (
    `Published sync contract for "${entityType}" is behind the catalog tip. ` +
    `Publish from Entity Registry before preview/execute.`
  )
}

export class SyncPublishRequiredError extends Error {
  readonly code = PUBLISH_REQUIRED_CODE
  readonly entityType: string

  constructor(entityType: string) {
    super(publishRequiredMessage(entityType))
    this.name = "SyncPublishRequiredError"
    this.entityType = entityType
  }
}

export function isSyncPublishRequiredError(error: unknown): error is SyncPublishRequiredError {
  return (
    error instanceof SyncPublishRequiredError ||
    (error instanceof Error &&
      error.name === "SyncPublishRequiredError" &&
      typeof (error as SyncPublishRequiredError).entityType === "string" &&
      (error as SyncPublishRequiredError).code === PUBLISH_REQUIRED_CODE)
  )
}
