/**
 * Catalog version restore — thin adapter over ImportGateModal (fixed payload).
 */

import type { JSX } from "react"
import { api } from "../../client/index"
import { ImportGateModal } from "./ImportGateModal"

export function CatalogRollbackGate({
  version,
  onClose,
  onRestored,
}: {
  version: number
  onClose: () => void
  onRestored: () => void
}): JSX.Element {
  const payload = String(version)
  return (
    <ImportGateModal
      title="Restore catalog version"
      subtitle={`Validate impact, then restore configuration from version ${version}. This creates a new active version.`}
      fileLabel=""
      applyLabel="Restore"
      fixedPayload={payload}
      fixedPayloadLabel={`Catalog version ${version}`}
      validate={(_payload, reason) =>
        api.rollbackSyncCatalog({ version, dryRun: true, reason })
      }
      apply={(_payload, reason) =>
        api.rollbackSyncCatalog({ version, dryRun: false, reason })
      }
      onApplied={onRestored}
      onClose={onClose}
      stackLevel={1}
    />
  )
}
