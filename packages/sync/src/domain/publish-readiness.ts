/**
 * Publish readiness — tip vs published SyncDefinition gate.
 *
 * Preview/execute always run the **published** contract. When compile-relevant
 * tip is ahead for an entity, operators must Publish before any preview/execute
 * path (HTTP widget or agent tools). Classification lives in the server shell;
 * this module is the sync-core assert + named error every entry point shares.
 */

export const PUBLISH_REQUIRED_CODE = "publish_required" as const

export interface SyncPublishReadinessPort {
  /** True when this entity's published contract is behind compile-relevant tip. */
  entityNeedsRepublish(entityId: string): boolean
}

/** Test / unconfigured hosts — never blocks. Production wires catalog classification. */
export const ALWAYS_PUBLISH_READY: SyncPublishReadinessPort = {
  entityNeedsRepublish: () => false,
}

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
    error instanceof SyncPublishRequiredError
    || (
      error instanceof Error
      && error.name === "SyncPublishRequiredError"
      && typeof (error as SyncPublishRequiredError).entityType === "string"
      && (error as SyncPublishRequiredError).code === PUBLISH_REQUIRED_CODE
    )
  )
}

/** Throw {@link SyncPublishRequiredError} when the host says this entity needs Publish. */
export function assertPublishedContractCurrent(
  readiness: SyncPublishReadinessPort,
  entityType: string,
): void {
  if (readiness.entityNeedsRepublish(entityType)) {
    throw new SyncPublishRequiredError(entityType)
  }
}
