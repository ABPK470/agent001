/**
 * Per-entity or bulk Catalog JSON import — thin adapter over ImportGateModal.
 */

import type { JSX } from "react"
import { api } from "../../client/index"
import { ImportGateModal } from "../platform/ImportGateModal"

export function EntityRegistryJsonImportGate({
  entityId,
  onClose,
  onImported,
}: {
  entityId?: string
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  return (
    <ImportGateModal
      title="Import entity JSON"
      subtitle={
        entityId
          ? `Replace the live Catalog document for ${entityId}.`
          : "Apply Catalog entity JSON into the live registry."
      }
      accept=".json,application/json"
      fileLabel="Choose JSON file…"
      validate={(json, reason) =>
        api.importEntityRegistryJson(json, reason, { dryRun: true })
      }
      apply={(json, reason) =>
        api.importEntityRegistryJson(json, reason, { dryRun: false })
      }
      onApplied={onImported}
      onClose={onClose}
    />
  )
}
