/**
 * Data-movement transport routes — admin-only preview + run over the
 * connector-adapter engine. Reads the opaque port off the boot host
 * (`host.connectors.port.value`), built by `buildMovementPort` at boot.
 */

import { type AgentHost } from "@mia/agent"
import type { ReadSpec, Transform, WriteSpec } from "@mia/shared-types"
import type { FastifyInstance } from "fastify"

interface PreviewBody {
  source: { connectorId: string; spec: ReadSpec }
  transform?: Transform
  limit?: number
}

interface RunBody {
  source: { connectorId: string; spec: ReadSpec }
  target: { connectorId: string; spec: WriteSpec; stopOnError?: boolean }
  transform?: Transform
}

export function registerDataMovementRoutes(app: FastifyInstance, host: AgentHost): void {
  app.get("/api/data-movement/connectors", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) return { connectors: [] }
    return { connectors: port.listAdapters() }
  })

  app.post<{ Body: PreviewBody }>("/api/data-movement/preview", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) {
      reply.code(503)
      return { error: "connector data-movement is not configured on this server" }
    }
    const body = req.body ?? ({} as PreviewBody)
    if (!body.source?.connectorId || !body.source?.spec) {
      reply.code(400)
      return { error: "source.connectorId and source.spec are required" }
    }
    try {
      const result = await port.previewMove(
        { connectorId: body.source.connectorId, spec: body.source.spec },
        { transform: body.transform, limit: body.limit },
      )
      return { rows: result.rows, truncated: result.truncated }
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })

  app.post<{ Body: RunBody }>("/api/data-movement/run", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) {
      reply.code(503)
      return { error: "connector data-movement is not configured on this server" }
    }
    const body = req.body ?? ({} as RunBody)
    if (!body.source?.connectorId || !body.source?.spec) {
      reply.code(400)
      return { error: "source.connectorId and source.spec are required" }
    }
    if (!body.target?.connectorId || !body.target?.spec) {
      reply.code(400)
      return { error: "target.connectorId and target.spec are required" }
    }
    try {
      const summary = await port.moveData(
        { connectorId: body.source.connectorId, spec: body.source.spec },
        {
          connectorId: body.target.connectorId,
          spec: body.target.spec,
          stopOnError: body.target.stopOnError,
        },
        body.transform ? { transform: body.transform } : undefined,
      )
      return summary
    } catch (e) {
      reply.code(400)
      return { error: e instanceof Error ? e.message : String(e) }
    }
  })
}
