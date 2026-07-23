/**
 * Try the planner path.
 *
 * Input: goal, messages, loop state, LLM, tools, config.
 * Output named outcomes:
 *   - answered — planner finished; stop the run with this answer
 *   - use_tool_loop — continue with the iterative tool loop
 *   - planner_disabled — planner not wired; continue with the tool loop
 * Next: finish, or prepareIteration.
 */

import { attemptPlannerRouting, type PlannerRoutingContext } from "../../../core/choose-path.js"
import { assertUnhandled } from "../unhandled-outcome.js"

export type PlannerPathResult =
  | { outcome: "answered"; answer: string }
  | { outcome: "use_tool_loop" }
  | { outcome: "planner_disabled" }

export async function tryPlannerPath(ctx: PlannerRoutingContext): Promise<PlannerPathResult> {
  const result = await attemptPlannerRouting(ctx)
  if (result.outcome === "answered") {
    return { outcome: "answered", answer: result.answer }
  }
  if (result.outcome === "use_tool_loop" || result.outcome === "planner_disabled") {
    return { outcome: "use_tool_loop" }
  }
  assertUnhandled("tryPlannerPath", result)
}
