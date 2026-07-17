import type {
  AuthoredSyncFlowStep,
  CustomValueSourceDefinition,
  SyncFlowKindDefinition,
  SyncMetadataCatalogCustomValueSourceSaveBody,
} from "@mia/shared-types"
import {
  customValueSourceCatalogFromRows,
  handlerInputSlots,
  isStepBoundHandlerSlot,
  normalizeKindDefinition,
  parseCustomValueSourceDefinition,
  validateCatalogId,
  validateValueSource,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"

import * as db from "../../../infra/persistence/sqlite.js"
import { recordSyncCatalogChange } from "../../platform/application/sync-catalog-versioning.js"
import {
  buildFlowCatalogFromSyncMetadataDoc,
  prepareFlowStepsForStorage,
} from "../../../infra/persistence/sync-flow-steps.js"

const TENANT = "_default"

function afterCatalogMutation(reason: string, actor: string): void {
  recordSyncCatalogChange({ reason, actor })
}

function mapCatalog() {
  return {
    stepTypes: db.listSyncRunKinds(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      builtIn: row.built_in === 1,
      definition: db.mapKindDefinition(row),
    })),
    flows: db.listSyncRunPresets(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      description: row.description,
      steps: db.parsePresetSteps(row.steps_json),
      builtIn: row.built_in === 1,
    })),
    customValueSources: db.listSyncRunBindingSources(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      builtIn: row.built_in === 1,
      definition: db.mapCustomValueSourceDefinition(row),
    })),
  }
}

function customValueSourceCatalogFromDb(): Record<string, CustomValueSourceDefinition> {
  return customValueSourceCatalogFromRows(
    db.listSyncRunBindingSources(TENANT).map((row) => ({
      id: row.id,
      definition: db.mapCustomValueSourceDefinition(row),
    })),
  )
}

function validateHandlerBindings(
  definition: SyncFlowKindDefinition,
  catalogIds: Set<string>,
): string | null {
  for (const slot of handlerInputSlots(definition.handler)) {
    if (isStepBoundHandlerSlot(slot)) continue
    if (!slot.source) continue
    const sourceError = validateValueSource(slot.source, `Input "${slot.name}"`)
    if (sourceError) return sourceError
    if (slot.source.type === "catalog" && !catalogIds.has(slot.source.id)) {
      return `Input "${slot.name}" references unknown custom value source "${slot.source.id}".`
    }
  }
  return null
}

function flowCatalogFromDb() {
  return buildFlowCatalogFromSyncMetadataDoc({
    phases: db.listSyncRunPhases(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      sortOrder: row.sort_order,
      definition: db.mapPhaseDefinition(row),
    })),
    stepTypes: db.listSyncRunKinds(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      definition: db.mapKindDefinition(row),
    })),
    customValueSources: db.listSyncRunBindingSources(TENANT).map((row) => ({
      id: row.id,
      label: row.label,
      definition: db.mapCustomValueSourceDefinition(row),
    })),
  })
}

