/**
 * Deploy artifacts zip import — thin adapter over ImportGateModal.
 */

import type { JSX } from "react"
import { api } from "../../client/index"
import { ImportGateModal } from "./ImportGateModal"

export function DeployArtifactsImportGate({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  return (
    <ImportGateModal
      title="Import deploy artifacts"
      subtitle="Apply a mia-deploy-artifacts zip (artifacts/entities/*.json + sync-metadata). Does not factory-reset SQLite."
      accept=".zip,application/zip"
      fileLabel="Choose mia-deploy-artifacts zip…"
      validate={(zipBase64, reason) =>
        api.importDeployArtifacts({ zipBase64, dryRun: true, reason })
      }
      apply={(zipBase64, reason) =>
        api.importDeployArtifacts({ zipBase64, dryRun: false, reason })
      }
      onApplied={onImported}
      onClose={onClose}
    />
  )
}
