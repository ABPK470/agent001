import { parseBoundaryJson } from "../../../internal/parse-json.js"

/**
 * Connectors import — plan (dry-run) + apply through the platform import gate.
 * Fail-closed: any invalid entry blocks the whole import.
 */

import {
  getConnectorKind,
  isConnectorKindId,
  SECRET_MASK,
  toConnectorId,
  validateConnectorConfig,
  withConnectorConfigDefaults,
  type Connector,
  type ConnectorKindId,
  type PlatformImportGateResult,
} from "@mia/shared-types"
import * as db from "../../../infra/persistence/sqlite.js"
import {
  assertCanApply,
  emptyImpact,
  gateResult,
  requireReason,
} from "../../platform/service/import-gate.js"

type ConfigValue = string | number | boolean | null
type ConfigMap = Record<string, ConfigValue>

export type ConnectorImportEntry = {
  id: string
  kind: ConnectorKindId
  name: string
  displayName: string
  enabled: boolean
  config: ConfigMap
  action: "create" | "update"
}

export type ConnectorImportPlan = {
  ok: boolean
  errors: string[]
  warnings: string[]
  entries: ConnectorImportEntry[]
}

function parseRow(row: db.DbConnector): Connector {
  const body = parseBoundaryJson(row.body_json) as Connector
  return {
    ...body,
    id: row.id,
    kind: row.kind as ConnectorKindId,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }
}

function coerceConfigValue(
  value: unknown,
  type: "text" | "password" | "number" | "boolean" | "url",
): ConfigValue {
  if (value === null || value === undefined) return null
  if (type === "number") {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }
  if (type === "boolean") return Boolean(value)
  return typeof value === "string" ? value : String(value)
}

function sanitiseConfig(kind: ConnectorKindId, raw: unknown): ConfigMap | string {
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return "config must be an object"
  }
  const schema = getConnectorKind(kind)?.configSchema ?? []
  const out: ConfigMap = {}
  for (const field of schema) {
    out[field.key] = coerceConfigValue((raw as Record<string, unknown>)[field.key], field.type)
  }
  return out
}

function mergeSecretsOnUpdate(
  kind: ConnectorKindId,
  posted: ConfigMap,
  stored: ConfigMap,
): ConfigMap {
  const out: ConfigMap = { ...posted }
  for (const field of getConnectorKind(kind)?.configSchema ?? []) {
    if (field.type !== "password") continue
    const value = out[field.key]
    if (value === SECRET_MASK || value === undefined || value === null || value === "") {
      out[field.key] = stored[field.key] ?? null
    }
  }
  return out
}

function serialise(
  connector: Connector,
  actor: string | null,
  createdAt?: string,
): db.DbConnector {
  const now = new Date().toISOString()
  return {
    id: connector.id,
    kind: connector.kind,
    body_json: JSON.stringify(connector),
    enabled: connector.enabled ? 1 : 0,
    created_at: createdAt ?? now,
    updated_at: now,
    updated_by: actor,
  }
}

