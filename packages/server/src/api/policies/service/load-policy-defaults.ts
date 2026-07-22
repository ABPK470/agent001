/**
 * Load factory policy defaults from `deploy/policies/defaults.json`.
 *
 * Same dialect as connectors / sync-environments: deploy JSON is the factory
 * seed; SQLite (Policies UI) is the runtime source of truth after first boot.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { isPolicyEffect, type PolicyRule } from "@mia/agent"

export const POLICY_DEFAULTS_SEED_PATH = "deploy/policies/defaults.json"

export interface PolicyDefaultsFile {
  version: 1
  rules: PolicyRule[]
}

export function policyDefaultsPath(projectRoot: string): string {
  return resolve(projectRoot, POLICY_DEFAULTS_SEED_PATH)
}

/**
 * Read + validate factory defaults. Throws if the file is missing or invalid
 * — silent empty defaults would hide a broken release.
 */
export function loadPolicyDefaults(projectRoot: string): PolicyDefaultsFile {
  const path = policyDefaultsPath(projectRoot)
  if (!existsSync(path)) {
    throw new Error(`Policy factory seed missing: ${path}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, "utf-8")) as unknown
  } catch (error) {
    throw new Error(
      `Policy factory seed is not valid JSON (${path}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Policy factory seed must be an object (${path})`)
  }

  const doc = raw as Record<string, unknown>
  if (doc.version !== 1) {
    throw new Error(`Policy factory seed version must be 1 (${path})`)
  }
  if (!Array.isArray(doc.rules) || doc.rules.length === 0) {
    throw new Error(`Policy factory seed requires a non-empty rules array (${path})`)
  }

  const rules: PolicyRule[] = []
  const seen = new Set<string>()
  for (const [index, entry] of doc.rules.entries()) {
    const label = `${path} rules[${index}]`
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${label}: must be an object`)
    }
    const row = entry as Record<string, unknown>
    if (typeof row.name !== "string" || !row.name.trim()) {
      throw new Error(`${label}: name is required`)
    }
    if (!isPolicyEffect(row.effect)) {
      throw new Error(`${label}: effect must be allow, require_approval, or deny`)
    }
    if (typeof row.condition !== "string" || !row.condition.trim()) {
      throw new Error(`${label}: condition is required`)
    }
    if (!row.parameters || typeof row.parameters !== "object" || Array.isArray(row.parameters)) {
      throw new Error(`${label}: parameters must be an object`)
    }
    if (seen.has(row.name)) {
      throw new Error(`${label}: duplicate rule name "${row.name}"`)
    }
    seen.add(row.name)
    rules.push({
      name: row.name,
      effect: row.effect,
      condition: row.condition,
      parameters: row.parameters as Record<string, unknown>,
    })
  }

  return { version: 1, rules }
}
