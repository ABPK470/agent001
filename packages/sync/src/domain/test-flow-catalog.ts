import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { buildFlowCatalog } from "./flow-catalog.js"
import { loadSyncMetadataArtifact } from "./load-sync-metadata-artifact.js"

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
        label: "Metadata sync",
        definition_json: JSON.stringify({
          summary: "Apply metadata change set",
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
    metadata.stepTypes.map((stepType) => ({
      id: stepType.id,
      label: stepType.label,
      definition_json: JSON.stringify(stepType.definition),
    })),
    (metadata.customValueSources ?? []).map((source) => ({
      id: source.id,
      label: source.label,
      definition_json: JSON.stringify(source.definition),
    })),
  )
}
