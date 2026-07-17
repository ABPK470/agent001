/**
 * Bridge transport routes — admin-only preview + run over the
 * connector-adapter engine. Emits bridge.* lifecycle events into the
 * platform event bus (Event Stream + Pipelines), same path as sync.
 */

import { randomUUID } from "node:crypto"
import { type AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
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

function emitBridge(
  host: AgentHost,
  type: (typeof EventType)[keyof typeof EventType],
  data: Record<string, unknown>,
): void {
  try {
    host.connectors.events.sink({ type, data })
  } catch (e) {
    console.error(`[bridge.event] sink failed for ${type}:`, e)
  }
}

function connectorLabel(host: AgentHost, connectorId: string): string {
  const hit = host.connectors.port.value?.listAdapters().find((c) => c.id === connectorId)
  return hit?.displayName ?? connectorId
}

export function registerBridgeRoutes(app: FastifyInstance, host: AgentHost): void {
  app.get("/api/bridge/connectors", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) return { connectors: [] }
    return { connectors: port.listAdapters() }
  })

  app.post<{ Body: PreviewBody }>("/api/bridge/preview", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) {
      reply.code(503)
      return { error: "connector bridge is not configured on this server" }
    }
    const body = req.body ?? ({} as PreviewBody)
    if (!body.source?.connectorId || !body.source?.spec) {
      reply.code(400)
      return { error: "source.connectorId and source.spec are required" }
    }
    const moveId = randomUUID()
    const sourceName = connectorLabel(host, body.source.connectorId)
    emitBridge(host, EventType.BridgePreviewStarted, {
      moveId,
      sourceId: body.source.connectorId,
      source: sourceName,
      limit: body.limit ?? null,
      hasTransform: Boolean(body.transform),
    })
    try {
      const result = await port.previewMove(
        { connectorId: body.source.connectorId, spec: body.source.spec },
        { transform: body.transform, limit: body.limit },
      )
      emitBridge(host, EventType.BridgePreviewCompleted, {
        moveId,
        sourceId: body.source.connectorId,
        source: sourceName,
        rowCount: result.rows.length,
        truncated: result.truncated,
      })
      return { rows: result.rows, truncated: result.truncated }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      emitBridge(host, EventType.BridgePreviewFailed, {
        moveId,
        sourceId: body.source.connectorId,
        source: sourceName,
        error,
      })
      reply.code(400)
      return { error }
    }
  })

  app.post<{ Body: RunBody }>("/api/bridge/run", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) {
      reply.code(503)
      return { error: "connector bridge is not configured on this server" }
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
    const moveId = randomUUID()
    const sourceName = connectorLabel(host, body.source.connectorId)
    const targetName = connectorLabel(host, body.target.connectorId)
    emitBridge(host, EventType.BridgeRunStarted, {
      moveId,
      sourceId: body.source.connectorId,
      targetId: body.target.connectorId,
      source: sourceName,
      target: targetName,
      hasTransform: Boolean(body.transform),
    })
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
      if (summary.status === "failed") {
        emitBridge(host, EventType.BridgeRunFailed, {
          moveId,
          sourceId: body.source.connectorId,
          targetId: body.target.connectorId,
          source: sourceName,
          target: targetName,
          status: summary.status,
          rowsRead: summary.rowsRead,
          rowsWritten: summary.rowsWritten,
          failedAtRow: summary.failedAtRow,
          error: summary.errors[0]?.message ?? "move failed",
          errorCount: summary.errors.length,
        })
      } else {
        emitBridge(host, EventType.BridgeRunCompleted, {
          moveId,
          sourceId: body.source.connectorId,
          targetId: body.target.connectorId,
          source: sourceName,
          target: targetName,
          status: summary.status,
          rowsRead: summary.rowsRead,
          rowsWritten: summary.rowsWritten,
          failedAtRow: summary.failedAtRow,
          errorCount: summary.errors.length,
        })
      }
      return summary
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      emitBridge(host, EventType.BridgeRunFailed, {
        moveId,
        sourceId: body.source.connectorId,
        targetId: body.target.connectorId,
        source: sourceName,
        target: targetName,
        error,
      })
      reply.code(400)
      return { error }
    }
  })
}
