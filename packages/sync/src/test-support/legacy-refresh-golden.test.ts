/**
 * Phase 0 — freeze legacy refresh ground truth (G1/G2/G3).
 *
 * UPDATE_GOLDENS=1 regenerates committed JSON under __goldens__/legacy-refresh/.
 * After native EntityDefinition seeds land, G1 is retired; G2/G3 remain the contract.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  buildG1WireGolden,
  buildG2LogicalFromAuthored,
  buildG2LogicalFromNativeSeeds,
  buildG3PublishedFromLogical,
  ENTITY_IDS,
  goldenDir,
  isAuthoredSyncDefinitionSeed,
  isEntityDefinitionSeed,
  loadShippedAuthoredEntities,
  type LogicalCatalogGolden,
} from "./legacy-refresh-golden.js"

// Goldens live beside this module under __goldens__/legacy-refresh/

const repoRoot = resolve(import.meta.dirname, "../../../..")
const goldensRoot = goldenDir(repoRoot)
const updateGoldens = process.env["UPDATE_GOLDENS"] === "1"

function writeGolden(name: string, value: unknown): void {
  mkdirSync(goldensRoot, { recursive: true })
  writeFileSync(join(goldensRoot, name), `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function readGolden(name: string): unknown {
  const path = join(goldensRoot, name)
  if (!existsSync(path)) {
    throw new Error(`Missing golden ${path}. Run with UPDATE_GOLDENS=1 once on current generators.`)
  }
  return JSON.parse(readFileSync(path, "utf-8")) as unknown
}

function entitiesAreNative(): boolean {
  const sample = resolve(repoRoot, "deploy/sync/artifacts/entities/dataset.json")
  const raw = JSON.parse(readFileSync(sample, "utf-8")) as unknown
  return isEntityDefinitionSeed(raw)
}

describe("legacy refresh goldens (Phase 0)", () => {
  it("freezes G1 wire + G2 logical + G3 published from current seeds", () => {
    let logical: LogicalCatalogGolden

    if (entitiesAreNative()) {
      logical = buildG2LogicalFromNativeSeeds(repoRoot)
      if (updateGoldens) {
        writeGolden("g2-logical.json", logical)
        writeGolden("g3-published.json", buildG3PublishedFromLogical(repoRoot, logical))
      }
    } else {
      const authored = loadShippedAuthoredEntities(repoRoot)
      expect(Object.keys(authored).sort()).toEqual([...ENTITY_IDS].sort())
      for (const id of ENTITY_IDS) {
        expect(isAuthoredSyncDefinitionSeed(authored[id])).toBe(true)
      }

      const g1 = buildG1WireGolden(repoRoot)
      logical = buildG2LogicalFromAuthored(repoRoot, authored)
      const g3 = buildG3PublishedFromLogical(repoRoot, logical)

      if (updateGoldens) {
        writeGolden("g1-wire.json", g1)
        writeGolden("g2-logical.json", logical)
        writeGolden("g3-published.json", g3)
      }

      expect(g1).toEqual(readGolden("g1-wire.json"))
    }

    const g3 = buildG3PublishedFromLogical(repoRoot, logical)

    expect(Object.keys(logical.entities).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(logical.configs).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(g3.definitions).sort()).toEqual([...ENTITY_IDS].sort())

    // Exhaustive field checks via deep equality to frozen goldens
    expect(logical).toEqual(readGolden("g2-logical.json"))
    expect(g3).toEqual(readGolden("g3-published.json"))

    // Explicit coverage of flows / steps / inputs (sync-metadata)
    const meta = logical.syncMetadata as {
      flows: Record<string, { steps: Array<{ id: string; kind: string; inputs?: unknown }> }>
      actions: unknown[]
      valueSources: unknown[]
      phases: unknown[]
    }
    expect(meta.phases.length).toBeGreaterThan(0)
    expect(meta.actions.length).toBeGreaterThan(0)
    expect(meta.valueSources.length).toBeGreaterThan(0)
    for (const id of ENTITY_IDS) {
      const flow = meta.flows[id]
      expect(flow, `missing flow ${id}`).toBeTruthy()
      expect(flow.steps.length).toBeGreaterThan(0)
      expect(flow.steps.some((step) => step.kind === "metadataSync")).toBe(true)

      const entity = logical.entities[id]!
      expect(entity.tables.length).toBeGreaterThan(0)
      for (const table of entity.tables) {
        expect(table.scope.kind === "rootPk" || table.scope.kind === "sql").toBe(true)
        if (table.scope.kind === "sql") {
          expect(table.scope.predicate.length).toBeGreaterThan(0)
        }
      }

      const published = g3.definitions[id]!
      expect(published.metadata.tables.length).toBe(entity.tables.length)
      expect(published.executionFlow.steps.length).toBeGreaterThan(0)
      expect(published.executionFlow.catalog).toBeTruthy()
      expect(Object.keys(published.executionFlow.catalog!.kinds).length).toBeGreaterThan(0)
    }
  })
})
