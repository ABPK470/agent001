#!/usr/bin/env node
/**
 * Export SQLite sync catalog state to deploy/sync artifacts (BYO-JSON round-trip).
 *
 *   npm run export-deploy-catalog --workspace @mia/server
 *   npm run export-deploy-catalog --workspace @mia/server -- --dry-run
 */

import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { exportDeployArtifactsFromSqlite } from "../features/platform/application/export-deploy-artifacts.js"
import { openDatabase } from "../platform/persistence/connection.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../../..")

main()

function main(): void {
  const dryRun = process.argv.includes("--dry-run")
  openDatabase()
  const result = exportDeployArtifactsFromSqlite({
    projectRoot: dryRun ? undefined : ROOT,
  })
  if (dryRun) {
    console.log("Dry run — catalog documents built but not written.")
    console.log(JSON.stringify(result, null, 2))
    return
  }
  for (const [key, relPath] of Object.entries(result.paths)) {
    console.log(`Wrote ${key}: ${relative(ROOT, resolve(ROOT, relPath))}`)
  }
}
