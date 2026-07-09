/**
 * Build a proposer-scan pipeline from sync.proposer / sync.proposal events.
 */

import { EventType } from "@mia/shared-enums"
import { OperationKind, OperationStatus } from "../../../../../shared/enums/operations.js"
import { getProposerRun } from "../../../../../platform/persistence/proposals.js"
import type { OperationActivity, OperationEvent, OperationPipeline } from "../types.js"
import { durationOf, inferPipelineStatus, numField, strField } from "../utils.js"

export function buildProposerRunPipeline(runId: string, events: OperationEvent[]): OperationPipeline {
  const row = getProposerRun(runId)
  const startedAt = events[0]?.timestamp ?? row?.started_at ?? new Date().toISOString()
  const lastEv = events[events.length - 1]
  const startedEvent = events.find((e) => e.type === EventType.SyncProposerRunStarted)
  const envPair = startedEvent?.data["envPair"] as { source?: string; target?: string } | undefined

  const source = row?.source ?? envPair?.source ?? "?"
  const target = row?.target ?? envPair?.target ?? "?"

  const status: OperationStatus =
    row?.status === "completed"
      ? OperationStatus.Success
      : row?.status === "failed"
        ? OperationStatus.Failed
        : row?.status === "cancelled"
          ? OperationStatus.Cancelled
          : row?.status === "running" || row?.status === "pending"
            ? OperationStatus.Running
            : inferPipelineStatus(events)

  const endedAt =
    row?.finished_at ??
    (status !== OperationStatus.Running ? lastEv?.timestamp ?? null : null)

  const activities = groupProposerActivities(events)

  return {
    id: runId,
    kind: OperationKind.ProposerRun,
    title: `Scan ${source} → ${target}`,
    subtitle: row ? `${row.trigger} · ${row.triggered_by}` : runId.slice(0, 8),
    status,
    startedAt,
    endedAt,
    durationMs: row?.duration_ms ?? durationOf(startedAt, endedAt),
    activityCount: activities.length,
    eventCount: events.length,
    error: row?.error ?? undefined,
    activities,
  }
}

function groupProposerActivities(events: OperationEvent[]): OperationActivity[] {
  const activities: OperationActivity[] = []
  const proposalEvents: OperationEvent[] = []
  const misc: OperationEvent[] = []

  for (const ev of events) {
    const t = ev.type
    if (t === EventType.SyncProposerRunStarted) {
      activities.push(lifecycleActivity("started", "Scan started", OperationStatus.Success, ev))
      continue
    }
    if (t === EventType.SyncProposerRunCompleted) {
      const inserted = numField(ev.data, "inserted")
      activities.push(
        lifecycleActivity(
          "completed",
          "Scan completed",
          OperationStatus.Success,
          ev,
          inserted != null ? `${inserted} new proposal${inserted === 1 ? "" : "s"}` : undefined,
        ),
      )
      continue
    }
    if (t === EventType.SyncProposerRunFailed) {
      activities.push(
        lifecycleActivity(
          "failed",
          "Scan failed",
          OperationStatus.Failed,
          ev,
          undefined,
          strField(ev.data, "error") ?? undefined,
        ),
      )
      continue
    }
    if (t === EventType.SyncProposerRunCancelled) {
      activities.push(
        lifecycleActivity(
          "cancelled",
          "Scan cancelled",
          OperationStatus.Cancelled,
          ev,
          strField(ev.data, "reason") ?? undefined,
        ),
      )
      continue
    }
    if (t === EventType.SyncProposalCreated) {
      proposalEvents.push(ev)
      continue
    }
    misc.push(ev)
  }

  if (proposalEvents.length > 0) {
    const start = proposalEvents[0].timestamp
    const end = proposalEvents[proposalEvents.length - 1].timestamp
    activities.push({
      id: "proposals",
      name: "Findings ingested",
      status: OperationStatus.Success,
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      summary: `${proposalEvents.length} proposal${proposalEvents.length === 1 ? "" : "s"}`,
      events: proposalEvents,
    })
  }

  if (misc.length > 0) {
    const start = misc[0].timestamp
    const end = misc[misc.length - 1].timestamp
    activities.push({
      id: "misc",
      name: "Other events",
      status: inferPipelineStatus(misc),
      startedAt: start,
      endedAt: end,
      durationMs: durationOf(start, end),
      events: misc,
    })
  }

  activities.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return activities
}

function lifecycleActivity(
  id: string,
  name: string,
  status: OperationStatus,
  ev: OperationEvent,
  summary?: string,
  error?: string,
): OperationActivity {
  return {
    id,
    name,
    status,
    startedAt: ev.timestamp,
    endedAt: ev.timestamp,
    durationMs: 0,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    events: [ev],
  }
}
