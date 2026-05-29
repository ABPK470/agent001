import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import * as db from "../adapters/persistence/sqlite.js"
import { formatEntitiesYaml } from "../adapters/sync/entity-yaml.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../../../")
const DEFAULT_TENANT_ID = "_default"

main()

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const tenantId = options.tenantId ?? DEFAULT_TENANT_ID
  const outputPath = resolve(ROOT, options.output)
  const definitions = db.listEntityDefinitions(tenantId, { includeRetired: options.includeRetired })

  if (definitions.length === 0) {
    fail(`No entity definitions found for tenant ${tenantId}.`)
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, formatEntitiesYaml(definitions), "utf-8")
  console.log(`Exported ${definitions.length} entity definition(s) to ${relative(ROOT, outputPath)}`)
}

function parseArgs(argv: string[]): {
  output: string
  tenantId: string | null
  includeRetired: boolean
} {
  const options = {
    output: "deploy/sync/entity-registry.seed.yaml",
    tenantId: null,
    includeRetired: false,
  } as {
    output: string
    tenantId: string | null
    includeRetired: boolean
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--output":
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