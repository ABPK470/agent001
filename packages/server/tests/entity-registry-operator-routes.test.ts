/**
 * Entity Registry operator routes — HTTP coverage for Catalog widget actions.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import * as db from "../src/infra/persistence/db/index.js"
import {
  buildEntityRegistryApp,
  setupCatalogOperatorFixture,
  teardownCatalogOperatorFixture,
  TENANT,
  type CatalogOperatorFixture,
} from "./helpers/catalog-operator-fixture.js"

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

  it("dry-run preview for registry JSON import validates before save", async () => {
    const entity = db.getEntityDefinition(TENANT, "dataset")
    expect(entity).toBeTruthy()
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
      "../src/api/sync/handlers/definitions-routes.js"
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
      url: "/api/entity-registry/entities/import-registry-json",
      payload: { json: "{}", reason: "guest" },
    })
    expect(response.statusCode).toBe(403)
    await guestApp.close()
  })
})
