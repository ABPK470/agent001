/**
 * Delegation bandit tuner — online UCB1 arm selection for delegation scoring.
 *
 * Ported from agenc-core's delegation-learning pattern.
 *
 * The delegation decision system uses a static threshold to decide whether to
 * delegate a subagent step. This module wraps that decision with an online
 * multi-armed bandit (UCB1) that continuously adjusts the effective threshold
 * based on observed outcomes, learning which strategy (conservative /
 * balanced / aggressive) achieves the best quality-cost trade-off.
 *
 * Three arms:
 *   conservative  scoreThreshold += 0.10  (harder to delegate — safer)
 *   balanced      scoreThreshold += 0.00  (default threshold)
 *   aggressive    scoreThreshold -= 0.08  (easier to delegate — faster)
 *
 * Reward signal:
 *   reward = quality_proxy − token_cost_penalty − error_count_penalty − latency_penalty
 *   all terms clamped to [0, 1]
 *
 * Integration (in planner/index.ts):
 *   1. Call tuner.selectArm() before assessDelegationDecision().
 *   2. Apply tuner.getThresholdAdjustment(armId) to the config scoreThreshold.
 *   3. After pipeline + verifier complete, call tuner.recordOutcome(record).
 *
 * @module
 */

// ============================================================================
// Arm definitions
// ============================================================================

export type BanditArmId = "conservative" | "balanced" | "aggressive"

export interface BanditArm {
  readonly id: BanditArmId
  /** Delta applied to the base scoreThreshold when this arm is active. */
  readonly thresholdDelta: number
  /** Cumulative mean reward (running average, maintained via Welford update). */
  meanReward: number
  /** Number of times this arm has been pulled and an outcome recorded. */
  sampleCount: number
}

// ============================================================================
// Trajectory record
// ============================================================================

export interface DelegationTrajectoryRecord {
  /** Wall time of the delegation decision. */
  readonly timestamp: number
  /** Arm selected for this trajectory. */
  readonly armId: BanditArmId
  /** Effective scoreThreshold used for this decision. */
  readonly appliedThreshold: number
  // ── State features at decision time ───────────────────────────────────────
  readonly complexityScore: number
  readonly fanoutCount: number
  readonly stepCount: number
  readonly nestingDepth: number
  readonly parallelFraction: number
  // ── Decision outcome ──────────────────────────────────────────────────────
  readonly shouldDelegate: boolean
  readonly utilityScore: number
  // ── Execution outcome (filled in after the pipeline run) ─────────────────
  outcome?: {
    readonly durationMs: number
    /** Total LLM tokens consumed by the delegated steps. */
    readonly tokenCount: number
    /** Number of tool / step errors. */
    readonly errorCount: number
    /** Quality proxy score in [0, 1]. */
    readonly qualityProxy: number
    /** Whether the verifier passed for this delegation. */
    readonly verifierPassed: boolean
    /** Final computed reward in [0, 1]. */
    readonly reward: number
  }
}

// ============================================================================
// Bandit tuner
// ============================================================================

/**
 * UCB1 bandit tuner for delegation threshold adjustment.
 *
 * UCB1 formula: score_i = mean_reward_i + c * sqrt(ln(N) / n_i)
 * where N = total pulls across all arms, n_i = pulls for arm i, c = explorationFactor.
 *
 * For arms with zero samples, score = Infinity (force exploration first).
 */
export class DelegationBanditTuner {
  private readonly arms: Map<BanditArmId, BanditArm>
  private totalPulls: number = 0
  private readonly explorationFactor: number
  private readonly trajectories: DelegationTrajectoryRecord[] = []

  constructor(explorationFactor = 1.5) {
    this.explorationFactor = explorationFactor
    this.arms = new Map([
      ["conservative", { id: "conservative", thresholdDelta: 0.10, meanReward: 0, sampleCount: 0 }],
      ["balanced",     { id: "balanced",     thresholdDelta: 0.00, meanReward: 0, sampleCount: 0 }],
      ["aggressive",   { id: "aggressive",   thresholdDelta: -0.08, meanReward: 0, sampleCount: 0 }],
    ])
  }