export function registerSyncMetadataRoutes(app: FastifyInstance): void {
  app.get("/api/sync-metadata", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    return mapCatalog()
  })

  app.post<{
    Body: { id: string; label: string; definition?: SyncFlowKindDefinition }
  }>("/api/sync-metadata/step-types", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    const id = req.body?.id?.trim()
    const label = req.body?.label?.trim()
    if (!id || !label) return reply.code(400).send({ error: "id and label required" })
    const idError = validateCatalogId(id, "Kind id")
    if (idError) return reply.code(400).send({ error: idError })
    const existing = db.listSyncRunKinds(TENANT).find((row) => row.id === id)
    const customCatalog = customValueSourceCatalogFromDb()
    const definition = req.body.definition
      ? normalizeKindDefinition(req.body.definition, id)
      : undefined
    const catalogIds = new Set(Object.keys(customCatalog))
    if (definition) {
      const bindingError = validateHandlerBindings(definition, catalogIds)
      if (bindingError) return reply.code(400).send({ error: bindingError })
    }
    db.saveSyncRunKind({
      tenant_id: TENANT,
      id,
      label,
      built_in: existing?.built_in ?? 0,
      definition_json: definition ? JSON.stringify(definition) : undefined,
    })
    afterCatalogMutation(`sync-metadata:step-type:${id}`, req.session.upn)
    return mapCatalog()
  })

  app.delete<{ Params: { id: string } }>("/api/sync-metadata/step-types/:id", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    if (!db.deleteSyncRunKind(TENANT, req.params.id)) {
      return reply.code(400).send({ error: "cannot delete built-in or missing kind" })
    }
    afterCatalogMutation(`sync-metadata:step-type:delete:${req.params.id}`, req.session.upn)
    return mapCatalog()
  })

  app.post<{
    Body: SyncMetadataCatalogCustomValueSourceSaveBody
  }>("/api/sync-metadata/binding-sources", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    const id = req.body?.id?.trim()
    const label = req.body?.label?.trim()
    if (!id || !label) return reply.code(400).send({ error: "id and label required" })
    const idError = validateCatalogId(id, "Custom value source id")
    if (idError) return reply.code(400).send({ error: idError })
    if (!req.body.definition) {
      return reply.code(400).send({ error: "definition required" })
    }
    let definition: CustomValueSourceDefinition
    try {
      definition = parseCustomValueSourceDefinition(req.body.definition, id)
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const existing = db.listSyncRunBindingSources(TENANT).find((row) => row.id === id)
    db.saveSyncRunBindingSource({
      tenant_id: TENANT,
      id,
      label,
      built_in: existing?.built_in ?? 0,
      definition_json: JSON.stringify(definition),
    })
    afterCatalogMutation(`sync-metadata:wiring:${id}`, req.session.upn)
    return mapCatalog()
  })

  app.delete<{ Params: { id: string } }>("/api/sync-metadata/binding-sources/:id", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    if (!db.deleteSyncRunBindingSource(TENANT, req.params.id)) {
      return reply.code(400).send({ error: "cannot delete built-in or missing custom value source" })
    }
    afterCatalogMutation(`sync-metadata:wiring:delete:${req.params.id}`, req.session.upn)
    return mapCatalog()
  })

  app.post<{
    Body: { id: string; label: string; description?: string; steps?: AuthoredSyncFlowStep[] }
  }>("/api/sync-metadata/flows", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    const id = req.body?.id?.trim()
    const label = req.body?.label?.trim()
    if (!id || !label) return reply.code(400).send({ error: "id and label required" })
    const idError = validateCatalogId(id, "Flow id")
    if (idError) return reply.code(400).send({ error: idError })
    const existing = db.getSyncRunPreset(TENANT, id)
    const flowCatalog = flowCatalogFromDb()
    const rawSteps = req.body.steps ?? (existing ? db.parsePresetSteps(existing.steps_json) : [])
    let steps: AuthoredSyncFlowStep[]
    try {
      steps = prepareFlowStepsForStorage(rawSteps, flowCatalog)
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      })
    }
    db.saveSyncRunPreset({
      tenant_id: TENANT,
      id,
      label,
      description: req.body.description?.trim() ?? existing?.description ?? "",
      steps_json: JSON.stringify(steps),
      built_in: existing?.built_in ?? 0,
      updated_at: new Date().toISOString(),
      updated_by: req.session.upn,
    })
    afterCatalogMutation(`sync-metadata:flow:${id}`, req.session.upn)
    return mapCatalog()
  })

  app.delete<{ Params: { id: string } }>("/api/sync-metadata/flows/:id", async (req, reply) => {
    if (!req.session?.isAdmin) return reply.code(403).send({ error: "admin only" })
    if (!db.deleteSyncRunPreset(TENANT, req.params.id)) {
      return reply.code(400).send({ error: "cannot delete built-in or missing flow" })
    }
    afterCatalogMutation(`sync-metadata:flow:delete:${req.params.id}`, req.session.upn)
    return mapCatalog()
  })
}
