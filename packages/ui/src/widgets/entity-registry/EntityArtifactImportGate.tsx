/**
 * Single deploy artifact JSON import — thin adapter over ImportGateModal.
 */

import type { JSX } from "react"
import { api } from "../../client/index"
import { ImportGateModal } from "../platform/ImportGateModal"

export function EntityArtifactImportGate({
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
      title="Import deploy artifact"
      subtitle={
        entityId
          ? `Apply ${entityId}.json (AuthoredSyncDefinition) into SQLite.`
          : "Apply deploy/sync/artifacts/entities/*.json into SQLite."
      }
      accept=".json,application/json"
      fileLabel="Choose deploy artifact JSON…"
      validate={(json, reason) =>
        api.importEntityDeployArtifact(json, reason, { dryRun: true })
      }
      apply={(json, reason) =>
        api.importEntityDeployArtifact(json, reason, { dryRun: false })
      }
      onApplied={onImported}
      onClose={onClose}
    />
  )
}
