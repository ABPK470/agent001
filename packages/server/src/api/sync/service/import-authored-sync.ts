/**
 * Import deploy artifacts (AuthoredSyncDefinition) into SQLite — format A → B.
 */

import { EventType } from "@mia/shared-enums"
import type { AuthoredSyncDefinition, EntityRegistryYamlImportResponse } from "@mia/shared-types"
import { entityDefinitionFromAuthoredSync, validateEntityDefinition, type ValidationResult } from "@mia/sync"

import { broadcast } from "../../../infra/events/broadcaster.js"
import * as db from "../../../infra/persistence/sqlite.js"
import { entityImportToGate } from "../../platform/service/import-gate.js"
import { recordSyncCatalogChange } from "../../platform/service/sync-catalog-versioning.js"
import { parseAuthoredSyncJson } from "../types/authored-sync-document.js"
import { loadAuthoringFlowCatalog, syncConfigFromAuthoredSync, upsertSyncDefinitionConfig } from "./definitions.js"

export function importAuthoredSyncFromText(args: {
  tenantId: string
  actor: string
  reason: string
  content: string
  projectRoot: string
  dryRun: boolean
}): EntityRegistryYamlImportResponse {
  const parsed = parseAuthoredSyncJson(args.content)
  const saved: EntityRegistryYamlImportResponse["saved"] = []
  const skipped: EntityRegistryYamlImportResponse["skipped"] = []
  const rowErrors: EntityRegistryYamlImportResponse["rowErrors"] = []

  const flowTemplateCatalog = loadAuthoringFlowCatalog(args.projectRoot, args.tenantId)

  for (const item of parsed) {
    if (!item.ok || !item.authored) {
      rowErrors.push({ id: null, error: item.error ?? "unknown parse error" })
      continue
    }
    const result = importOneAuthoredSync({
      authored: item.authored,
      tenantId: args.tenantId,
      actor: args.actor,
      reason: args.reason,
      projectRoot: args.projectRoot,
      dryRun: args.dryRun,
      flowTemplateCatalog,
    })
    if (result.error) {
      rowErrors.push({ id: result.id, error: result.error })
      continue
    }
    if (result.skipped) {
      skipped.push({ id: result.id!, reason: result.skipped })
      continue
    }
    saved.push({ id: result.id!, version: result.version!, created: result.created! })
  }

  if (!args.dryRun && saved.length > 0) {
    recordSyncCatalogChange({
      tenantId: args.tenantId,
      reason: `entity-registry:import-authored-compat:${args.reason}`,
      actor: args.actor,
    })
  }

  const ok = rowErrors.length === 0
  const gate = entityImportToGate({ ok, dryRun: args.dryRun, saved, skipped, errors: rowErrors })
  return { ...gate, saved, skipped, rowErrors }
}

export function importOneAuthoredSync(args: {
  authored: AuthoredSyncDefinition
  tenantId: string
  actor: string
  reason: string
  projectRoot: string
  dryRun: boolean
  flowTemplateCatalog: ReturnType<typeof loadAuthoringFlowCatalog>
}): {
  id: string | null
  version?: number
  created?: boolean
  error?: string | ValidationResult
  skipped?: string
} {
  const def = entityDefinitionFromAuthoredSync(args.authored, args.tenantId)
  const validation = validateEntityDefinition(def)
  if (!validation.ok) {
    return { id: def.id, error: validation }
  }

  const existing = db.getEntityDefinition(args.tenantId, def.id, { includeRetired: true })
  const created = existing === null

  if (args.dryRun) {
    return { id: def.id, version: existing ? existing.version + 1 : 1, created }
  }

  try {
    const result = db.saveEntityDefinition({
      tenantId: args.tenantId,
      def,
      actor: args.actor,
      reason: args.reason,
    })
    const configRow = syncConfigFromAuthoredSync(
      args.tenantId,
      def,
      args.authored,
      args.flowTemplateCatalog,
      args.actor,
      db.getSyncDefinitionConfig(args.tenantId, def.id),
    )
    upsertSyncDefinitionConfig(args.projectRoot, configRow)
    broadcast({
      type: EventType.EntityRegistryImported,
      data: {
        tenantId: args.tenantId,
        id: result.id,
        version: result.version,
        created,
        actor: args.actor,
      },
    })
    return { id: result.id, version: result.version, created }
  } catch (error) {
    if (error instanceof db.EntityRegistryValidationError) {
      return { id: def.id, error: error.result }
    }
    return { id: def.id, error: (error as Error).message }
  }
}
