/**
 * Freeze-window evaluator — pure decision given an explicit registry.
 */
import type { FreezeEvaluation, FreezeWindowDefinition } from "../../domain/governance/freeze-windows.js"

export function evaluateFreezeWindows(
  freezeWindowIds: readonly string[],
  registry: ReadonlyMap<string, FreezeWindowDefinition>,
  now: Date = new Date()
): FreezeEvaluation {
  const matched: FreezeWindowDefinition[] = []
  const activeWindows: FreezeWindowDefinition[] = []
  const unknownIds: string[] = []

  for (const id of freezeWindowIds) {
    const def = registry.get(id)
    if (!def) {
      unknownIds.push(id)
      continue
    }
    matched.push(def)
    const startMs = Date.parse(def.startsAt)
    const endMs = Date.parse(def.endsAt)
    if (Number.isNaN(startMs) || Number.isNaN(endMs)) continue
    const nowMs = now.getTime()
    if (nowMs >= startMs && nowMs < endMs) activeWindows.push(def)
  }

  return {
    active: activeWindows.length > 0,
    matched,
    activeWindows,
    unknownIds
  }
}
