#!/usr/bin/env node
/**
 * Export entity definitions only (subset of export-deploy-catalog).
 *
 *   npm run entity-registry:export --workspace @mia/server -- --output ~/Downloads
 */

import { resolve } from "node:path"

import { openDatabase } from "../infra/persistence/connection.js"
import {
  defaultExportParentDir,
  writeEntityRegistrySnapshot,
} from "../api/sync/service/export-entity-registry.js"

main()

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  openDatabase()

  const result = writeEntityRegistrySnapshot({
    outputParentDir: resolve(options.output),
    tenantId: options.tenantId ?? undefined,
    includeRetiredEntities: options.includeRetired,
  })

  console.log(`Exported ${result.entityIds.length} entity definition(s) to ${result.folderPath}`)
}

function parseArgs(argv: string[]): {
  output: string
  tenantId: string | null
  includeRetired: boolean
} {
  const options: { output: string; tenantId: string | null; includeRetired: boolean } = {
    output: defaultExportParentDir(),
    tenantId: null,
    includeRetired: false,
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
