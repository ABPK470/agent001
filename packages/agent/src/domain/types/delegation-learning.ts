import type { BanditArmId } from "../enums/delegation.js"

export interface DelegationTrajectoryRecord {
  readonly timestamp: number
  readonly armId: BanditArmId
  readonly appliedThreshold: number
  readonly complexityScore: number
  readonly fanoutCount: number
  readonly stepCount: number
  readonly nestingDepth: number
  readonly parallelFraction: number
  readonly shouldDelegate: boolean
  readonly utilityScore: number
  outcome?: {
    readonly durationMs: number
    readonly tokenCount: number
    readonly errorCount: number
    readonly qualityProxy: number
    readonly verifierPassed: boolean
    readonly reward: number
  }
}

/** Bandit tuner surface used by planner setup (implementation lives in runtime). */
export interface DelegationBanditTunerPort {
  selectArm(): BanditArmId
  getThresholdAdjustment(armId: BanditArmId): number
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
  }): DelegationTrajectoryRecord
  recordOutcome(
    record: DelegationTrajectoryRecord,
    rawOutcome: Omit<NonNullable<DelegationTrajectoryRecord["outcome"]>, "reward">
  ): void
}