export function planConnectorsImport(args: {
  version: unknown
  connectors: unknown
}): ConnectorImportPlan {
  const errors: string[] = []
  const warnings: string[] = []
  const entries: ConnectorImportEntry[] = []

  if (args.version !== 1) {
    return { ok: false, errors: ["unsupported import version (expected version: 1)"], warnings, entries }
  }
  if (!Array.isArray(args.connectors)) {
    return { ok: false, errors: ["connectors must be an array"], warnings, entries }
  }
  if (args.connectors.length === 0) {
    return { ok: false, errors: ["connectors array is empty"], warnings, entries }
  }

  const seen = new Set<string>()
  for (let index = 0; index < args.connectors.length; index++) {
    const entry = args.connectors[index]
    const label = `connectors[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label}: must be an object`)
      continue
    }
    const row = entry as Record<string, unknown>
    const kind = row["kind"]
    if (!isConnectorKindId(kind)) {
      errors.push(`${label}: unknown or missing kind`)
      continue
    }
    const kindDef = getConnectorKind(kind)
    if (!kindDef?.enabled) {
      errors.push(`${label}: connector kind "${kind}" is not enabled`)
      continue
    }
    const id = typeof row["id"] === "string" ? toConnectorId(row["id"]) : ""
    const name = typeof row["name"] === "string" ? row["name"].trim() : id
    if (!id || !name) {
      errors.push(`${label}: id and name are required`)
      continue
    }
    if (seen.has(id)) {
      errors.push(`${label}: duplicate connector id "${id}"`)
      continue
    }
    seen.add(id)

    const sanitised = sanitiseConfig(kind, row["config"])
    if (typeof sanitised === "string") {
      errors.push(`${label} (${id}): ${sanitised}`)
      continue
    }

    const existing = db.getConnector(id)
    const resolvedConfig =
      existing && row["config"] !== undefined
        ? mergeSecretsOnUpdate(kind, sanitised, parseRow(existing).config)
        : withConnectorConfigDefaults(kind, sanitised)

    const validation = validateConnectorConfig(kind, resolvedConfig)
    if (!validation.ok) {
      errors.push(`${label} (${id}): ${validation.error ?? "config is invalid"}`)
      continue
    }

    entries.push({
      id,
      kind,
      name,
      displayName:
        typeof row["displayName"] === "string" && row["displayName"].trim()
          ? row["displayName"].trim()
          : name,
      enabled: row["enabled"] !== false,
      config: resolvedConfig,
      action: existing ? "update" : "create",
    })
  }

  return {
    ok: errors.length === 0 && entries.length > 0,
    errors,
    warnings,
    entries,
  }
}

function planToGate(plan: ConnectorImportPlan, dryRun: boolean, applied: boolean): PlatformImportGateResult {
  const impact = emptyImpact()
  for (const entry of plan.entries) {
    if (entry.action === "create") impact.creates.push(entry.id)
    else impact.updates.push(entry.id)
  }
  return gateResult({
    ok: plan.ok,
    dryRun,
    applied,
    errors: plan.errors,
    warnings: plan.warnings,
    impact,
    counts: {
      creates: impact.creates.length,
      updates: impact.updates.length,
      total: plan.entries.length,
    },
  })
}

export function importConnectors(args: {
  version: unknown
  connectors: unknown
  dryRun: boolean
  reason: unknown
  actor: string
}): PlatformImportGateResult {
  const plan = planConnectorsImport({
    version: args.version,
    connectors: args.connectors,
  })
  const preview = planToGate(plan, true, false)

  if (args.dryRun) return preview

  const blocked = assertCanApply({ dryRun: false, reason: args.reason, ok: plan.ok })
  if (blocked) {
    return gateResult({
      ok: false,
      dryRun: false,
      applied: false,
      errors: [...plan.errors, blocked],
      warnings: plan.warnings,
      impact: preview.impact,
      counts: preview.counts,
    })
  }

  // Re-plan so apply never trusts a stale client dry-run.
  const fresh = planConnectorsImport({
    version: args.version,
    connectors: args.connectors,
  })
  if (!fresh.ok) return planToGate(fresh, false, false)

  const reason = requireReason(args.reason)!
  const now = new Date().toISOString()
  for (const entry of fresh.entries) {
    const existing = db.getConnector(entry.id)
    const connector: Connector = {
      id: entry.id,
      kind: entry.kind,
      name: entry.name,
      displayName: entry.displayName,
      config: entry.config,
      enabled: entry.enabled,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      updatedBy: args.actor,
    }
    db.saveConnector(serialise(connector, args.actor, existing?.created_at))
  }

  const applied = planToGate(fresh, false, true)
  applied.warnings = [...applied.warnings, `reason: ${reason}`]
  return applied
}
