/**
 * Structured diff between two DeployCatalogSnapshot documents.
 * Keys each catalog section by stable id and includes pretty JSON for UI diffs.
 */

import { emptyPlatformImportImpact, type PlatformImportImpact } from "@mia/shared-types"

import type { DeployCatalogSnapshot } from "./export-deploy-artifacts.js"

export type CatalogDiffSectionId =
  | "entities"
  | "configs"
  | "strategies"
  | "environments"
  | "flows"
  | "actions"
  | "valueSources"
  | "phases"

export type CatalogDiffEntry = {
  id: string
  kind: "create" | "update" | "delete"
  changedPaths: string[]
  beforeJson: string | null
  afterJson: string | null
}

export type CatalogDiffSection = {
  section: CatalogDiffSectionId
  label: string
  creates: CatalogDiffEntry[]
  updates: CatalogDiffEntry[]
  deletes: CatalogDiffEntry[]
}

export type DeployCatalogSnapshotDiff = {
  fromVersion: number | null
  toVersion: number
  against: "previous" | "active" | "version"
  sections: CatalogDiffSection[]
  /** Flattened impact for ImportImpactPanel-style summaries. */
  impact: PlatformImportImpact
  changeCount: number
}

const SECTION_LABELS: Record<CatalogDiffSectionId, string> = {
  entities: "Entities",
  configs: "Run configs",
  strategies: "Strategies",
  environments: "Environments",
  flows: "Flows",
  actions: "Actions",
  valueSources: "Value sources",
  phases: "Phases",
}

const IGNORE_KEYS = new Set(["_comment", "exportedAt", "__meta"])

export function diffDeployCatalogSnapshots(args: {
  from: DeployCatalogSnapshot | null
  to: DeployCatalogSnapshot
  fromVersion: number | null
  toVersion: number
  against: "previous" | "active" | "version"
}): DeployCatalogSnapshotDiff {
  const fromMaps = args.from ? extractSectionMaps(args.from) : emptySectionMaps()
  const toMaps = extractSectionMaps(args.to)
  const sections: CatalogDiffSection[] = []

  for (const section of Object.keys(SECTION_LABELS) as CatalogDiffSectionId[]) {
    const diff = diffKeyedMaps(fromMaps[section], toMaps[section])
    if (diff.creates.length === 0 && diff.updates.length === 0 && diff.deletes.length === 0) {
      continue
    }
    sections.push({
      section,
      label: SECTION_LABELS[section],
      ...diff,
    })
  }

  const impact = emptyPlatformImportImpact()
  for (const section of sections) {
    for (const entry of section.creates) impact.creates.push(`${section.section}:${entry.id}`)
    for (const entry of section.updates) impact.updates.push(`${section.section}:${entry.id}`)
    for (const entry of section.deletes) impact.deletes.push(`${section.section}:${entry.id}`)
  }

  return {
    fromVersion: args.fromVersion,
    toVersion: args.toVersion,
    against: args.against,
    sections,
    impact,
    changeCount:
      impact.creates.length + impact.updates.length + impact.deletes.length,
  }
}

type SectionMaps = Record<CatalogDiffSectionId, Map<string, unknown>>

function emptySectionMaps(): SectionMaps {
  return {
    entities: new Map(),
    configs: new Map(),
    strategies: new Map(),
    environments: new Map(),
    flows: new Map(),
    actions: new Map(),
    valueSources: new Map(),
    phases: new Map(),
  }
}

function configsFromSnapshot(snapshot: DeployCatalogSnapshot): unknown[] {
  if (snapshot.syncDefinitionConfigs?.configs?.length) {
    return snapshot.syncDefinitionConfigs.configs
  }
  const out: unknown[] = []
  for (const entry of snapshot.entityRegistry?.entities ?? []) {
    const record = asRecord(entry)
    if (!record) continue
    const run = asRecord(record.run)
    if (!run || typeof run.template !== "string") continue
    out.push({
      entityId: String(record.id ?? ""),
      flowPreset: run.template,
      serviceProfileRef: run.service ?? "default",
      environmentPolicyRef: run.environment ?? "default",
      ownershipTeam: run.ownershipTeam ?? "sync-platform",
      ownershipOwner: run.ownershipOwner ?? null,
      reviewStatus: run.reviewStatus ?? "legacy-review-required",
      ownershipNotes: Array.isArray(run.ownershipNotes) ? run.ownershipNotes : [],
    })
  }
  return out
}

