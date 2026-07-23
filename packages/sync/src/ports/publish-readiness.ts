/**
 * Publish-readiness port — host contract for tip-vs-published gate.
 */
import type { EntityId } from "../domain/types/branded-ids.js"

export interface SyncPublishReadinessPort {
  /** True when this entity's published contract is behind compile-relevant tip. */
  entityNeedsRepublish(entityId: EntityId): boolean
}

/** Test / unconfigured hosts — never blocks. Production wires catalog classification. */
export const ALWAYS_PUBLISH_READY: SyncPublishReadinessPort = {
  entityNeedsRepublish: () => false
}
