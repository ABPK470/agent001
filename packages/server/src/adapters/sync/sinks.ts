import type { AgentHost } from "@mia/agent"
import { syncPlanActorUpn } from "../../infra/persistence/sync-plan-actor.js"
import { broadcast } from "../../infra/events/broadcaster.js"
import { enrichSyncSqlEventData } from "../../infra/persistence/db/sync-sql-log.js"
import {
  getSyncRunPlanJson,
  recordSyncRunFinish,
  recordSyncRunPreview,
  recordSyncRunStart
} from "../../infra/persistence/index.js"

export function createSyncEventSink(): AgentHost["sync"]["events"]["sink"] {
  return (event) => {
    const data = enrichSyncSqlEventData(event.type, event.data)
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
  return {
    start: (input) => {
      try {
        recordSyncRunStart(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunStart failed:", error)
      }
    },
    finish: (input) => {
      try {
        recordSyncRunFinish(input)
      } catch (error) {
        console.warn("[sync] recordSyncRunFinish failed:", error)
      }
    },
    savePlan: (plan, actorUpn) => {
      try {
        const resolvedActorUpn = syncPlanActorUpn(plan) ?? actorUpn ?? null
        recordSyncRunPreview({
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
        const json = getSyncRunPlanJson(planId)
        return json ? JSON.parse(json) : null
      } catch (error) {
        console.warn("[sync] getSyncRunPlanJson failed:", error)
        return null
      }
    }
  }
}
