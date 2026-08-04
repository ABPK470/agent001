/**
 * Live-sim + seed scenario catalog — one registry for Direct / Planner seq / Parallel.
 */

import type { TraceEntry } from "@mia/shared-types"
import {
  buildDirectFourCalls,
  buildPlannerFiveCalls,
  buildPlannerParallel,
} from "../../api/runs/service/demo-trace-builders.js"

export type DemoRunScenarioId = "direct" | "planner-seq" | "planner-parallel"
export type DemoRunPace = "fast" | "normal" | "slow"

export type DemoRunScenario = {
  id: DemoRunScenarioId
  label: string
  goal: string
  buildTrace: () => TraceEntry[]
  terminalStatus: "completed" | "failed" | "cancelled"
}

export const DEMO_RUN_SCENARIOS: Record<DemoRunScenarioId, DemoRunScenario> = {
  direct: {
    id: "direct",
    label: "Direct route",
    goal: "List top bankers and export a small CSV summary",
    buildTrace: buildDirectFourCalls,
    terminalStatus: "completed",
  },
  "planner-seq": {
    id: "planner-seq",
    label: "Planner (sequential)",
    goal:
      "Build a small dashboard site with a landing page, metrics page, and export endpoint. Create the schema, API, then frontend.",
    buildTrace: buildPlannerFiveCalls,
    terminalStatus: "completed",
  },
  "planner-parallel": {
    id: "planner-parallel",
    label: "Planner (parallel)",
    goal: "Preview client 9 sync in parallel with writing an ops checklist",
    buildTrace: buildPlannerParallel,
    terminalStatus: "completed",
  },
}

export function isDemoRunScenarioId(value: unknown): value is DemoRunScenarioId {
  return value === "direct" || value === "planner-seq" || value === "planner-parallel"
}

export function isDemoRunPace(value: unknown): value is DemoRunPace {
  return value === "fast" || value === "normal" || value === "slow"
}

/** Base delay between paced events (ms). */
export function paceDelayMs(pace: DemoRunPace, entry: TraceEntry): number {
  const base = pace === "fast" ? 60 : pace === "slow" ? 420 : 180
  switch (entry.kind) {
    case "llm-request":
      return base
    case "llm-response":
      return Math.round(base * 1.6)
    case "tool-call":
      return Math.round(base * 0.9)
    case "tool-result":
    case "tool-error":
      return Math.round(base * 1.3)
    case "sync-progress":
      return Math.round(base * 1.1)
    case "thinking":
      return Math.round(base * 0.8)
    case "answer":
      return Math.round(base * 0.5)
    default:
      return base
  }
}
