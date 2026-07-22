/**
 * Policy seeder — insert-if-missing on boot; explicit factory reset from JSON.
 */

import Database from "better-sqlite3"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { beforeEach, describe, expect, it } from "vitest"

import { _migrate } from "../src/infra/persistence/connection.js"
import * as db from "../src/infra/persistence/sqlite.js"
import {
  resetFactoryPolicyDefaults,
  seedDefaultPoliciesIfMissing,
} from "../src/api/policies/service/policy-seeder.js"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

beforeEach(() => {
  _migrate(new Database(":memory:"))
})

describe("seedDefaultPoliciesIfMissing", () => {
  it("inserts factory rules once and leaves operator edits alone on re-run", () => {
    const before = db.listPolicyRules().length
    const first = seedDefaultPoliciesIfMissing(REPO_ROOT)
    expect(first.inserted).toBeGreaterThan(10)
    expect(db.listPolicyRules().length).toBe(before + first.inserted)

    db.savePolicyRule({
      name: "hosted_allow_sync_preview",
      effect: "deny",
      condition: "selectors",
      parameters: JSON.stringify({ reason: "operator override", selectors: { tool: "sync_preview" } }),
      created_at: new Date().toISOString(),
      source: db.PolicySource.Db,
      updated_at: new Date().toISOString(),
      updated_by: "admin@example.com",
    })

    const second = seedDefaultPoliciesIfMissing(REPO_ROOT)
    expect(second.inserted).toBe(0)
    const preview = db.listPolicyRules().find((r) => r.name === "hosted_allow_sync_preview")
    expect(preview?.effect).toBe("deny")
    expect(preview?.source).toBe(db.PolicySource.Db)
  })
})

describe("resetFactoryPolicyDefaults", () => {
  it("re-reads deploy JSON and restores factory-named rows without wiping other operator rules", () => {
    seedDefaultPoliciesIfMissing(REPO_ROOT)

    db.savePolicyRule({
      name: "hosted_allow_sync_preview",
      effect: "deny",
      condition: "selectors",
      parameters: JSON.stringify({ reason: "operator override", selectors: { tool: "sync_preview" } }),
      created_at: new Date().toISOString(),
      source: db.PolicySource.Db,
    })
    db.savePolicyRule({
      name: "operator_custom_deny_prod",
      effect: "deny",
      condition: "selectors",
      parameters: JSON.stringify({
        priority: 100,
        selectors: { tool: "sync_execute", dbEnvironment: "prod" },
      }),
      created_at: new Date().toISOString(),
      source: db.PolicySource.Db,
    })

    const result = resetFactoryPolicyDefaults(REPO_ROOT)
    expect(result.inserted).toBeGreaterThan(10)
    expect(result.seedPath).toBe("deploy/policies/defaults.json")

    const preview = db.listPolicyRules().find((r) => r.name === "hosted_allow_sync_preview")
    expect(preview?.effect).toBe("allow")
    expect(preview?.source).toBe(db.PolicySource.HostedDefault)

    const custom = db.listPolicyRules().find((r) => r.name === "operator_custom_deny_prod")
    expect(custom?.effect).toBe("deny")
    expect(custom?.source).toBe(db.PolicySource.Db)
  })
})
