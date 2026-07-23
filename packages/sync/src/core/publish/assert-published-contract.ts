/**
 * Assert published contract is current — pure decision given a readiness port.
 */
import { asEntityId } from "../../domain/types/branded-ids.js"
import { SyncPublishRequiredError } from "../../domain/publish-readiness.js"
import type { SyncPublishReadinessPort } from "../../ports/publish-readiness.js"

export function assertPublishedContractCurrent(
  readiness: SyncPublishReadinessPort,
  entityType: string
): void {
  if (readiness.entityNeedsRepublish(asEntityId(entityType))) {
    throw new SyncPublishRequiredError(entityType)
  }
}
