import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { AuthoredSyncDefinition, PublishedSyncDefinition } from "@mia/shared-types"

export interface LoadedAuthoredSyncDefinition {
  filePath: string
  definition: AuthoredSyncDefinition
}

export interface RepoPublishedSyncDefinitionBundle {
  version: 1
  publishedAt: string
  publishedVersion: string
  definitions: Record<string, PublishedSyncDefinition | null>
}

export const DEFAULT_AUTHORED_DEFINITIONS_DIR = "deploy/sync/entities"
export const DEFAULT_PUBLISHED_DEFINITIONS_PATH = "sync-definitions/published/definitions.bundle.json"

export function loadAuthoredSyncDefinitions(projectRoot: string, relDir = DEFAULT_AUTHORED_DEFINITIONS_DIR): LoadedAuthoredSyncDefinition[] {
  const definitionsDir = resolve(projectRoot, relDir)
  mkdirSync(definitionsDir, { recursive: true })
  return readdirSync(definitionsDir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const filePath = resolve(definitionsDir, name)
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as AuthoredSyncDefinition
      return { filePath, definition: parsed }
    })
}

export function validateAuthoredSyncDefinitions(items: LoadedAuthoredSyncDefinition[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const ids = new Set<string>()

  for (const { filePath, definition } of items) {
    if (definition.schemaVersion !== 1) errors.push(`${filePath}: schemaVersion must be 1`)
    if (!isNonEmptyString(definition.id)) errors.push(`${filePath}: id is required`)
    if (definition.id && ids.has(definition.id)) errors.push(`${filePath}: duplicate id ${definition.id}`)
    ids.add(definition.id)
    if (!isNonEmptyString(definition.displayName)) errors.push(`${filePath}: displayName is required`)
    if (!isNonEmptyString(definition.rootTable)) errors.push(`${filePath}: rootTable is required`)
    if (!isNonEmptyString(definition.idColumn)) errors.push(`${filePath}: idColumn is required`)
    if (!Array.isArray(definition.metadata?.tables) || definition.metadata.tables.length === 0) errors.push(`${filePath}: metadata.tables must be a non-empty array`)
    if (!Array.isArray(definition.metadata?.executionOrder)) errors.push(`${filePath}: metadata.executionOrder must be an array`)
    if (!Array.isArray(definition.metadata?.reverseOrder)) errors.push(`${filePath}: metadata.reverseOrder must be an array`)
    if (!Array.isArray(definition.executionFlow?.steps) || definition.executionFlow.steps.length === 0) errors.push(`${filePath}: executionFlow.steps must be a non-empty array`)
    if (!Number.isFinite(definition.governance?.riskMultiplier) || definition.governance.riskMultiplier <= 0) errors.push(`${filePath}: governance.riskMultiplier must be > 0`)
    if (!isNonEmptyString(definition.ownership?.team)) errors.push(`${filePath}: ownership.team is required`)
    if (!["legacy-review-required", "reviewed"].includes(definition.ownership?.reviewStatus)) errors.push(`${filePath}: ownership.reviewStatus must be legacy-review-required or reviewed`)
    if (!Array.isArray(definition.ownership?.notes)) errors.push(`${filePath}: ownership.notes must be an array`)

    const tableNames = new Set<string>()
    for (const table of definition.metadata?.tables ?? []) {
      if (!isNonEmptyString(table.name)) errors.push(`${filePath}: every metadata table must have a name`)
      if (tableNames.has(table.name)) errors.push(`${filePath}: duplicate metadata table ${table.name}`)
      tableNames.add(table.name)
      if (typeof table.predicate !== "string") errors.push(`${filePath}: table ${table.name} must define predicate`)
    }
    ensureSameMembers(filePath, "executionOrder", definition.metadata?.executionOrder ?? [], tableNames, errors)
    ensureSameMembers(filePath, "reverseOrder", definition.metadata?.reverseOrder ?? [], tableNames, errors)

    const flowIds = new Set<string>()
    let metadataSyncCount = 0
    for (const stepDef of definition.executionFlow?.steps ?? []) {
      if (!isNonEmptyString(stepDef.id)) errors.push(`${filePath}: every execution step must have id`)
      if (flowIds.has(stepDef.id)) errors.push(`${filePath}: duplicate execution step ${stepDef.id}`)
      flowIds.add(stepDef.id)
      if (stepDef.kind === "metadataSync") metadataSyncCount++
      if (!isNonEmptyString(stepDef.phase)) errors.push(`${filePath}: execution step ${stepDef.id} must define phase`)
      if (!isNonEmptyString(stepDef.kind)) errors.push(`${filePath}: execution step ${stepDef.id} must define kind`)
    }
    if (metadataSyncCount !== 1) errors.push(`${filePath}: executionFlow must contain exactly one metadataSync step`)

    const unverified = (definition.metadata?.tables ?? []).filter((table) => table.verified === false)
    if (unverified.length > 0) warnings.push(`${filePath}: contains ${unverified.length} unverified table(s): ${unverified.map((table) => table.name).join(", ")}`)
  }

  return { errors, warnings }
}

export function compilePublishedSyncDefinitions(items: LoadedAuthoredSyncDefinition[], publishedAt = new Date().toISOString()): RepoPublishedSyncDefinitionBundle {
  const publishedVersion = publishedAt
  const definitions: Record<string, PublishedSyncDefinition | null> = {}
  for (const { definition } of items) {
    definitions[definition.id] = {
      ...definition,
      publishedAt,
      publishedVersion,
    }
  }
  return {
    version: 1,
    publishedAt,
    publishedVersion,
    definitions,
  }
}

export function writePublishedSyncDefinitionBundle(projectRoot: string, bundle: RepoPublishedSyncDefinitionBundle, relPath = DEFAULT_PUBLISHED_DEFINITIONS_PATH): string {
  const outputPath = resolve(projectRoot, relPath)
  mkdirSync(resolve(projectRoot, "sync-definitions", "published"), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(bundle, null, 2)}\n`)
  return outputPath
}

export function normalizePublishedBundleForCheck(bundle: RepoPublishedSyncDefinitionBundle): RepoPublishedSyncDefinitionBundle {
  const normalizedDefinitions: RepoPublishedSyncDefinitionBundle["definitions"] = {}
  for (const [entityId, definition] of Object.entries(bundle.definitions ?? {})) {
    normalizedDefinitions[entityId] = definition
      ? { ...definition, publishedAt: "<normalized>", publishedVersion: "<normalized>" }
      : definition
  }
  return {
    ...bundle,
    publishedAt: "<normalized>",
    publishedVersion: "<normalized>",
    definitions: normalizedDefinitions,
  }
}

function ensureSameMembers(filePath: string, label: string, orderedList: string[], tableNames: Set<string>, errors: string[]): void {
  const orderedSet = new Set(orderedList)
  for (const name of orderedList) {
    if (!tableNames.has(name)) errors.push(`${filePath}: ${label} references unknown table ${name}`)
  }
  for (const tableName of tableNames) {
    if (!orderedSet.has(tableName)) errors.push(`${filePath}: ${label} is missing table ${tableName}`)
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}