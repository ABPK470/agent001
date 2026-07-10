#!/usr/bin/env node
/**
 * Export SQLite sync catalog to a timestamped folder on the user's machine.
 *
 *   npm run export-deploy-catalog --workspace @mia/server
 *   npm run export-deploy-catalog --workspace @mia/server -- --output ~/Downloads
 *   npm run export-deploy-catalog --workspace @mia/server -- --zip
 *   npm run export-deploy-catalog --workspace @mia/server -- --dry-run
 */

import { resolve } from "node:path"

import {
  buildDeployCatalogSnapshot,
  defaultExportParentDir,
  writeDeployCatalogSnapshot,
} from "../features/platform/application/export-deploy-artifacts.js"
import { openDatabase } from "../platform/persistence/connection.js"

main()

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  openDatabase()

  if (options.dryRun) {
    const snapshot = buildDeployCatalogSnapshot({
      tenantId: options.tenantId ?? undefined,
      includeRetiredEntities: options.includeRetired,
    })
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }

  const result = writeDeployCatalogSnapshot({
    outputParentDir: resolve(options.output),
    tenantId: options.tenantId ?? undefined,
    includeRetiredEntities: options.includeRetired,
    zip: options.zip,
    zipOnly: options.zipOnly,
  })

  console.log(`Exported SQLite catalog snapshot to ${result.folderPath}`)
  console.log(`  files: ${result.files.join(", ")}`)
  if (result.zipPath) {
    console.log(`  zip: ${result.zipPath}`)
  } else if (options.zip) {
    console.log("  zip: skipped (`zip` CLI not available)")
  }
  console.log(`  entities: ${result.snapshot.entityIds.length}`)
}

function parseArgs(argv: string[]): {
  output: string
  tenantId: string | null
  includeRetired: boolean
  zip: boolean
  zipOnly: boolean
  dryRun: boolean
} {
  const options = {
    output: defaultExportParentDir(),
    tenantId: null,
    includeRetired: false,
    zip: false,
    zipOnly: false,
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--output":
      case "-o":
        options.output = argv[++index] ?? options.output
        break
      case "--tenant":
        options.tenantId = argv[++index] ?? null
        break
      case "--include-retired":
        options.includeRetired = true
        break
      case "--zip":
        options.zip = true
        break
      case "--zip-only":
        options.zip = true
        options.zipOnly = true
        break
      case "--dry-run":
        options.dryRun = true
        break
      default:
        fail(`Unknown argument: ${arg}`)
    }
  }

  return options
}

function fail(message: string): never {
  console.error(`ERROR ${message}`)
  process.exit(1)
}
