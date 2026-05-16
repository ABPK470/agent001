#!/usr/bin/env node
/**
 * entity-registry-cli.mjs — local-disk equivalent of the server's
 * `/api/entity-registry/entities/import-yaml` route, useful for CI
 * pre-checks and offline editing workflows.
 *
 * Subcommands:
 *   export <out-dir>     Dump every entity in the `_default` tenant to
 *                        `<out-dir>/<id>.yaml`. Overwrites existing files.
 *   import <in-path>     Parse a single YAML file (or every *.yaml in a
 *                        directory) and insert/upsert into the DB.
 *                        Use --dry-run to validate without writing.
 *
 * Connects to the same SQLite DB as the server. Run with the same
 * MIA_DATA_DIR / NODE_EXTRA_CA_CERTS env you use for the server.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const argv = process.argv.slice(2)
const cmd = argv[0]
const dryRun = argv.includes("--dry-run")
const tenantArg = argv.find((a) => a.startsWith("--tenant="))
const actorArg = argv.find((a) => a.startsWith("--actor="))
const reasonArg = argv.find((a) => a.startsWith("--reason="))
const tenant = tenantArg ? tenantArg.slice("--tenant=".length) : "_default"
const actor = actorArg ? actorArg.slice("--actor=".length) : "cli:" + (process.env["USER"] ?? "anonymous")
const reason = reasonArg ? reasonArg.slice("--reason=".length) : "cli import"

if (!cmd || !["export", "import"].includes(cmd)) {
  console.error(`usage:
  entity-registry-cli.mjs export <out-dir>  [--tenant=ID]
  entity-registry-cli.mjs import <in-path>  [--tenant=ID] [--actor=UPN] [--reason=...] [--dry-run]`)
  process.exit(64)
}

// Import server modules dynamically — keeps this script .mjs-friendly even
// though the server is TS (the build step emits a runtime entry point).
const serverDist = resolve(process.cwd(), "packages/server/dist")
if (!existsSync(serverDist)) {
  console.error(`[entity-registry-cli] packages/server/dist not found. Run \`npm run build\` first.`)
  process.exit(1)
}

const dbMod   = await import(pathToFileURL(join(serverDist, "db/index.js")).href)
const yamlMod = await import(pathToFileURL(join(serverDist, "sync/entity-yaml.js")).href)

if (cmd === "export") {
  const outDir = argv[1]
  if (!outDir) { console.error("export: missing <out-dir>"); process.exit(64) }
  mkdirSync(outDir, { recursive: true })
  const defs = dbMod.listEntityDefinitions(tenant, { includeRetired: true })
  for (const d of defs) {
    const path = join(outDir, `${d.id}.yaml`)
    writeFileSync(path, yamlMod.formatEntityYaml(d), "utf-8")
    console.log(`wrote ${path}`)
  }
  console.log(`exported ${defs.length} entit${defs.length === 1 ? "y" : "ies"} for tenant "${tenant}"`)
  process.exit(0)
}

// import path
const inPath = argv[1]
if (!inPath) { console.error("import: missing <in-path>"); process.exit(64) }
if (!existsSync(inPath)) { console.error(`import: not found: ${inPath}`); process.exit(1) }

const files = statSync(inPath).isDirectory()
  ? readdirSync(inPath).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).map((f) => join(inPath, f))
  : [inPath]

let imported = 0, skipped = 0, errors = 0
for (const file of files) {
  const text = readFileSync(file, "utf-8")
  const parsed = yamlMod.parseEntitiesYaml(text)
  for (const p of parsed) {
    if (!p.ok || !p.def) {
      console.error(`[error] ${file}: ${p.error}`)
      errors++; continue
    }
    if (dryRun) {
      console.log(`[dry-run] would save ${tenant}/${p.def.id}`)
      continue
    }
    try {
      const result = dbMod.saveEntityDefinition({
        tenantId: tenant,
        def:      { ...p.def, tenantId: tenant },
        actor,
        reason,
      })
      console.log(`saved ${tenant}/${result.id} v${result.version} (diff: ${result.diff.length} change(s))`)
      imported++
    } catch (e) {
      console.error(`[error] ${tenant}/${p.def.id}: ${(e instanceof Error ? e.message : String(e))}`)
      errors++
    }
  }
}
console.log(`done: imported=${imported}, skipped=${skipped}, errors=${errors}${dryRun ? " (dry-run)" : ""}`)
process.exit(errors > 0 ? 1 : 0)
