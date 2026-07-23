#!/usr/bin/env node
/**
 * Rebuild deploy/sync artifacts from legacy MyMI pipelines.
 *
 * Live MSSQL (repo dev or deployed host with .env MSSQL_*):
 *   node deploy/sync/generators/refresh-from-legacy.mjs --connection uat --force
 *
 * Offline (no MSSQL — metadata + fixtures only; skips entity JSON):
 *   node deploy/sync/generators/refresh-from-legacy.mjs \
 *     --evidence-file deploy/sync/fixtures/legacy-pipeline-evidence.fixture.json \
 *     --metadata-only --force
 *
 * After refresh: restart server → review Entity Registry → Publish.
 */

import "dotenv/config"

import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { refreshDeployArtifactsFromLegacy } from "../helpers/refresh-from-legacy.mjs"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "../../..")

main().catch((error) => {
  console.error(`ERROR ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})

async function main() {
  const options = parseArgs(process.argv.slice(2))

  if (!options.connection && !options.evidenceFile) {
    fail("Provide --connection <name> (live MSSQL) or --evidence-file <path> (offline fixture).")
  }
  if (options.metadataOnly && !options.evidenceFile) {
    fail("--metadata-only requires --evidence-file (offline mode).")
  }

  const result = await refreshDeployArtifactsFromLegacy(ROOT, options)

  if (result.entities.length > 0) {
    console.log(`Wrote ${result.entities.length} entity definition(s): ${result.entities.join(", ")}`)
  } else if (!options.metadataOnly) {
    console.log("No entity definitions written.")
  } else {
    console.log("Skipped entity definitions (--metadata-only).")
  }
  console.log(
    `Wrote sync metadata (${result.actions ?? result.stepTypes} actions, ${result.flows} flows), legacy-activity-sync-specs.json (${result.activitySpecs} specs)`
  )
  for (const [key, relPath] of Object.entries(result.paths)) {
    if (key === "entitiesDir" && result.entities.length === 0) continue
    console.log(`  ${key}: ${relative(ROOT, resolve(ROOT, relPath))}`)
  }
}

function parseArgs(argv) {
  const options = {
    connection: null,
    evidenceFile: null,
    catalogFile: null,
    pipelineIds: null,
    specsFile: null,
    force: false,
    metadataOnly: false
  }

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    switch (arg) {
      case "--connection":
        options.connection = argv[++index] ?? null
        break
      case "--evidence-file":
        options.evidenceFile = argv[++index] ?? null
        break
      case "--catalog-file":
        options.catalogFile = argv[++index] ?? null
        break
      case "--pipeline-ids":
        options.pipelineIds = argv[++index] ?? null
        break
      case "--specs-file":
        options.specsFile = argv[++index] ?? null
        break
      case "--metadata-only":
        options.metadataOnly = true
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

function fail(message) {
  console.error(`ERROR ${message}`)
  process.exit(1)
}
