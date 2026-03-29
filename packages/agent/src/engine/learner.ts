/**
 * Learner — aggregates execution metrics for feedback.
 *
 * Stats can feed back into tool selection and retry decisions.
 */

import type { ExecutionRecord } from "./models.js"
import type { ExecutionRecordRepository } from "./interfaces.js"

export interface OperationStats {
  total: number
  successes: number
  failures: number
  avgDurationMs: number
}

export class Learner {
  constructor(private readonly repo: ExecutionRecordRepository) {}

  async record(rec: ExecutionRecord): Promise<void> {
    await this.repo.append(rec)
  }

  async statsFor(action: string): Promise<OperationStats> {
    const records = await this.repo.listByAction(action)
    if (records.length === 0) {
      return { total: 0, successes: 0, failures: 0, avgDurationMs: 0 }
    }
    const successes = records.filter(r => r.success).length
    const totalMs = records.reduce((sum, r) => sum + r.durationMs, 0)
    return {
      total: records.length,
      successes,
      failures: records.length - successes,
      avgDurationMs: totalMs / records.length,
    }
  }
}
