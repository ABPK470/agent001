import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import {
  buildDeployCatalogSnapshot,
  exportTimestampFolderName,
  defaultExportParentDir,
} from "../../platform/service/export-deploy-artifacts.js"

function writeJsonFile(dir: string, name: string, doc: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
}

/** Entities-only snapshot — same folder convention as full catalog export. */
export function writeEntityRegistrySnapshot(options: {
  outputParentDir: string
  tenantId?: string
  includeRetiredEntities?: boolean
}): { folderPath: string; entityIds: string[] } {
  const snapshot = buildDeployCatalogSnapshot({
    tenantId: options.tenantId,
    includeRetiredEntities: options.includeRetiredEntities,
  })
  const folderName = exportTimestampFolderName(new Date(snapshot.exportedAt))
  const folderPath = resolve(options.outputParentDir, folderName)
  mkdirSync(folderPath, { recursive: true })

  mkdirSync(join(folderPath, "artifacts"), { recursive: true })

  writeJsonFile(folderPath, "manifest.json", {
    exportedAt: snapshot.exportedAt,
    tenantId: snapshot.tenantId,
    kind: "entity-registry-only",
    entityCount: snapshot.entityIds.length,
    entityIds: snapshot.entityIds,
    files: ["artifacts/entity-registry.json"],
  })

  if (!snapshot.entityRegistry) {
    throw new Error(`No entity definitions found for tenant ${snapshot.tenantId}.`)
  }

  writeJsonFile(join(folderPath, "artifacts"), "entity-registry.json", snapshot.entityRegistry)
  return { folderPath, entityIds: snapshot.entityIds }
}

export { defaultExportParentDir }
