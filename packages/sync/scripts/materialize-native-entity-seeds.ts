/**
 * Convert deploy/sync/artifacts/entities/*.json from AuthoredSyncDefinition → EntityDefinition
 * and write sync-definition-configs.json. Idempotent when seeds are already native.
 *
 * Usage:
 *   npx tsx packages/sync/scripts/materialize-native-entity-seeds.ts [projectRoot]
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

function main(): void {
  const projectRoot = resolve(process.argv[2] ?? resolve(import.meta.dirname, "../../.."))
  const entitiesDir = resolve(projectRoot, "deploy/sync/artifacts/entities")
  const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)

  const configs: SeedRunConfig[] = []
  let converted = 0
  let alreadyNative = 0

  for (const file of readdirSync(entitiesDir).filter((name) => name.endsWith(".json")).sort()) {
    const path = join(entitiesDir, file)
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown

    if (isEntityDefinitionSeed(raw)) {
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
    writeFileSync(path, `${JSON.stringify(entity, null, 2)}\n`, "utf-8")
    configs.push(seedRunConfigFromAuthored(authored, flowTemplateCatalog))
    converted++
  }

  if (converted > 0) {
    writeConfigs(projectRoot, configs)
  } else if (alreadyNative > 0) {
    // Ensure configs file exists when seeds were converted earlier
    const configsPath = resolve(projectRoot, "deploy/sync/artifacts/sync-definition-configs.json")
    try {
      readFileSync(configsPath, "utf-8")
    } catch {
      throw new Error(
        "Entity seeds are native but sync-definition-configs.json is missing. Re-run from Authored seeds.",
      )
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      projectRoot,
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
