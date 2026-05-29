import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
    compilePublishedSyncDefinitions,
    DEFAULT_PUBLISHED_DEFINITIONS_PATH,
    loadAuthoredSyncDefinitions,
    normalizePublishedBundleForCheck,
    validateAuthoredSyncDefinitions,
    writePublishedSyncDefinitionBundle,
    type RepoPublishedSyncDefinitionBundle,
} from "../domain/sync-definition-compiler.js"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../../../")

main()

function main(): void {
  const args = new Set(process.argv.slice(2))
  const shouldWrite = args.has("--write")
  const shouldCheck = args.has("--check")

  const definitions = loadAuthoredSyncDefinitions(ROOT)
  const result = validateAuthoredSyncDefinitions(definitions)
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`ERROR ${error}`)
    process.exitCode = 1
    return
  }
  for (const warning of result.warnings) console.warn(`WARN ${warning}`)

  const published = compilePublishedSyncDefinitions(definitions)
  const publishedSerialized = `${JSON.stringify(published, null, 2)}\n`

  if (shouldWrite) {
    const outputPath = writePublishedSyncDefinitionBundle(ROOT, published)
    console.log(`Wrote published definition bundle to ${outputPath}`)
    return
  }

  if (shouldCheck) {
    const currentPublished = JSON.parse(readFileSync(resolve(ROOT, DEFAULT_PUBLISHED_DEFINITIONS_PATH), "utf-8")) as RepoPublishedSyncDefinitionBundle
    if (JSON.stringify(normalizePublishedBundleForCheck(currentPublished)) !== JSON.stringify(normalizePublishedBundleForCheck(published))) {
      console.error(`ERROR published definition bundle is stale: ${resolve(ROOT, DEFAULT_PUBLISHED_DEFINITIONS_PATH)}`)
      process.exitCode = 1
      return
    }
    console.log(`Published definition bundle is up to date: ${resolve(ROOT, DEFAULT_PUBLISHED_DEFINITIONS_PATH)}`)
    return
  }

  process.stdout.write(publishedSerialized)
}