/**
 * Bridge transport routes — admin-only preview + run over the
 * connector-adapter engine. Emits bridge.* lifecycle (+ progress) events into
 * the platform event bus (Event Stream + Pipelines), same path as sync.
 *
 * Long-running preview/run register AbortControllers so Pipelines Stop is a
 * true cancel (same dialect as sync execute / proposer).
 */

import { randomUUID } from "node:crypto"
import { type AgentHost } from "@mia/agent"
import { EventType } from "@mia/shared-enums"
import {
  summarizeBridgeReadSpec,
  summarizeBridgeWriteSpec,
  type ReadSpec,
  type Transform,
  type WriteSpec,
} from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import {
  cancelOperation,
  registerOperation,
  unregisterOperation,
} from "../../../infra/operations/cancel-registry.js"
import { createBridgeProgressThrottle, errorsPreview } from "./bridge-telemetry.js"

export const BRIDGE_PREVIEW_OPERATION = "bridge.preview" as const
export const BRIDGE_RUN_OPERATION = "bridge.run" as const

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

function adapters(host: AgentHost) {
  return host.connectors.port.value?.listAdapters() ?? []
}

function connectorMeta(host: AgentHost, connectorId: string): { name: string; kind: string } {
  const hit = adapters(host).find((c) => c.id === connectorId)
  return { name: hit?.displayName ?? connectorId, kind: hit?.kind ?? "?" }
}

function isCancelled(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  const msg = error instanceof Error ? error.message : String(error)
  return /cancel/i.test(msg)
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
    const t0 = Date.now()
    const src = connectorMeta(host, body.source.connectorId)
    const sourceSpecLabel = summarizeBridgeReadSpec(body.source.spec)
    const base = {
      moveId,
      sourceId: body.source.connectorId,
      source: src.name,
      sourceKind: src.kind,
      sourceSpec: sourceSpecLabel,
      limit: body.limit ?? null,
      hasTransform: Boolean(body.transform),
      via: "ui" as const,
      actorUpn: req.session?.upn ?? null,
    }
    emitBridge(host, EventType.BridgePreviewStarted, base)
    const signal = registerOperation(
      BRIDGE_PREVIEW_OPERATION,
      moveId,
      `Bridge preview ${moveId.slice(0, 8)}`,
    )
    try {
      const result = await port.previewMove(
        { connectorId: body.source.connectorId, spec: body.source.spec },
        { transform: body.transform, limit: body.limit, signal },
      )
      emitBridge(host, EventType.BridgePreviewCompleted, {
        ...base,
        rowCount: result.rows.length,
        truncated: result.truncated,
        durationMs: Date.now() - t0,
      })
      return { rows: result.rows, truncated: result.truncated }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (isCancelled(e, signal)) {
        emitBridge(host, EventType.BridgePreviewCancelled, {
          ...base,
          error: "Cancelled by user",
          durationMs: Date.now() - t0,
        })
        reply.code(499)
        return { error: "Cancelled by user", cancelled: true, moveId }
      }
      emitBridge(host, EventType.BridgePreviewFailed, {
        ...base,
        error,
        durationMs: Date.now() - t0,
      })
      reply.code(400)
      return { error }
    } finally {
      unregisterOperation(BRIDGE_PREVIEW_OPERATION, moveId)
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
    const t0 = Date.now()
    const src = connectorMeta(host, body.source.connectorId)
    const tgt = connectorMeta(host, body.target.connectorId)
    const writeSpec = body.target.spec
    const base = {
      moveId,
      sourceId: body.source.connectorId,
      targetId: body.target.connectorId,
      source: src.name,
      target: tgt.name,
      sourceKind: src.kind,
      targetKind: tgt.kind,
      sourceSpec: summarizeBridgeReadSpec(body.source.spec),
      targetSpec: summarizeBridgeWriteSpec(writeSpec),
      hasTransform: Boolean(body.transform),
      allowIdentityInsert:
        writeSpec.kind === "sql" ? Boolean(writeSpec.allowIdentityInsert) : false,
      relaxConstraints: writeSpec.kind === "sql" ? Boolean(writeSpec.relaxConstraints) : false,
      writeMode: writeSpec.kind === "sql" ? writeSpec.mode : "mode" in writeSpec ? writeSpec.mode : null,
      via: "ui" as const,
      actorUpn: req.session?.upn ?? null,
    }
    emitBridge(host, EventType.BridgeRunStarted, base)
    const signal = registerOperation(
      BRIDGE_RUN_OPERATION,
      moveId,
      `Bridge move ${moveId.slice(0, 8)}`,
    )
    const throttle = createBridgeProgressThrottle()
    try {
      const summary = await port.moveData(
        { connectorId: body.source.connectorId, spec: body.source.spec },
        {
          connectorId: body.target.connectorId,
          spec: body.target.spec,
          stopOnError: body.target.stopOnError,
        },
        {
          ...(body.transform ? { transform: body.transform } : {}),
          signal,
          onProgress: ({ rowsRead, rowsWritten }) => {
            throttle(rowsRead, () => {
              emitBridge(host, EventType.BridgeRunProgress, {
                moveId,
                sourceId: body.source.connectorId,
                targetId: body.target.connectorId,
                source: src.name,
                target: tgt.name,
                rowsRead,
                rowsWritten,
                elapsedMs: Date.now() - t0,
                via: "ui",
              })
            })
          },
        },
      )
      const terminal = {
        ...base,
        status: summary.status,
        rowsRead: summary.rowsRead,
        rowsWritten: summary.rowsWritten,
        failedAtRow: summary.failedAtRow,
        errorCount: summary.errors.length,
        errorsPreview: errorsPreview(summary.errors),
        durationMs: Date.now() - t0,
      }
      if (summary.status === "failed") {
        emitBridge(host, EventType.BridgeRunFailed, {
          ...terminal,
          error: summary.errors[0]?.message ?? "move failed",
        })
      } else {
        emitBridge(host, EventType.BridgeRunCompleted, terminal)
      }
      return summary
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      if (isCancelled(e, signal)) {
        emitBridge(host, EventType.BridgeRunCancelled, {
          ...base,
          error: "Cancelled by user",
          durationMs: Date.now() - t0,
        })
        reply.code(499)
        return { error: "Cancelled by user", cancelled: true, moveId }
      }
      emitBridge(host, EventType.BridgeRunFailed, {
        ...base,
        error,
        durationMs: Date.now() - t0,
      })
      reply.code(400)
      return { error }
    } finally {
      unregisterOperation(BRIDGE_RUN_OPERATION, moveId)
    }
  })

  app.post<{ Params: { moveId: string } }>("/api/bridge/:moveId/cancel", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const moveId = req.params.moveId
    const cancelled =
      cancelOperation(BRIDGE_RUN_OPERATION, moveId) ||
      cancelOperation(BRIDGE_PREVIEW_OPERATION, moveId)
    if (!cancelled) {
      reply.code(404)
      return { error: "No active bridge move to cancel" }
    }
    return { cancelled: true, moveId }
  })

  app.get<{ Params: { id: string } }>("/api/bridge/connectors/:id/tables", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "admin only" }
    }
    const port = host.connectors.port.value
    if (!port) {
      reply.code(503)
      return { error: "connector bridge is not configured on this server" }
    }
    try {
      const tables = await port.listTables(req.params.id)
      return { tables }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      reply.code(400)
      return { error }
    }
  })
}
