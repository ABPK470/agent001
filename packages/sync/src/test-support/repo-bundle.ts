/**
 * Paths to the checked-in published bundle (read-only in tests).
 */

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

import { createPublishedSyncDefinitionRegistry } from "../runtime/published-definition-registry.js"
import { withPermissionDefaults } from "../domain/environments.js"
import type { SyncRuntimeHost } from "../ports/host.js"

/** Monorepo root (`agent001/`). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..")

export const PUBLISHED_BUNDLE_REL = "sync-definitions/published/definitions.bundle.json"

export const PUBLISHED_BUNDLE_PATH = join(REPO_ROOT, PUBLISHED_BUNDLE_REL)

export function requirePublishedBundle(): void {
  if (!existsSync(PUBLISHED_BUNDLE_PATH)) {
    throw new Error(
      `Expected published bundle at ${PUBLISHED_BUNDLE_PATH}. ` +
        `Tests are read-only — they do not create or modify this file.`
    )
  }
}

/** Host pointing at the real repo tree (bundle read-only). */
export function createRepoBundleHost(): SyncRuntimeHost {
  requirePublishedBundle()
  const dev = withPermissionDefaults({
    name: "DEV",
    displayName: "Development",
    color: "emerald",
    role: "both",
    ringOrder: 0,
    allowedSyncEnvironments: ["UAT", "PROD"]
  })
  const uat = withPermissionDefaults({
    name: "UAT",
    displayName: "UAT",
    color: "amber",
    role: "both",
    ringOrder: 1,
    allowedSyncEnvironments: null
  })
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: "DEV" }
    },
    sync: {
      events: { sink: () => {} },
      runs: {
        sink: { start: () => {}, finish: () => {}, savePlan: () => {}, loadPlan: () => null },
        actorUpn: null
      },
      governance: { freezeWindowsReader: () => [] },
      environments: {
        items: new Map([
          ["DEV", dev],
          ["UAT", uat]
        ])
      },
      plans: { diskRoot: null, memCache: new Map() },
      project: {
        dbProjectRoot: REPO_ROOT,
        publishedDefinitions: createPublishedSyncDefinitionRegistry()
      }
    }
  } as unknown as SyncRuntimeHost
}
