/**
 * `sync_execute` agent tool.
 */

import type { ExecutableTool, Tool, ToolMetadata } from "../../ports/host.js"
import { executeSync } from "../../runtime/orchestrator/index.js"
import {
  formatSyncToolError,
} from "../_shared/helpers.js"
import type { SyncRuntimeHost } from "../../ports/index.js"
import { loadPlan } from "../../runtime/plan-store.js"

// ── sync_execute ──────────────────────────────────────

function buildSyncExecuteTool(host: SyncRuntimeHost): Tool {
  return {
    name: "sync_execute",
    description:
      "Apply a previously-computed sync plan (from sync_preview) to the target environment. " +
      "MUTATIVE — modifies target data inside a single transaction with rollback on any error. " +
      "Refuses to run if: confirm!=true, plan is missing/expired, plan is older than 1 hour, " +
      "catalog tip is ahead of published contract (publish_required), " +
      "target environment is read-only (hosted policy), PROD is locked, or governance preflight fails.",
    parameters: {
      type: "object",
      properties: {
        planId: { type: "string", description: "Plan UUID returned by sync_preview." },
        confirm: { type: "boolean", description: "Must be true to actually execute." }
      },
      required: ["planId", "confirm"]
    },
    async execute(args) {
      const planId = String(args.planId)
      const confirm = Boolean(args.confirm)
      if (!confirm) return `Error: confirm must be true to execute.`
      const plan = loadPlan(host, planId)
      if (!plan) return `Error: plan ${planId} not found or expired.`
      try {
        const result = await executeSync(planId, { host, confirm: true, userUpn: "agent" })
        if (result.outcome === "refused") return `Error: ${result.error}`
        if (result.outcome === "completed" && result.success) return `Plan ${planId} executed successfully against ${plan.target}.`
        return `Execute failed: ${result.error}`
      } catch (e) {
        return formatSyncToolError(e)
      }
    }
  }
}

export const syncExecuteToolMetadata: ToolMetadata = (() => {
  const stub = {} as SyncRuntimeHost
  const t = buildSyncExecuteTool(stub)
  return {
    name: t.name,
    description: t.description,
    parameters: t.parameters
  }
})()

export const syncExecuteTool = syncExecuteToolMetadata

export function createSyncExecuteTool(host: SyncRuntimeHost): ExecutableTool {
  return buildSyncExecuteTool(host)
}
