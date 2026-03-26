import type { FastifyInstance } from "fastify"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createApp } from "../../src/api/app.js"
import { getContainer, resetContainer } from "../../src/api/container.js"
import { FakeAction } from "../helpers.js"

describe("API routes", () => {
  let app: FastifyInstance

  beforeEach(async () => {
    resetContainer()
    app = createApp()
    // Register a fake action so workflows can actually execute
    getContainer().actionRegistry.register(
      new FakeAction("fake", { result: "ok" }),
    )
    await app.ready()
  })

  afterEach(async () => {
    await app.close()
    resetContainer()
  })

  describe("GET /health", () => {
    it("returns ok", async () => {
      const res = await app.inject({ method: "GET", url: "/health" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: "ok" })
    })
  })

  describe("POST /workflows", () => {
    it("creates a workflow", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workflows",
        payload: {
          name: "Test",
          description: "A test workflow",
          steps: [{ id: "s1", name: "S1", action: "fake", input: {} }],
        },
      })
      expect(res.statusCode).toBe(201)
      const body = res.json()
      expect(body.id).toBeDefined()
      expect(body.status).toBe("active")
      expect(body.definition.name).toBe("Test")
    })

    it("rejects invalid workflow (no steps)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workflows",
        payload: { name: "Bad" },
      })
      expect(res.statusCode).toBe(400)
    })
  })

  describe("GET /workflows", () => {
    it("lists workflows", async () => {
      await app.inject({
        method: "POST",
        url: "/workflows",
        payload: {
          name: "W1",
          steps: [{ id: "s1", name: "S1", action: "fake", input: {} }],
        },
      })

      const res = await app.inject({ method: "GET", url: "/workflows" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toHaveLength(1)
    })
  })

  describe("GET /workflows/:workflowId", () => {
    it("returns 404 for unknown workflow", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workflows/nonexistent",
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe("POST /workflows/:workflowId/runs", () => {
    it("starts a run and returns completed", async () => {
      const wfRes = await app.inject({
        method: "POST",
        url: "/workflows",
        payload: {
          name: "W",
          steps: [{ id: "s1", name: "S1", action: "fake", input: {} }],
        },
      })
      const wf = wfRes.json()

      const runRes = await app.inject({
        method: "POST",
        url: `/workflows/${wf.id}/runs`,
        payload: { input: {} },
      })
      expect(runRes.statusCode).toBe(201)
      const run = runRes.json()
      expect(run.status).toBe("completed")
      expect(run.steps).toHaveLength(1)
    })

    it("returns 404 for unknown workflow", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workflows/nonexistent/runs",
        payload: {},
      })
      expect(res.statusCode).toBe(404)
    })
  })

  describe("GET /workflows/:workflowId/runs", () => {
    it("lists runs for a workflow", async () => {
      const wfRes = await app.inject({
        method: "POST",
        url: "/workflows",
        payload: {
          name: "W",
          steps: [{ id: "s1", name: "S1", action: "fake", input: {} }],
        },
      })
      const wf = wfRes.json()

      await app.inject({
        method: "POST",
        url: `/workflows/${wf.id}/runs`,
        payload: {},
      })

      const res = await app.inject({
        method: "GET",
        url: `/workflows/${wf.id}/runs`,
      })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toHaveLength(1)
    })
  })

  describe("GET /actions", () => {
    it("lists registered actions", async () => {
      const res = await app.inject({ method: "GET", url: "/actions" })
      expect(res.statusCode).toBe(200)
      const body = res.json()
      // Built-in actions + our fake
      expect(body.actions).toContain("http.request")
      expect(body.actions).toContain("fake")
    })
  })

  describe("Approvals", () => {
    it("GET /approvals returns empty initially", async () => {
      const res = await app.inject({ method: "GET", url: "/approvals" })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual([])
    })
  })
})
