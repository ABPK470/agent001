/**
 * Usage transport routes.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../adapters/persistence/sqlite.js"

export function registerUsageRoutes(app: FastifyInstance): void {
	app.get("/api/usage", async (req, reply) => {
		if (!req.session?.isAdmin) {
			reply.code(403)
			return { error: "Forbidden" }
		}
		const totals = db.getUsageTotals()
		const perRun = db.listTokenUsage(50)

		return {
			totals: {
				promptTokens: totals.total_prompt_tokens,
				completionTokens: totals.total_completion_tokens,
				totalTokens: totals.total_tokens,
				llmCalls: totals.total_llm_calls,
				runCount: totals.run_count,
				completedRuns: totals.completed_runs,
				failedRuns: totals.failed_runs,
			},
			runs: perRun.map((run) => ({
				runId: run.run_id,
				promptTokens: run.prompt_tokens,
				completionTokens: run.completion_tokens,
				totalTokens: run.total_tokens,
				llmCalls: run.llm_calls,
				model: run.model,
				createdAt: run.created_at,
			})),
		}
	})
}