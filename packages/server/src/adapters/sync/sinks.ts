import type { AgentHost } from "@mia/agent"
import { syncPlanActorUpn } from "../../infra/persistence/sync-plan-actor.js"
import { broadcast } from "../../infra/events/broadcaster.js"
import { enrichSyncSqlEventData } from "../../infra/persistence/adapters/sqlite/db/sync-sql-log.js"
import {
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart
} from "../../infra/persistence/index.js"

export function createSyncEventSink(): AgentHost["sync"]["events"]["sink"] {
  return async (event) => {
    const data = await enrichSyncSqlEventData(event.type, event.data)
    broadcast({ type: event.type, data })
  }
}

/** Bridge lifecycle events → SSE + event_log (same path as sync). */
export function createBridgeEventSink(): AgentHost["connectors"]["events"]["sink"] {
  return (event) => {
    broadcast({ type: event.type, data: event.data })
  }
}

export function createSyncRunSink(): AgentHost["sync"]["runs"]["sink"] {
  const plans = new Map<string, Parameters<NonNullable<AgentHost["sync"]["runs"]["sink"]["savePlan"]>>[0]>()
  return {
    start: async (input) => {
      try {
        await recordSyncRunStart(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunStart failed:", error)
      }
    },
    finish: async (input) => {
      try {
        await recordSyncRunFinish(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunFinish failed:", error)
      }
    },
    savePlan: async (plan, actorUpn) => {
      try {
        plans.set(plan.planId, plan)
        const resolvedActorUpn = syncPlanActorUpn(plan) ?? actorUpn ?? null
        await recordSyncRunPreview({
          planId: plan.planId,
          entityType: plan.executionContract.definitionId,
          entityId: plan.entity.id,
          entityDisplayName: plan.entity.displayName,
          source: plan.source,
          target: plan.target,
          actorUpn: resolvedActorUpn,
          previewTotals: plan.totals,
          planJson: JSON.stringify(plan)
        })
      } catch (error) {
        console.warn("[sync] recordSyncRunPreview failed:", error)
      }
    },
    loadPlan: (planId) => {
      try {
        return plans.get(planId) ?? null
      } catch (error) {
        console.warn("[sync] getSyncRunPlanJson failed:", error)
        return null
      }
    }
  }
}
