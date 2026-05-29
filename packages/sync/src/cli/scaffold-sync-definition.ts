import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { EntityRegistrySyncFlowTemplateId } from "@mia/shared-types"

import {
    defaultSyncDefinitionFlowTemplateId,
    loadEntityDefinitionsFromDocument,
    loadSyncDefinitionFlowTemplateCatalog,
    scaffoldSyncDefinition,
    selectEntityDefinition,
} from "../domain/index.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../../../")

main()

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  if (!options.input) fail("Missing required --input <path>.")

  const inputPath = resolve(ROOT, options.input)
  const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(ROOT)
  const docs = loadEntityDefinitionsFromDocument(inputPath)
  const entity = selectEntityDefinition(docs, options.entity)
  const flowTemplateId = options.flowTemplateId ?? defaultSyncDefinitionFlowTemplateId(entity.id, flowTemplateCatalog)
  const scaffold = scaffoldSyncDefinition(entity, {
    projectRoot: ROOT,
    sourceArtifact: inputPath,
    flowTemplateId,
    serviceProfileRef: options.serviceProfileRef ?? "default",
    environmentPolicyRef: options.environmentPolicyRef ?? "default",
    flowTemplateCatalog,
  })
  const serialized = `${JSON.stringify(scaffold, null, 2)}\n`

  if (options.write || options.output) {
    const outputPath = resolve(ROOT, options.output ?? `deploy/sync/entities/${entity.id}.json`)
    if (existsSync(outputPath) && !options.force) {
      fail(`Refusing to overwrite existing file without --force: ${relative(ROOT, outputPath)}`)
    }
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, serialized)
    console.log(`Wrote scaffold to ${relative(ROOT, outputPath)}`)
    return
  }

  process.stdout.write(serialized)
}

function parseArgs(argv: string[]): {
  input: string | null
  output: string | null
  entity: string | null
  flowTemplateId: EntityRegistrySyncFlowTemplateId | null
  serviceProfileRef: string | null
  environmentPolicyRef: string | null
  write: boolean
  force: boolean
} {
  const options: {
    input: string | null
    output: string | null
    entity: string | null
    flowTemplateId: EntityRegistrySyncFlowTemplateId | null
    serviceProfileRef: string | null
    environmentPolicyRef: string | null
    write: boolean
    force: boolean
  } = {
    input: null,
    output: null,
    entity: null,
    flowTemplateId: null,
    serviceProfileRef: null,
    environmentPolicyRef: null,
    write: false,
    force: false,
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--input":
        options.input = argv[++index] ?? null
        break
      case "--output":
        options.output = argv[++index] ?? null
        break
      case "--entity":
        options.entity = argv[++index] ?? null
        break
      case "--flow-template":
        options.flowTemplateId = (argv[++index] as EntityRegistrySyncFlowTemplateId | undefined) ?? null
        break
      case "--service-profile":
        options.serviceProfileRef = argv[++index] ?? null
        break
      case "--environment-policy":
        options.environmentPolicyRef = argv[++index] ?? null
        break
      case "--write":
        options.write = true
        break
      case "--force":
        options.force = true
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