  /**
   * Select the best arm using UCB1.
   * Arms with no samples get infinite UCB score (initial exploration phase).
   */
  selectArm(): BanditArmId {
    let bestArm: BanditArmId = "balanced"
    let bestScore = -Infinity
    const logTotal = this.totalPulls > 0 ? Math.log(this.totalPulls) : 0

    for (const arm of this.arms.values()) {
      let score: number
      if (arm.sampleCount === 0) {
        score = Infinity
      } else {
        const explorationBonus = this.explorationFactor * Math.sqrt(logTotal / arm.sampleCount)
        score = arm.meanReward + explorationBonus
      }
      if (score > bestScore) {
        bestScore = score
        bestArm = arm.id
      }
    }
    return bestArm
  }

  /**
   * Get the threshold adjustment (delta) for a given arm.
   */
  getThresholdAdjustment(armId: BanditArmId): number {
    return this.arms.get(armId)?.thresholdDelta ?? 0
  }

  /**
   * Build a new trajectory record at decision time (before execution).
   * Caller fills in the `outcome` field after the pipeline run and calls recordOutcome().
   */
  buildTrajectory(params: {
    armId: BanditArmId
    appliedThreshold: number
    complexityScore: number
    fanoutCount: number
    stepCount: number
    nestingDepth: number
    parallelFraction: number
    shouldDelegate: boolean
    utilityScore: number
  }): DelegationTrajectoryRecord {
    return {
      timestamp: Date.now(),
      armId: params.armId,
      appliedThreshold: params.appliedThreshold,
      complexityScore: params.complexityScore,
      fanoutCount: params.fanoutCount,
      stepCount: params.stepCount,
      nestingDepth: params.nestingDepth,
      parallelFraction: params.parallelFraction,
      shouldDelegate: params.shouldDelegate,
      utilityScore: params.utilityScore,
    }
  }

  /**
   * Record the outcome of a completed trajectory and update arm statistics.
   *
   * Reward = quality_proxy − token_cost_penalty − error_penalty − latency_penalty
   * Each penalty is clamped individually; total reward is clamped to [0, 1].
   */
  recordOutcome(
    record: DelegationTrajectoryRecord,
    rawOutcome: Omit<NonNullable<DelegationTrajectoryRecord["outcome"]>, "reward">,
  ): void {
    const tokenCostPenalty = Math.min(0.25, (rawOutcome.tokenCount / 100_000) * 0.1)
    const errorPenalty = Math.min(0.25, rawOutcome.errorCount * 0.08)
    const latencyPenalty = Math.min(0.15, (rawOutcome.durationMs / 120_000) * 0.1)
    const verifierBonus = rawOutcome.verifierPassed ? 0.05 : -0.05
    const reward = Math.min(
      1,
      Math.max(0, rawOutcome.qualityProxy - tokenCostPenalty - errorPenalty - latencyPenalty + verifierBonus),
    )

    const completed: DelegationTrajectoryRecord = { ...record, outcome: { ...rawOutcome, reward } }
    this.trajectories.push(completed)

    const arm = this.arms.get(record.armId)
    if (!arm) return

    // Welford online mean update
    arm.sampleCount++
    arm.meanReward += (reward - arm.meanReward) / arm.sampleCount
    this.totalPulls++
  }

  /** Read-only snapshot of arm statistics (for trace/diagnostic). */
  getSummary(): { totalPulls: number; arms: Array<{ id: BanditArmId; meanReward: number; sampleCount: number; thresholdDelta: number }> } {
    return {
      totalPulls: this.totalPulls,
      arms: [...this.arms.values()].map(a => ({
        id: a.id,
        meanReward: Number(a.meanReward.toFixed(4)),
        sampleCount: a.sampleCount,
        thresholdDelta: a.thresholdDelta,
      })),
    }
  }

  /** All completed trajectory records (includes outcomes). */
  getTrajectories(): readonly DelegationTrajectoryRecord[] {
    return this.trajectories
  }
}

// ============================================================================
// Module-level default instance
// ============================================================================

let _globalTuner: DelegationBanditTuner | null = null

/** Get (or lazily create) the global delegation bandit tuner. */
export function getGlobalDelegationBanditTuner(): DelegationBanditTuner {
  if (!_globalTuner) _globalTuner = new DelegationBanditTuner()
  return _globalTuner
}

/** Override the global tuner (useful for testing or custom configurations). */
export function setGlobalDelegationBanditTuner(tuner: DelegationBanditTuner | null): void {
  _globalTuner = tuner
}
