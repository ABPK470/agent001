/**
 * Entity Registry operator routes — HTTP coverage for widget actions.
 */

import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { AuthoredSyncDefinition } from "@mia/shared-types"

import { formatAuthoredSyncJson } from "../src/api/sync/domain/authored-sync-document.js"
import * as db from "../src/infra/persistence/db/index.js"
import {
  buildEntityRegistryApp,
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

const REPO_ARTIFACTS = resolve(
  fileURLToPath(new URL("../../../deploy/sync/artifacts/entities", import.meta.url)),
)

let fixture: CatalogOperatorFixture

beforeEach(async () => {
  fixture = await setupCatalogOperatorFixture()
})

afterEach(async () => {
  teardownCatalogOperatorFixture(fixture)
})

describe("entity registry operator routes", () => {
  it("lists seeded entities for admin", async () => {
    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({ method: "GET", url: "/api/entity-registry/entities" })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { tenantId: string; items: Array<{ id: string }> }
    expect(body.tenantId).toBe(TENANT)
    expect(body.items.map((item) => item.id)).toContain("content")
    await app.close()
  })

  it("exports authored artifact JSON for a single entity", async () => {
    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/entities/content/artifact.json",
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as AuthoredSyncDefinition
    expect(body.id).toBe("content")
    expect(body.metadata.tables.some((table) => table.name === "gate.ContentType")).toBe(true)
    await app.close()
  })

  it("exports registry JSON snapshot for a single entity", async () => {
    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "GET",
      url: "/api/entity-registry/entities/content/registry.json",
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('"id": "content"')
    expect(response.body).toContain("gate.ContentType")
    await app.close()
  })

  it("imports ground-truth authored artifact via HTTP without predicate drift", async () => {
    const seed = JSON.parse(
      readFileSync(join(REPO_ARTIFACTS, "gateMetadata.json"), "utf-8"),
    ) as AuthoredSyncDefinition
    const app = await buildEntityRegistryApp(fixture)

    const response = await app.inject({
      method: "POST",
      url: "/api/entity-registry/entities/import-artifact",
      payload: {
        json: formatAuthoredSyncJson(seed),
        reason: "http-import-gateMetadata",
        dryRun: false,
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ok: boolean; saved: Array<{ id: string }> }
    expect(body.ok).toBe(true)
    expect(body.saved.some((row) => row.id === "gateMetadata")).toBe(true)
    expect(db.getSyncDefinitionConfig(TENANT, "gateMetadata")?.flow_preset).toBeTruthy()
    await app.close()
  })

  it("rejects authored artifact import with review placeholders via HTTP", async () => {
    const seed = JSON.parse(
      readFileSync(join(REPO_ARTIFACTS, "content.json"), "utf-8"),
    ) as AuthoredSyncDefinition
    const poisoned: AuthoredSyncDefinition = {
      ...seed,
      metadata: {
        ...seed.metadata,
        tables: seed.metadata.tables.map((table) =>
          table.name === "gate.ContentType"
            ? {
                ...table,
                predicate: "[contentTypeId] IN (/* review: correlate via contentTypeId */)",
              }
            : table,
        ),
      },
    }

    const before = db
      .getEntityDefinition(TENANT, "content")
      ?.tables.find((table) => table.name === "gate.ContentType")
    const beforePredicate =
      before?.scope.kind === "sql" ? before.scope.predicate : null

    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "POST",
      url: "/api/entity-registry/entities/import-artifact",
      payload: {
        json: formatAuthoredSyncJson(poisoned),
        reason: "http-import-placeholder",
        dryRun: false,
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ok: boolean; errors: Array<{ id: string | null }> }
    expect(body.ok).toBe(false)
    expect(body.errors.length).toBeGreaterThan(0)

    const after = db
      .getEntityDefinition(TENANT, "content")
      ?.tables.find((table) => table.name === "gate.ContentType")
    const afterPredicate = after?.scope.kind === "sql" ? after.scope.predicate : null
    expect(afterPredicate).toBe(beforePredicate)
    await app.close()
  })

  it("dry-run preview for registry JSON import validates before save", async () => {
    const entity = db.getEntityDefinition(TENANT, "dataset")
    expect(entity).toBeTruthy()
    const config = db.getSyncDefinitionConfig(TENANT, "dataset")!
    const exportResponse = await (await buildEntityRegistryApp(fixture)).inject({
      method: "GET",
      url: "/api/entity-registry/entities/dataset/registry.json",
    })
    expect(exportResponse.statusCode).toBe(200)

    const app = await buildEntityRegistryApp(fixture)
    const response = await app.inject({
      method: "POST",
      url: "/api/entity-registry/entities/import-registry-json",
      payload: {
        json: exportResponse.body,
        reason: "registry-json-dry-run",
        dryRun: true,
      },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ok: boolean; dryRun: boolean; saved: Array<{ id: string }> }
    expect(body.ok).toBe(true)
    expect(body.dryRun).toBe(true)
    expect(body.saved.some((row) => row.id === "dataset")).toBe(true)
    await app.close()
  })

  it("rejects non-admin import attempts", async () => {
    const Fastify = (await import("fastify")).default
    const { registerEntityRegistryRoutes } = await import(
      "../src/api/sync/transport/definitions-routes.js"
    )
    const guestApp = Fastify({ logger: false })
    guestApp.addHook("onRequest", async (req) => {
      ;(req as unknown as { session: typeof fixture.adminSession }).session = {
        ...fixture.adminSession,
        isAdmin: false,
      }
    })
    registerEntityRegistryRoutes(guestApp, fixture.projectRoot)
    await guestApp.ready()

    const response = await guestApp.inject({
      method: "POST",
      url: "/api/entity-registry/entities/import-artifact",
      payload: { json: "{}", reason: "guest" },
    })
    expect(response.statusCode).toBe(403)
    await guestApp.close()
  })
})
