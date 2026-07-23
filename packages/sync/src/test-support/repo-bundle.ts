/**
 * Fixture host for smoke tests against a checked-in published-bundle snapshot.
 *
 * Production authority is SQLite (`sync_definitions`). The file at
 * `sync-definitions/published/definitions.bundle.json` is a read-only fixture
 * for predicate/shape checks — not the live publish target.
 */

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { createDbPublishedSyncDefinitionRegistry } from "../runtime/db-published-definition-registry.js"
import { ALWAYS_PUBLISH_READY } from "../ports/publish-readiness.js"
import type { PublishedSyncDefinitionBundle } from "../runtime/published-definitions.js"
import { withPermissionDefaults } from "../core/eligibility/environments.js"
import type { SyncRuntimeHost } from "../ports/host.js"

/** Monorepo root (`agent001/`). */
export const REPO_ROOT = resolve(import.meta.dirname, "../../../..")

/** @deprecated Legacy fixture path — not written by Publish. */
export const PUBLISHED_BUNDLE_REL = "sync-definitions/published/definitions.bundle.json"

export const PUBLISHED_BUNDLE_PATH = join(REPO_ROOT, PUBLISHED_BUNDLE_REL)

export function requirePublishedBundle(): void {
  if (!existsSync(PUBLISHED_BUNDLE_PATH)) {
    throw new Error(
      `Expected fixture published bundle at ${PUBLISHED_BUNDLE_PATH}. ` +
        `This is a read-only smoke-test fixture, not production storage.`
    )
  }
}

function loadFixturePublishedBundle(): PublishedSyncDefinitionBundle | null {
  if (!existsSync(PUBLISHED_BUNDLE_PATH)) return null
  const parsed = JSON.parse(readFileSync(PUBLISHED_BUNDLE_PATH, "utf-8")) as PublishedSyncDefinitionBundle
  if (parsed.version !== 1 || !parsed.definitions) return null
  return parsed
}

/** Host pointing at the real repo tree with the fixture bundle injected. */
export function createRepoBundleHost(): SyncRuntimeHost {
  requirePublishedBundle()
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
  return {
    mssql: {
      databases: new Map(),
      defaultConnection: { value: "DEV" },
      pools: {
        async get(id: string) {
          throw new Error(`MSSQL connector "${id}" not configured.`)
        },
        async getByName(name: string) {
          throw new Error(`MSSQL connection "${name}" not configured.`)
        },
        configOf() {
          return undefined
        },
        list() {
          return [
            { id: "DEV", name: "DEV" },
            { id: "UAT", name: "UAT" },
          ]
        },
        invalidate() {},
      },
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
        publishedDefinitions: createDbPublishedSyncDefinitionRegistry(loadFixturePublishedBundle),
        publishReadiness: ALWAYS_PUBLISH_READY,
      }
    }
  } as unknown as SyncRuntimeHost
}
