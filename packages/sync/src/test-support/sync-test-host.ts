/**
 * Test host factory — environments, plan store, published-definition registry.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ALWAYS_PUBLISH_READY } from "../domain/publish-readiness.js"
import { createPublishedSyncDefinitionRegistry } from "../runtime/published-definition-registry.js"
import { withPermissionDefaults } from "../domain/environments.js"
import type { MssqlPoolProvider } from "../ports/host.js"
import type { SyncRuntimeHost } from "../ports/host.js"
import { configureSyncOrchestrator } from "../runtime/orchestrator/db-helpers.js"
import { configurePlanStore } from "../runtime/plan-store.js"
import { writeEntityBundle, type ENTITY_SPECS } from "./entity-fixtures.js"

const tempRoots: string[] = []

/**
 * Throwing pool provider for tests — pool get fails loudly, but `list()`
 * reports the fixture connector ids so Sync eligibility (enabled mssql) passes.
 */
const THROWING_POOLS: MssqlPoolProvider = {
  async get(id) {
    throw new Error(`MSSQL connector "${id}" not configured.`)
  },
  async getByName(name) {
    throw new Error(`MSSQL connection "${name}" not configured.`)
  },
  configOf() {
    return undefined
  },
  list() {
    return [
      { id: "DEV", name: "DEV" },
      { id: "UAT", name: "UAT" },
      { id: "PROD", name: "PROD" },
    ]
  },
  invalidate() {},
}

export function createSyncTestHost(projectRoot: string): SyncRuntimeHost {
  const dev = withPermissionDefaults({
    name: "DEV",
    connectorId: "DEV",
    displayName: "Development",
    color: "emerald",
    role: "both",
    ringOrder: 0,
    allowedSyncEnvironments: ["UAT", "PROD"]
  })
  const uat = withPermissionDefaults({
    name: "UAT",
    connectorId: "UAT",
    displayName: "UAT",
    color: "amber",
    role: "both",
    ringOrder: 1,
    allowedSyncEnvironments: null
  })
  const prod = withPermissionDefaults({
    name: "PROD",
    connectorId: "PROD",
    displayName: "Production",
    color: "rose",
    role: "both",
    ringOrder: 2,
    allowedSyncEnvironments: null
  })

  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: "DEV" },
      pools: THROWING_POOLS
    },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: {
          start: () => {},
          finish: () => {},
          savePlan: () => {},
          loadPlan: () => null
        },
        actorUpn: null
      },
      governance: { freezeWindowsReader: () => [] },
      environments: {
        items: new Map([
          ["DEV", dev],
          ["UAT", uat],
          ["PROD", prod]
        ])
      },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: projectRoot,
        publishedDefinitions: createPublishedSyncDefinitionRegistry(),
        publishReadiness: ALWAYS_PUBLISH_READY,
      }
    }
  } as unknown as SyncRuntimeHost
}

export interface SyncTestProject {
  root: string
  host: SyncRuntimeHost
  cleanup: () => void
}

export function createSyncTestProject(
  entityIds: Array<keyof typeof ENTITY_SPECS | string> = ["contract", "dataset", "rule", "pipelineActivity"]
): SyncTestProject {
  const root = mkdtempSync(join(tmpdir(), "mia-sync-test-"))
  tempRoots.push(root)
  mkdirSync(join(root, "deploy", "sync", "artifacts"), { recursive: true })
  writeEntityBundle(root, entityIds)
  const host = createSyncTestHost(root)
  configureSyncOrchestrator(host, root)
  const plansDir = mkdtempSync(join(tmpdir(), "mia-sync-plans-"))
  tempRoots.push(plansDir)
  configurePlanStore(host, plansDir)
  return {
    root,
    host,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true })
      rmSync(plansDir, { recursive: true, force: true })
    }
  }
}

export function drainTempSyncProjects(): void {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (err: unknown) { console.error("[mia]", err) }
  }
}
