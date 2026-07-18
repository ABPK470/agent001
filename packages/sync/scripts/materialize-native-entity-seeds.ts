/**
 * Convert AuthoredSyncDefinition → EntityDefinition seeds with embedded `run`.
 *
 * Usage:
 *   npx tsx packages/sync/scripts/materialize-native-entity-seeds.ts [projectRoot]
 *   npx tsx …/materialize-native-entity-seeds.ts [projectRoot] --authored-dir=<dir>
 *
 * Without --authored-dir: convert in-place under deploy/sync/artifacts/entities (repair path),
 * or migrate native seeds that still use a sibling sync-definition-configs.json.
 * With --authored-dir: read Authored JSON from that directory; write native seeds to artifacts
 * (refresh path — Authored never lands in the git seed tree).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { entityDefinitionFromAuthoredSync } from "../src/domain/entity-registry/from-authored-sync.js"
import {
  entityRunBlockFromSeedConfig,
  isAuthoredSyncDefinitionSeed,
  isEntityDefinitionSeed,
  LEGACY_REFRESH_SEED_CREATED_AT,
  seedRunConfigFromAuthored,
  seedRunConfigFromEntityDocument,
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

function configsPath(projectRoot: string): string {
  return resolve(projectRoot, "deploy/sync/artifacts/sync-definition-configs.json")
}

function loadLegacyConfigs(projectRoot: string): Map<string, SeedRunConfig> {
  const path = configsPath(projectRoot)
  const out = new Map<string, SeedRunConfig>()
  if (!existsSync(path)) return out
  const doc = JSON.parse(readFileSync(path, "utf-8")) as { configs?: SeedRunConfig[] }
  for (const row of doc.configs ?? []) {
    out.set(row.entityId, row)
  }
  return out
}

function writeEntityWithRun(
  outPath: string,
  entity: Record<string, unknown>,
  run: SeedRunConfig,
): void {
  const doc = {
    ...entity,
    run: entityRunBlockFromSeedConfig(run),
  }
  writeFileSync(outPath, `${JSON.stringify(doc, null, 2)}\n`, "utf-8")
}

function main(): void {
  const { projectRoot, authoredDir } = parseArgs(process.argv.slice(2))
  const outEntitiesDir = resolve(projectRoot, "deploy/sync/artifacts/entities")
  const sourceDir = authoredDir ?? outEntitiesDir
  const flowTemplateCatalog = loadSyncDefinitionFlowTemplateCatalog(projectRoot)
  const legacyConfigs = loadLegacyConfigs(projectRoot)

  mkdirSync(outEntitiesDir, { recursive: true })

  let converted = 0
  let migratedNative = 0
  let alreadyNative = 0

  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith(".json")).sort()) {
    const sourcePath = join(sourceDir, file)
    const raw = JSON.parse(readFileSync(sourcePath, "utf-8")) as unknown

    if (authoredDir == null && isEntityDefinitionSeed(raw)) {
      const existingRun = seedRunConfigFromEntityDocument(raw)
      if (existingRun) {
        alreadyNative++
        continue
      }
      const doc = raw as { id: string }
      const fromLegacy = legacyConfigs.get(doc.id)
      if (!fromLegacy) {
        throw new Error(
          `Entity seed ${file} has no run block and no sync-definition-configs entry. Re-run refresh-from-legacy.`,
        )
      }
      const { run: _ignored, ...entity } = raw as Record<string, unknown>
      writeEntityWithRun(join(outEntitiesDir, file), entity, fromLegacy)
      migratedNative++
      continue
    }

    if (!isAuthoredSyncDefinitionSeed(raw)) {
      throw new Error(`Unrecognized entity seed shape: ${file}`)
    }

    const authored = raw as AuthoredSyncDefinition
    const entity = entityDefinitionFromAuthoredSync(authored, "_default", {
      createdAt: LEGACY_REFRESH_SEED_CREATED_AT,
    })
    const run = seedRunConfigFromAuthored(authored, flowTemplateCatalog)
    writeEntityWithRun(join(outEntitiesDir, file), entity as unknown as Record<string, unknown>, run)
    converted++
  }

  if (authoredDir != null && converted === 0) {
    throw new Error(`No Authored entity JSON found in ${authoredDir}`)
  }

  const legacyPath = configsPath(projectRoot)
  let removedConfigs = false
  if (existsSync(legacyPath) && (converted > 0 || migratedNative > 0 || alreadyNative > 0)) {
    // After native seeds carry run, the sibling configs file is redundant.
    const allHaveRun = readdirSync(outEntitiesDir)
      .filter((name) => name.endsWith(".json"))
      .every((name) => {
        const raw = JSON.parse(readFileSync(join(outEntitiesDir, name), "utf-8")) as unknown
        return seedRunConfigFromEntityDocument(raw) != null
      })
    if (allHaveRun) {
      unlinkSync(legacyPath)
      removedConfigs = true
    }
  }

  console.log(
    JSON.stringify({
      ok: true,
      projectRoot,
      authoredDir,
      converted,
      migratedNative,
      alreadyNative,
      removedConfigs,
    }),
  )
}

main()
