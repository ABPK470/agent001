/**
 * Usage API routes — token consumption tracking.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../db.js"

export function registerUsageRoutes(app: FastifyInstance): void {

  // Get usage summary (totals + per-run breakdown)
  app.get("/api/usage", async () => {
    const totals = db.getUsageTotals()
    const perRun = db.listTokenUsage(50)

    return {
      totals: {
        promptTokens: totals.total_prompt_tokens,
        completionTokens: totals.total_completion_tokens,
        totalTokens: totals.total_tokens,
        llmCalls: totals.total_llm_calls,
        runCount: totals.run_count,
      },
      runs: perRun.map((r) => ({
        runId: r.run_id,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.total_tokens,
        llmCalls: r.llm_calls,
        model: r.model,
        createdAt: r.created_at,
      })),
    }
  })
}
