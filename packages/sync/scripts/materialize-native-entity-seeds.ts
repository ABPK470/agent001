/**
 * Convert AuthoredSyncDefinition → EntityDefinition seeds + sync-definition-configs.json.
 *
 * Usage:
 *   npx tsx packages/sync/scripts/materialize-native-entity-seeds.ts [projectRoot]
 *   npx tsx …/materialize-native-entity-seeds.ts [projectRoot] --authored-dir=<dir>
 *
 * Without --authored-dir: convert in-place under deploy/sync/artifacts/entities (repair path).
 * With --authored-dir: read Authored JSON from that directory; write native seeds to artifacts
 * (refresh path — Authored never lands in the git seed tree).
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "../src/domain/entity-registry/from-authored-sync.js"
import {
  isAuthoredSyncDefinitionSeed,
  isEntityDefinitionSeed,
  LEGACY_REFRESH_SEED_CREATED_AT,
  seedRunConfigFromAuthored,
  type SeedRunConfig,
} from "../src/test-support/legacy-refresh-golden.js"
import { loadSyncDefinitionFlowTemplateCatalog } from "../src/runtime/load-flow-templates.js"

function parseArgs(argv: string[]): { projectRoot: string; authoredDir: string | null } {
  let projectRoot: string | null = null
  let authoredDir: string | null = null
  for (const arg of argv) {
    if (arg.startsWith("--authored-dir=")) {
      authoredDir = resolve(arg.slice("--authored-dir=".length))
      continue
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown flag: ${arg}`)
    }
    if (projectRoot) throw new Error(`Unexpected argument: ${arg}`)
    projectRoot = resolve(arg)
  }
  return {
    projectRoot: projectRoot ?? resolve(import.meta.dirname, "../../.."),
    authoredDir,
  }
}

function main(): void {
  const { projectRoot, authoredDir } = parseArgs(process.argv.slice(2))
  const outEntitiesDir = resolve(projectRoot, "deploy/sync/artifacts/entities")
  const sourceDir = authoredDir ?? outEntitiesDir
  const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)

  mkdirSync(outEntitiesDir, { recursive: true })

  const configs: SeedRunConfig[] = []
  let converted = 0
  let alreadyNative = 0

  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith(".json")).sort()) {
    const sourcePath = join(sourceDir, file)
    const raw = JSON.parse(readFileSync(sourcePath, "utf-8")) as unknown

    if (authoredDir == null && isEntityDefinitionSeed(raw)) {
      alreadyNative++
      continue
    }

    if (!isAuthoredSyncDefinitionSeed(raw)) {
      throw new Error(`Unrecognized entity seed shape: ${file}`)
    }

    const authored = raw as AuthoredSyncDefinition
    const entity = entityDefinitionFromAuthoredSync(authored, "_default", {
      createdAt: LEGACY_REFRESH_SEED_CREATED_AT,
    })
    writeFileSync(join(outEntitiesDir, file), `${JSON.stringify(entity, null, 2)}\n`, "utf-8")
    configs.push(seedRunConfigFromAuthored(authored, flowTemplateCatalog))
    converted++
  }

  if (converted > 0) {
    writeConfigs(projectRoot, configs)
  } else if (alreadyNative > 0 && authoredDir == null) {
    const configsPath = resolve(projectRoot, "deploy/sync/artifacts/sync-definition-configs.json")
    try {
      readFileSync(configsPath, "utf-8")
    } catch {
      throw new Error(
        "Entity seeds are native but sync-definition-configs.json is missing. Re-run refresh-from-legacy.",
      )
    }
  } else if (authoredDir != null && converted === 0) {
    throw new Error(`No Authored entity JSON found in ${authoredDir}`)
  }

  console.log(
    JSON.stringify({
      ok: true,
      projectRoot,
      authoredDir,
      converted,
      alreadyNative,
      configsWritten: converted > 0,
    }),
  )
}

function writeConfigs(projectRoot: string, configs: SeedRunConfig[]): void {
  const configsPath = resolve(projectRoot, "deploy/sync/artifacts/sync-definition-configs.json")
  mkdirSync(resolve(projectRoot, "deploy/sync/artifacts"), { recursive: true })
  const doc = {
    version: 1 as const,
    _comment:
      "Per-entity run bindings (flow/service/env/ownership). Seeds sync_definition_configs on boot. Pair with artifacts/entities/*.json EntityDefinition seeds.",
    configs: configs.sort((a, b) => a.entityId.localeCompare(b.entityId)),
  }
  writeFileSync(configsPath, `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
}

main()
