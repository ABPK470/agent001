/**
 * On-boot import of seed `EntityDefinition` YAMLs from
 * `deploy/mssql/entities/`. Idempotent: only entities not already present
 * in the registry are imported. Failures are non-fatal — the server still
 * starts, the legacy bundled JSON path keeps working, and the operator
 * sees a console warning.
 *
 * Seed file layout:
 *   deploy/mssql/entities/<id>.yaml      one definition per file (preferred)
 *   deploy/mssql/entities/_all.yaml      multi-doc fallback (optional)
 *
 * The seeder runs once per boot. Re-importing after an edit is a manual
 * action via the import-yaml route.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { getEntityDefinition, saveEntityDefinition } from "../db/index.js"
import { parseEntitiesYaml } from "./entity-yaml.js"

const DEFAULT_TENANT_ID = "_default"
const SEED_ACTOR = "boot:seed"
const SEED_REASON = "bootstrap from deploy/mssql/entities/"

export interface BootstrapResult {
  imported: number
  skipped: number
  errors: string[]
}

export function bootstrapEntityRegistryFromYaml(projectRoot: string): BootstrapResult {
  const dir = resolve(projectRoot, "deploy", "mssql", "entities")
  const out: BootstrapResult = { imported: 0, skipped: 0, errors: [] }
  if (!existsSync(dir)) return out

  const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort()
  for (const file of files) {
    const path = join(dir, file)
    let text: string
    try { text = readFileSync(path, "utf-8") } catch (e) {
      out.errors.push(`read ${file}: ${(e as Error).message}`)
      continue
    }
    const parsed = parseEntitiesYaml(text)
    for (const p of parsed) {
      if (!p.ok || !p.def) {
        out.errors.push(`${file}: ${p.error ?? "unknown parse error"}`)
        continue
      }
      const existing = getEntityDefinition(DEFAULT_TENANT_ID, p.def.id, { includeRetired: true })
      if (existing) { out.skipped++; continue }
      try {
        saveEntityDefinition({
          tenantId: DEFAULT_TENANT_ID,
          def:      { ...p.def, tenantId: DEFAULT_TENANT_ID },
          actor:    SEED_ACTOR,
          reason:   SEED_REASON,
        })
        out.imported++
      } catch (e) {
        out.errors.push(`${file} (${p.def.id}): ${(e as Error).message}`)
      }
    }
  }
  return out
}
