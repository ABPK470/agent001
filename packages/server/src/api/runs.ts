/**
 * Run transport routes.
 */

import { EventType } from "@mia/agent"
import type { AuditEntry, LogEntry, Run, RunDetail } from "@mia/shared-types"
import type { FastifyInstance } from "fastify"
import { canAccessRun } from "../adapters/auth/access.js"
import { getAttachment, type AttachmentRow } from "../adapters/persistence/attachments.js"
import { flagRunMemory } from "../adapters/persistence/memory.js"
import * as db from "../adapters/persistence/sqlite.js"
import type { AgentOrchestrator } from "../application/shell/agent-orchestrator.js"
import { MemoryValidationAction } from "../enums/memory.js"

export function registerRunRoutes(app: FastifyInstance, orchestrator: AgentOrchestrator): void {
	app.get<{ Querystring: { scope?: "session" | "all" } }>("/api/runs", async (req) => {
		const s = req.session
		const sessionOnly = req.query.scope === "session"
		const runs = s?.isAdmin ? db.listRunsWithUsage() : db.listRunsWithUsageForUser({ upn: s?.upn ?? null, sid: s?.sid ?? null, sessionOnly })
		return runs.map((run): Run => {
			const diff = orchestrator.getRunWorkspaceDiff(run.id)
			const pendingWorkspaceChanges = diff ? diff.added.length + diff.modified.length + diff.deleted.length : 0
			return db.dbRunToWire(run, {
				totalTokens: run.total_tokens ?? 0,
				promptTokens: run.prompt_tokens ?? 0,
				completionTokens: run.completion_tokens ?? 0,
				llmCalls: run.llm_calls ?? 0,
				pendingWorkspaceChanges,
			})
		})
	})

	app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run) {
			reply.code(404)
			return { error: "Run not found" }
		}
		if (!canAccessRun(req.session, run)) {
			reply.code(404)
			return { error: "Run not found" }
		}

		const audit = db.getAuditLog(run.id)
		const logs = db.getLogs(run.id)
		const checkpoint = db.getCheckpoint(run.id)
		const usage = db.getTokenUsage(run.id)
		const pendingDiff = orchestrator.getRunWorkspaceDiff(run.id)
		const pendingWorkspaceChanges = pendingDiff ? pendingDiff.added.length + pendingDiff.modified.length + pendingDiff.deleted.length : 0

		return {
			...db.dbRunToWire(run, {
				totalTokens: usage?.total_tokens ?? 0,
				promptTokens: usage?.prompt_tokens ?? 0,
				completionTokens: usage?.completion_tokens ?? 0,
				llmCalls: usage?.llm_calls ?? 0,
				pendingWorkspaceChanges,
			}),
			audit: audit.map((entry): AuditEntry => ({ actor: entry.actor, action: entry.action, detail: JSON.parse(entry.detail), timestamp: entry.timestamp })),
			logs: logs.map((entry): LogEntry => {
				const isOldFormat = entry.level === "info" || entry.level === "error"
				if (isOldFormat) {
					const colonIdx = entry.message.indexOf(": ")
					const rawType = colonIdx > 0 ? entry.message.slice(0, colonIdx) : entry.level
					const typeGroup = rawType.startsWith("step.") || rawType.startsWith("tool_call.") ? "step" : rawType.startsWith("run.") ? "run" : "system"
					let msg = entry.message
					let error: boolean | undefined
					try {
						const payload = JSON.parse(entry.message.slice(colonIdx + 2)) as Record<string, unknown>
						const action = (payload.action ?? payload.name ?? "unknown") as string
						switch (rawType) {
							case EventType.RunStarted: msg = `Started — run ${((payload.runId as string) ?? "?").slice(0, 8)}`; break
							case EventType.StepStarted: msg = `${action} started`; break
							case EventType.StepCompleted: msg = `${action} completed`; break
							case EventType.StepFailed: msg = `${action} failed — ${((payload.error as string) ?? "unknown").slice(0, 200)}`; error = true; break
							default: msg = rawType.replace(/^[^.]+\./, "")
						}
					} catch {}
					if (entry.level === "error") error = true
					return { type: typeGroup, message: msg, timestamp: entry.timestamp, ...(error ? { error } : {}) }
				}
				const hasError = entry.level.endsWith(":error")
				const type = hasError ? entry.level.slice(0, -6) : entry.level
				return { type, message: entry.message, timestamp: entry.timestamp, ...(hasError ? { error: true } : {}) }
			}),
			hasCheckpoint: !!checkpoint,
		} satisfies RunDetail
	})

	app.post<{ Body: { goal: string; agentId?: string; attachmentIds?: string[] } }>("/api/runs", async (req, reply) => {
		const { goal, agentId, attachmentIds } = req.body
		if (!goal || typeof goal !== "string") {
			reply.code(400)
			return { error: "goal is required" }
		}

		const resolvedAttachmentIds: string[] = []
		if (Array.isArray(attachmentIds) && attachmentIds.length > 0) {
			const session = req.session
			const seen = new Set<string>()
			for (const id of attachmentIds) {
				if (typeof id !== "string" || seen.has(id)) continue
				seen.add(id)
				const row: AttachmentRow | undefined = getAttachment(id)
				if (!row) { reply.code(400); return { error: `attachment not found: ${id}` } }
				const allowed = !session || session.isAdmin || (row.owner_upn && row.owner_upn === session.upn) || (row.session_id && row.session_id === session.sid)
				if (!allowed) { reply.code(403); return { error: `attachment not accessible: ${id}` } }
				resolvedAttachmentIds.push(id)
			}
		}

		if (agentId) {
			const agent = db.getAgentDefinition(agentId)
			if (!agent) {
				reply.code(400)
				return { error: `Agent not found: ${agentId}` }
			}
			const runId = orchestrator.startRun(goal, { agentId: agent.id, systemPrompt: db.resolveAgentSystemPrompt(agent), attachmentIds: resolvedAttachmentIds }, req.session ?? null)
			reply.code(201)
			return { runId, agentId: agent.id, attachmentIds: resolvedAttachmentIds }
		}

		const runId = orchestrator.startRun(goal, { attachmentIds: resolvedAttachmentIds }, req.session ?? null)
		reply.code(201)
		return { runId, attachmentIds: resolvedAttachmentIds }
	})

	app.post<{ Params: { id: string } }>("/api/runs/:id/cancel", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const ok = orchestrator.cancelRun(req.params.id)
		if (!ok) {
			reply.code(404)
			return { error: "Run not found or not active" }
		}
		return { ok: true }
	})

	app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const newRunId = orchestrator.resumeRun(req.params.id, req.session ?? null)
		if (!newRunId) {
			reply.code(404)
			return { error: "Run not found or no checkpoint available" }
		}
		reply.code(201)
		return { runId: newRunId }
	})

	app.post<{ Params: { id: string } }>("/api/runs/:id/rerun", async (req, reply) => {
		const original = db.getRun(req.params.id)
		if (!original || !canAccessRun(req.session, original)) {
			reply.code(404)
			return { error: "Run not found" }
		}
		if (original.agent_id) {
			const agent = db.getAgentDefinition(original.agent_id)
			if (!agent) {
				reply.code(400)
				return { error: `Agent definition not found: ${original.agent_id}` }
			}
			const runId = orchestrator.startRun(original.goal, { agentId: agent.id, systemPrompt: db.resolveAgentSystemPrompt(agent) }, req.session ?? null)
			reply.code(201)
			return { runId, agentId: agent.id }
		}
		const runId = orchestrator.startRun(original.goal, undefined, req.session ?? null)
		reply.code(201)
		return { runId }
	})

	app.post<{ Params: { id: string }; Body: { response: string } }>("/api/runs/:id/respond", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const { response } = req.body
		if (!response && response !== "") {
			reply.code(400)
			return { error: "response is required" }
		}
		const ok = orchestrator.respondToRun(req.params.id, String(response))
		if (!ok) {
			reply.code(404)
			return { error: "No pending input request for this run" }
		}
		return { ok: true }
	})

	app.post<{ Params: { id: string }; Body: { toolCallId: string; message: string } }>("/api/runs/:id/kill-tool", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const { toolCallId, message } = req.body
		if (!toolCallId) {
			reply.code(400)
			return { error: "toolCallId is required" }
		}
		const ok = orchestrator.killToolCall(req.params.id, String(toolCallId), String(message ?? ""))
		if (!ok) {
			reply.code(404)
			return { error: "No executing tool call with that ID" }
		}
		return { ok: true }
	})

	app.get<{ Params: { id: string } }>("/api/runs/:id/trace", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		return db.getTraceEntries(req.params.id).map((entry) => JSON.parse(entry.data))
	})

	app.post<{ Params: { id: string }; Body: { useful: boolean; note?: string } }>("/api/runs/:id/feedback", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) {
			reply.code(404)
			return { error: "Run not found" }
		}
		const { useful, note } = req.body ?? {}
		if (useful !== false) {
			return { ok: true, action: MemoryValidationAction.None }
		}
		const flagged = flagRunMemory(req.params.id, note)
		if (!flagged) {
			return { ok: true, action: MemoryValidationAction.NoMemoryEntry }
		}
		return { ok: true, action: MemoryValidationAction.Flagged, runId: req.params.id }
	})

	app.get<{ Params: { id: string } }>("/api/runs/:id/workspace-diff", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const diff = orchestrator.getRunWorkspaceDiff(req.params.id)
		if (!diff) {
			reply.code(404)
			return { error: "No isolated workspace diff available for this run" }
		}
		const sourceRoot = orchestrator.getRunWorkspaceSourceRoot(req.params.id)
		const executionRoot = orchestrator.getRunWorkspaceExecutionRoot(req.params.id)
		return { runId: req.params.id, added: diff.added, modified: diff.modified, deleted: diff.deleted, total: diff.added.length + diff.modified.length + diff.deleted.length, sourceRoot: sourceRoot ?? undefined, executionRoot: executionRoot ?? undefined }
	})

	app.post<{ Params: { id: string } }>("/api/runs/:id/workspace-diff/apply", async (req, reply) => {
		const run = db.getRun(req.params.id)
		if (!run || !canAccessRun(req.session, run)) { reply.code(404); return { error: "Run not found" } }
		const applied = await orchestrator.applyRunWorkspaceDiff(req.params.id)
		if (!applied) {
			reply.code(404)
			return { error: "No pending isolated workspace diff to apply" }
		}
		return { ok: true, runId: req.params.id, applied }
	})

	app.get("/api/runs/active", async (req) => {
		const ids = orchestrator.getActiveRunIds()
		if (req.session?.isAdmin) return { runIds: ids }
		const visible = ids.filter((id) => {
			const run = db.getRun(id)
			return canAccessRun(req.session, run ?? null)
		})
		return { runIds: visible }
	})

	app.get("/api/queue", async () => orchestrator.getQueueStats())
}
