/**
 * Phase 0 — freeze legacy refresh ground truth (G1/G2/G3).
 *
 * UPDATE_GOLDENS=1 regenerates committed JSON under __goldens__/legacy-refresh/.
 * G1 = native EntityDefinition seed wire; G2/G3 remain the semantic + publish contracts.
 * g1-authored-historical.json is frozen separately for A→B conversion tests (not regenerated here).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  buildG1WireGolden,
  buildG2LogicalFromNativeSeeds,
  buildG3PublishedFromLogical,
  ENTITY_IDS,
  goldenDir,
  isEntityDefinitionSeed,
  type LogicalCatalogGolden,
} from "./legacy-refresh-golden.js"

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

describe("legacy refresh goldens (Phase 0)", () => {
  it("freezes G1 native wire + G2 logical + G3 published from current seeds", () => {
    const sample = resolve(repoRoot, "deploy/sync/artifacts/entities/dataset.json")
    const raw = JSON.parse(readFileSync(sample, "utf-8")) as unknown
    expect(isEntityDefinitionSeed(raw)).toBe(true)

    const g1 = buildG1WireGolden(repoRoot)
    const logical: LogicalCatalogGolden = buildG2LogicalFromNativeSeeds(repoRoot)
    const g3 = buildG3PublishedFromLogical(repoRoot, logical)

    if (updateGoldens) {
      writeGolden("g1-wire.json", g1)
      writeGolden("g2-logical.json", logical)
      writeGolden("g3-published.json", g3)
    }

    expect(Object.keys(g1.entities).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(g1.configs).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(logical.entities).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(logical.configs).sort()).toEqual([...ENTITY_IDS].sort())
    expect(Object.keys(g3.definitions).sort()).toEqual([...ENTITY_IDS].sort())

    expect(g1).toEqual(readGolden("g1-wire.json"))
    expect(logical).toEqual(readGolden("g2-logical.json"))
    expect(g3).toEqual(readGolden("g3-published.json"))

    // G1 native wire matches G2 logical (same stamp normalize)
    expect(g1.entities).toEqual(logical.entities)
    expect(g1.configs).toEqual(logical.configs)

    const meta = logical.syncMetadata as {
      flows: Record<string, { steps: Array<{ id: string; kind: string; inputs?: unknown }> }>
      actions: unknown[]
      valueSources: unknown[]
      phases: unknown[]
    }
    expect(meta.phases.length).toBeGreaterThan(0)
    expect(meta.actions.length).toBeGreaterThan(0)
    expect(meta.valueSources.length).toBeGreaterThan(0)
    expect(Object.keys(meta.flows).length).toBeGreaterThan(0)

    for (const id of ENTITY_IDS) {
      const published = g3.definitions[id]!
      expect(published.executionFlow.steps.length).toBeGreaterThan(0)
      expect(published.metadata.tables.length).toBeGreaterThan(0)
    }
  })

  it("keeps frozen Authored historical wire for conversion tests", () => {
    const path = join(goldensRoot, "g1-authored-historical.json")
    expect(existsSync(path)).toBe(true)
    const historical = JSON.parse(readFileSync(path, "utf-8")) as {
      entities: Record<string, { schemaVersion: number; metadata: { tables: unknown[] } }>
    }
    expect(Object.keys(historical.entities).sort()).toEqual([...ENTITY_IDS].sort())
    for (const id of ENTITY_IDS) {
      const authored = historical.entities[id]!
      expect(authored.schemaVersion).toBe(1)
      expect(authored.metadata.tables.length).toBeGreaterThan(0)
    }
  })
})
