/**
 * Catalog snapshot import — thin adapter over ImportGateModal.
 */

import type { JSX } from "react"
import { api } from "../../client/index"
import { ImportGateModal } from "./ImportGateModal"

export function CatalogImportGate({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  return (
    <ImportGateModal
      title="Import catalog snapshot"
      subtitle="Apply a mia-sync-export zip (entity-registry.json + sync-metadata). Repo deploy/sync files are never modified."
      accept=".zip,application/zip"
      fileLabel="Choose mia-sync-export zip…"
      validate={(zipBase64, reason) =>
        api.importSyncCatalog({ zipBase64, dryRun: true, reason })
      }
      apply={(zipBase64, reason) =>
        api.importSyncCatalog({ zipBase64, dryRun: false, reason })
      }
      onApplied={onImported}
      onClose={onClose}
    />
  )
}
