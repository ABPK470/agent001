import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildFlowCatalog } from "../domain/flow-catalog.js"
import { loadSyncMetadataArtifact } from "../runtime/artifacts/load-sync-metadata-artifact.js"

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..")

let cachedMinimalCatalog: ReturnType<typeof buildFlowCatalog> | undefined

/** Self-contained catalog for temp test bundles (no deploy artifact required). */
export function buildMinimalTestFlowCatalog() {
  if (cachedMinimalCatalog) return cachedMinimalCatalog
  cachedMinimalCatalog = buildFlowCatalog(
    [
      {
        id: "metadata",
        label: "Metadata",
        definition_json: JSON.stringify({
          summary: "Core metadata transaction",
          description: "Metadata apply phase",
          boundary: "metadata_transaction",
          connection: "target",
          defaultFailureMode: "fatal",
        }),
      },
    ],
    [
      {
        id: "metadataSync",
        label: "metadataSync",
        definition_json: JSON.stringify({
          summary: "Metadata sync",
          description: "Runs metadata sync",
          handler: { type: "metadata_sync", connection: "target" },
          stepFields: {},
          failureMode: "fatal",
          entityTypes: ["any"],
        }),
      },
    ],
    [],
  )
  return cachedMinimalCatalog
}

/** Test helper — loads the deploy-owned sync metadata artifact as a FlowCatalog. */
export function loadDeployFlowCatalogForTests(projectRoot = repoRoot) {
  const metadata = loadSyncMetadataArtifact(projectRoot)
  return buildFlowCatalog(
    metadata.phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      definition_json: JSON.stringify(phase.definition),
    })),
    metadata.actions.map((action) => ({
      id: action.id,
      label: action.label,
      definition_json: JSON.stringify(action.definition),
    })),
    (metadata.valueSources ?? []).map((source) => ({
      id: source.id,
      label: source.label,
      definition_json: JSON.stringify(source.definition),
    })),
  )
}
