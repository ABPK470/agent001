/**
 * Freeze-window evaluator — Phase 0 of governance integration.
 *
 * A freeze-window id is a tenant-defined token (e.g. `month-end`,
 * `release-week`). The full registry lives elsewhere (Phase 1 territory);
 * Phase 0 evaluates against a static, env-injected map populated by the
 * server at boot. If a freeze window referenced by an entity has no
 * matching definition the evaluator treats it as *inactive* and emits
 * a warning (so a typo doesn't accidentally block all syncs).
 */

export interface FreezeWindowDefinition {
  /** Stable id (matches `EntityPolicies.freezeWindowIds[]`). */
  id: string
  displayName: string
  description: string
  /** ISO-8601 inclusive start. */
  startsAt: string
  /** ISO-8601 exclusive end. */
  endsAt: string
}

export interface FreezeEvaluation {
  /** True when the window applies right now. */
  active: boolean
  /** Resolved windows that matched the entity's freezeWindowIds[]. */
  matched: FreezeWindowDefinition[]
  /** Active windows (subset of matched whose [start, end) brackets now). */
  activeWindows: FreezeWindowDefinition[]
  /** Ids referenced by the entity that have no registry definition. */
  unknownIds: string[]
}

let installedRegistry: ReadonlyMap<string, FreezeWindowDefinition> = new Map()

export function installFreezeWindowRegistry(defs: readonly FreezeWindowDefinition[]): void {
  installedRegistry = new Map(defs.map((d) => [d.id, d]))
}

export function listFreezeWindows(): readonly FreezeWindowDefinition[] {
  return [...installedRegistry.values()]
}

export function evaluateFreezeWindows(
  freezeWindowIds: readonly string[],
  now: Date = new Date()
): FreezeEvaluation {
  const matched: FreezeWindowDefinition[] = []
  const activeWindows: FreezeWindowDefinition[] = []
  const unknownIds: string[] = []

  for (const id of freezeWindowIds) {
    const def = installedRegistry.get(id)
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
