/**
 * Freeze-window registry — composition-root install + list.
 * Evaluation is pure in `core/governance/freeze-windows` (registry as parameter).
 * Public `evaluateFreezeWindows(ids, now?)` uses the installed registry for callers
 * that install at boot (server).
 */
import {
  evaluateFreezeWindows as evaluateFreezeWindowsPure
} from "../../core/governance/freeze-windows.js"
import type { FreezeEvaluation, FreezeWindowDefinition } from "../../domain/governance/freeze-windows.js"

let installedRegistry: ReadonlyMap<string, FreezeWindowDefinition> = new Map()

export function installFreezeWindowRegistry(defs: readonly FreezeWindowDefinition[]): void {
  installedRegistry = new Map(defs.map((d) => [d.id, d]))
}

export function listFreezeWindows(): readonly FreezeWindowDefinition[] {
  return [...installedRegistry.values()]
}

export function getInstalledFreezeWindowRegistry(): ReadonlyMap<string, FreezeWindowDefinition> {
  return installedRegistry
}

/** Boot-installed registry evaluate — thin shell over pure core. */
export function evaluateFreezeWindows(
  freezeWindowIds: readonly string[],
  now: Date = new Date()
): FreezeEvaluation {
  return evaluateFreezeWindowsPure(freezeWindowIds, installedRegistry, now)
}

export type { FreezeEvaluation, FreezeWindowDefinition }
