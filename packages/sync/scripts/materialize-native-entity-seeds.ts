/**
 * Convert AuthoredSyncDefinition → EntityDefinition seeds with flowId.
 *
 * Usage:
 *   npx tsx packages/sync/scripts/materialize-native-entity-seeds.ts [projectRoot]
 *   npx tsx …/materialize-native-entity-seeds.ts [projectRoot] --authored-dir=<dir>
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
  seedRunConfigFromEntityDocument,
} from "../src/test-support/legacy-refresh-golden.js"
import { defaultSyncDefinitionFlowTemplateId } from "../src/domain/sync-definition-flow-templates.js"
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

  let converted = 0
  let migratedNative = 0
  let alreadyNative = 0

  for (const file of readdirSync(sourceDir).filter((name) => name.endsWith(".json")).sort()) {
    const sourcePath = join(sourceDir, file)
    const raw = JSON.parse(readFileSync(sourcePath, "utf-8")) as unknown

    if (authoredDir == null && isEntityDefinitionSeed(raw)) {
      const doc = raw as { id: string; flowId?: string; run?: { template?: string } }
      if (typeof doc.flowId === "string" && doc.flowId.trim() !== "") {
        alreadyNative++
        continue
      }
      const fromRun = seedRunConfigFromEntityDocument(raw)
      const flowId =
        fromRun?.flowPreset ??
        (typeof doc.run?.template === "string" ? doc.run.template : null) ??
        defaultSyncDefinitionFlowTemplateId(doc.id, flowTemplateCatalog)
      const { run: _run, ...rest } = raw as Record<string, unknown>
      writeFileSync(
        join(outEntitiesDir, file),
        `${JSON.stringify({ ...rest, flowId }, null, 2)}\n`,
        "utf-8",
      )
      migratedNative++
      continue
    }

    if (!isAuthoredSyncDefinitionSeed(raw)) {
      throw new Error(`Unrecognized entity seed shape: ${file}`)
    }

    const authored = raw as AuthoredSyncDefinition
    const flowId = seedRunConfigFromAuthored(authored, flowTemplateCatalog).flowPreset
    const entity = entityDefinitionFromAuthoredSync(authored, "_default", {
      createdAt: LEGACY_REFRESH_SEED_CREATED_AT,
      flowId,
    })
    writeFileSync(join(outEntitiesDir, file), `${JSON.stringify(entity, null, 2)}\n`, "utf-8")
    converted++
  }

  if (authoredDir != null && converted === 0) {
    throw new Error(`No Authored entity JSON found in ${authoredDir}`)
  }

  console.log(
    JSON.stringify({
      ok: true,
      projectRoot,
      authoredDir,
      converted,
      migratedNative,
      alreadyNative,
    }),
  )
}

main()
