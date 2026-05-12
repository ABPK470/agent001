/**
 * Layer 4: LLM-assisted routing classifier. Extracted from assess.ts.
 *
 * @module
 */

import type { LLMClient } from "../../types.js"
import type { PlannerNeedLevel } from "../types.js"

export interface LLMRouterResult {
  coherence_need: PlannerNeedLevel
  coordination_need: PlannerNeedLevel
  reasoning: string
}

const LLM_ROUTER_SYSTEM = `You are a task routing classifier for an AI agent system.
Classify the following user task to determine the correct execution path.

Return ONLY valid JSON — no prose, no markdown fences:
{
  "coherence_need": "low" | "medium" | "high",
  "coordination_need": "low" | "medium" | "high",
  "reasoning": "<one sentence>"
}

Definitions:
- coherence_need HIGH: the task is a single bounded deliverable that benefits from one cohesive generation pass (a game, an app, a tool, a widget, a dashboard, a single system).
- coordination_need HIGH: the task genuinely requires parallel or sequential INDEPENDENT work units with separate file ownership (e.g. multiple unrelated components, a multi-service architecture, an enumerated list of separate features).
- When in doubt, prefer coherence_need=high and coordination_need=low (simplicity default — attempt the whole thing in one coherent pass before over-committing to a plan).

Key distinctions:
- "all project files" in an organizational preamble ("Create a tmp dir where all files will be stored. Build a chess game") → coordination_need=low, the chess game is one bounded task.
- "multiple independent components" enumerated as separate deliverables → coordination_need=high.
- A single app/game/tool mentioning several features → coordination_need=low (features co-exist in one codebase).`

export async function callLLMRouter(
  normalized: string,
  llm: LLMClient,
  signal?: AbortSignal,
): Promise<LLMRouterResult | null> {
  try {
    const response = await llm.chat(
      [
        { role: "system", content: LLM_ROUTER_SYSTEM },
        { role: "user", content: `Task:\n${normalized.slice(0, 1200)}` },
      ],
      [],
      { signal },
    )
    const raw = (response.content ?? "").trim()
    const jsonText = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    const parsed = JSON.parse(jsonText) as Record<string, unknown>
    if (
      typeof parsed.coherence_need === "string"
      && typeof parsed.coordination_need === "string"
      && ["low", "medium", "high"].includes(parsed.coherence_need)
      && ["low", "medium", "high"].includes(parsed.coordination_need)
    ) {
      return {
        coherence_need: parsed.coherence_need as PlannerNeedLevel,
        coordination_need: parsed.coordination_need as PlannerNeedLevel,
        reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      }
    }
    return null
  } catch {
    return null
  }
}
