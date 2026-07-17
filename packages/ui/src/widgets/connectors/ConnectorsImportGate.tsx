/**
 * Connectors import — thin adapter over ImportGateModal.
 */

import type { JSX } from "react"
import type { PlatformImportGateResult } from "@mia/shared-types"
import { api } from "../../client/index"
import { ImportGateModal } from "../platform/ImportGateModal"

function parseConnectorsPayload(text: string): {
  version: number
  connectors: Array<Record<string, unknown>>
} {
  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid connectors.json — expected { version, connectors }.")
  }
  const body = parsed as { version?: unknown; connectors?: unknown }
  if (body.version !== 1) {
    throw new Error("Unsupported connectors.json version (expected version: 1).")
  }
  if (!Array.isArray(body.connectors)) {
    throw new Error("Invalid connectors.json — connectors must be an array.")
  }
  return {
    version: 1,
    connectors: body.connectors as Array<Record<string, unknown>>,
  }
}

async function run(
  payload: string,
  reason: string,
  dryRun: boolean,
): Promise<PlatformImportGateResult> {
  const body = parseConnectorsPayload(payload)
  return api.importConnectors({ ...body, dryRun, reason })
}

export function ConnectorsImportGate({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  return (
    <ImportGateModal
      title="Import connectors.json"
      subtitle="Validate then upsert connectors. Matching ids are overwritten; masked secrets leave existing values unchanged."
      accept="application/json,.json"
      fileLabel="Choose connectors.json…"
      validate={(payload, reason) => run(payload, reason, true)}
      apply={(payload, reason) => run(payload, reason, false)}
      onApplied={onImported}
      onClose={onClose}
    />
  )
}
