/**
 * Load deploy-owned SCD2 strategy presets.
 *
 * Authority: deploy/sync/artifacts/strategies.json → SQLite → runtime resolve.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import type { Scd2Strategy } from "../../domain/entity-registry/types.js"
import { validateScd2Strategy } from "../../core/entity-registry/validate.js"

export const DEFAULT_STRATEGIES_ARTIFACT_PATH = "deploy/sync/artifacts/strategies.json"

export interface StrategiesArtifact {
  version: 1
  _comment?: string
  strategies: Scd2Strategy[]
}

export function loadStrategiesArtifact(
  projectRoot: string,
  relPath = DEFAULT_STRATEGIES_ARTIFACT_PATH,
): StrategiesArtifact {
  const path = resolve(projectRoot, relPath)
  if (!existsSync(path)) {
    throw new Error(`Strategies artifact not found at ${relPath}.`)
  }
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<StrategiesArtifact>
  if (parsed.version !== 1) {
    throw new Error(`Unsupported strategies artifact version: ${String(parsed.version)}`)
  }
  if (!Array.isArray(parsed.strategies) || parsed.strategies.length === 0) {
    throw new Error(`Strategies artifact at ${relPath} is missing strategies.`)
  }
  for (const strategy of parsed.strategies) {
    const validation = validateScd2Strategy(strategy)
    if (!validation.ok) {
      throw new Error(
        `Invalid strategy "${strategy?.id ?? "?"}" in ${relPath}: ${validation.errors.join("; ")}`,
      )
    }
  }
  return parsed as StrategiesArtifact
}

export function shippedScd2Strategies(projectRoot: string): readonly Scd2Strategy[] {
  return loadStrategiesArtifact(projectRoot).strategies
}

export function shippedStrategyById(projectRoot: string, id: string): Scd2Strategy | undefined {
  return shippedScd2Strategies(projectRoot).find((strategy) => strategy.id === id)
}