function extractSectionMaps(snapshot: DeployCatalogSnapshot): SectionMaps {
  const syncMetadata = asRecord(snapshot.syncMetadata) ?? {}
  const flowsDoc = asRecord(snapshot.flowTemplates) ?? {}
  const flowSource =
    asRecord(flowsDoc.flowTemplates) ??
    asRecord(syncMetadata.flows) ??
    {}

  const entitiesWithoutRun = (snapshot.entityRegistry?.entities ?? []).map((entry) => {
    const record = asRecord(entry)
    if (!record) return entry
    const { run: _run, ...rest } = record
    return rest
  })

  return {
    entities: mapById(entitiesWithoutRun, "id"),
    configs: mapById(configsFromSnapshot(snapshot), "entityId"),
    strategies: mapById(asArray(asRecord(snapshot.strategies)?.strategies), "id"),
    environments: mapById(asArray(asRecord(snapshot.environments)?.environments), "name"),
    flows: mapRecordEntries(flowSource),
    actions: mapById(asArray(syncMetadata.actions ?? syncMetadata.stepTypes), "id"),
    valueSources: mapById(asArray(syncMetadata.valueSources ?? syncMetadata.customValueSources), "id"),
    phases: mapById(asArray(syncMetadata.phases), "id"),
  }
}

function diffKeyedMaps(
  from: Map<string, unknown>,
  to: Map<string, unknown>,
): Pick<CatalogDiffSection, "creates" | "updates" | "deletes"> {
  const creates: CatalogDiffEntry[] = []
  const updates: CatalogDiffEntry[] = []
  const deletes: CatalogDiffEntry[] = []

  for (const [id, value] of to) {
    if (!from.has(id)) {
      creates.push({
        id,
        kind: "create",
        changedPaths: [],
        beforeJson: null,
        afterJson: prettyJson(value),
      })
      continue
    }
    const before = from.get(id)
    const changedPaths = collectChangedPaths(before, value, "")
    if (changedPaths.length > 0) {
      updates.push({
        id,
        kind: "update",
        changedPaths,
        beforeJson: prettyJson(before),
        afterJson: prettyJson(value),
      })
    }
  }
  for (const [id, value] of from) {
    if (!to.has(id)) {
      deletes.push({
        id,
        kind: "delete",
        changedPaths: [],
        beforeJson: prettyJson(value),
        afterJson: null,
      })
    }
  }

  creates.sort((a, b) => a.id.localeCompare(b.id))
  deletes.sort((a, b) => a.id.localeCompare(b.id))
  updates.sort((a, b) => a.id.localeCompare(b.id))
  return { creates, updates, deletes }
}

export function collectChangedPaths(before: unknown, after: unknown, prefix: string): string[] {
  if (stableEqual(before, after)) return []

  const beforeIsObj = isPlainObject(before)
  const afterIsObj = isPlainObject(after)
  if (!beforeIsObj || !afterIsObj) {
    return [prefix || "(value)"]
  }

  const beforeObj = before as Record<string, unknown>
  const afterObj = after as Record<string, unknown>
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)])
  const paths: string[] = []

  for (const key of [...keys].sort()) {
    if (IGNORE_KEYS.has(key)) continue
    const nextPrefix = prefix ? `${prefix}.${key}` : key
    const left = beforeObj[key]
    const right = afterObj[key]
    if (!(key in beforeObj)) {
      paths.push(nextPrefix)
      continue
    }
    if (!(key in afterObj)) {
      paths.push(nextPrefix)
      continue
    }
    paths.push(...collectChangedPaths(left, right, nextPrefix))
  }
  return paths
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function mapById(rows: unknown[], idKey: string): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const row of rows) {
    if (!isPlainObject(row)) continue
    const id = row[idKey]
    if (typeof id !== "string" || !id.trim()) continue
    out.set(id, normalizeForCompare(row))
  }
  return out
}

function mapRecordEntries(record: Record<string, unknown>): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (const [key, value] of Object.entries(record)) {
    if (IGNORE_KEYS.has(key) || key === "version") continue
    out.set(key, normalizeForCompare(value))
  }
  return out
}

function normalizeForCompare(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => normalizeForCompare(entry))
  if (!isPlainObject(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (IGNORE_KEYS.has(key)) continue
    out[key] = normalizeForCompare(value[key])
  }
  return out
}

function stableEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? value : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
