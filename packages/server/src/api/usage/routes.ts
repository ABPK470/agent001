/**
 * Usage transport routes — admin token-usage browser.
 */

import type { FastifyInstance } from "fastify"
import * as db from "../../infra/persistence/sqlite.js"

const USAGE_STATUS_FILTERS = new Set([
  "completed",
  "failed",
  "cancelled",
  "crashed",
  "running",
])

function parseUsageSort(raw: string | undefined): db.TokenUsageSort {
  if (raw === "created_asc" || raw === "tokens_desc" || raw === "tokens_asc") return raw
  return "created_desc"
}

function parseUsageStatuses(raw: string | undefined): string[] | undefined {
  if (!raw?.trim()) return undefined
  const statuses = [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => USAGE_STATUS_FILTERS.has(s)),
    ),
  ]
  return statuses.length > 0 ? statuses : undefined
}

function parseUsageQuery(query: Record<string, string | undefined>): db.ListTokenUsagePaginatedInput {
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 50))
  return {
    page,
    pageSize,
    search: query.q?.trim() || undefined,
    user: query.user?.trim() || undefined,
    model: query.model?.trim() || undefined,
    status: parseUsageStatuses(query.status),
    from: query.from?.trim() || undefined,
    to: query.to?.trim() || undefined,
    sort: parseUsageSort(query.sort),
  }
}

function mapUsageRow(row: db.DbTokenUsageWithRun) {
  return {
    runId: row.run_id,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    llmCalls: row.llm_calls,
    model: row.model,
    createdAt: row.created_at,
    user: row.run_upn,
    displayName: row.run_display_name,
    goal: row.run_goal,
    status: row.run_status,
    threadId: row.thread_id,
    threadTitle: row.thread_title,
  }
}

export function registerUsageRoutes(app: FastifyInstance): void {
  app.get("/api/usage/options", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "Forbidden" }
    }
    return await db.listTokenUsageFilterOptions()
  })

  app.get("/api/usage", async (req, reply) => {
    if (!req.session?.isAdmin) {
      reply.code(403)
      return { error: "Forbidden" }
    }
    const filters = parseUsageQuery(req.query as Record<string, string | undefined>)
    const totals = await db.sumTokenUsage(filters)
    const total = await db.countTokenUsage(filters)
    const rows = await db.listTokenUsagePaginated(filters)
    const totalPages = Math.max(1, Math.ceil(total / filters.pageSize))

    // Total tokens must equal prompt + completion (never an independent SUM that can drift).
    const promptTokens = totals.total_prompt_tokens
    const completionTokens = totals.total_completion_tokens
    return {
      totals: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        llmCalls: totals.total_llm_calls,
        runCount: totals.run_count,
        completedRuns: totals.completed_runs,
        failedRuns: totals.failed_runs,
        cancelledRuns: totals.cancelled_runs,
        crashedRuns: totals.crashed_runs,
        runningRuns: totals.running_runs,
      },
      items: rows.map(mapUsageRow),
      /** @deprecated Prefer `items` — kept for transitional clients. */
      runs: rows.map(mapUsageRow),
      total,
      page: filters.page,
      pageSize: filters.pageSize,
      totalPages,
    }
  })
}
