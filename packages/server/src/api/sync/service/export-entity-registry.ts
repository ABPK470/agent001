import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { EntityDefinition } from "@mia/sync"

import {
  buildDeployCatalogSnapshot,
  exportTimestampFolderName,
  defaultExportParentDir,
} from "../../platform/service/export-deploy-artifacts.js"
import { formatEntityJson } from "../types/entity-yaml.js"
import * as db from "../../../infra/persistence/sqlite.js"

/** Entities-only snapshot — same tree as full catalog export (`artifacts/entities/`). */
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
  const entitiesDir = join(folderPath, "artifacts", "entities")
  mkdirSync(entitiesDir, { recursive: true })

  const definitions = db.listEntityDefinitions(snapshot.tenantId, {
    includeRetired: options.includeRetiredEntities ?? false,
  }) as EntityDefinition[]
  if (definitions.length === 0) {
    throw new Error(`No entity definitions found for tenant ${snapshot.tenantId}.`)
  }

  const entityFiles = definitions.map((def) => {
    const name = `${def.id}.json`
    writeFileSync(join(entitiesDir, name), formatEntityJson(def), "utf-8")
    return `artifacts/entities/${name}`
  })

  writeFileSync(
    join(folderPath, "manifest.json"),
    `${JSON.stringify(
      {
        exportedAt: snapshot.exportedAt,
        tenantId: snapshot.tenantId,
        kind: "entity-registry-only",
        entityCount: snapshot.entityIds.length,
        entityIds: snapshot.entityIds,
        layout: "deploy/sync mirror",
        files: entityFiles,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  )

  return { folderPath, entityIds: snapshot.entityIds }
}

export { defaultExportParentDir }
