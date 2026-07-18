/**
 * Single EntityDefinition / registry JSON import — thin adapter over ImportGateModal.
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
      title="Import registry JSON"
      subtitle={
        entityId
          ? `Apply EntityDefinition JSON for ${entityId} into SQLite.`
          : "Apply EntityDefinition registry JSON into SQLite."
      }
      accept=".json,application/json"
      fileLabel="Choose registry JSON…"
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
