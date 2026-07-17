/**
 * Platform import gate — the only response shape for file/snapshot imports
 * that mutate platform config (connectors, catalog, deploy artifacts, etc.).
 */

export type PlatformImportImpact = {
  creates: string[]
  updates: string[]
  retires: string[]
  deletes: string[]
  skips: Array<{ id: string; reason: string }>
}

export type PlatformImportGateResult = {
  ok: boolean
  dryRun: boolean
  applied: boolean
  errors: string[]
  warnings: string[]
  impact: PlatformImportImpact
  counts: Record<string, number>
  /** Optional catalog version pointer after apply / rollback. */
  version?: { version: number }
}

export function emptyPlatformImportImpact(): PlatformImportImpact {
  return {
    creates: [],
    updates: [],
    retires: [],
    deletes: [],
    skips: [],
  }
}
