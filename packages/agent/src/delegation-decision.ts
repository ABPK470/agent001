/**
 * Delegation decision — safety gate, hard-block detection, economics assessment.
 *
 * Ported from agenc-core delegation-decision.ts, adapted for agent001's
 * type system and tool names.
 *
 * Controls whether a set of subagent steps should be delegated or kept inline.
 * 21 decision reason codes cover safety, economics, coupling, and structural limits.
 *
 * @module
 */

// ============================================================================
// Decision reason codes (21 outcomes)
// ============================================================================

export type DelegationDecisionReason =
  | "delegation_disabled"
  | "no_subagent_steps"
  | "hard_blocked_task_class"
  | "trivial_request"
  | "single_hop_request"
  | "shared_context_review"
  | "shared_artifact_writer_inline"
  | "fanout_exceeded"
  | "depth_exceeded"
  | "handoff_confidence_below_threshold"
  | "safety_risk_high"
  | "score_below_threshold"
  | "missing_execution_envelope"
  | "parallel_gain_insufficient"
  | "dependency_coupling_high"
  | "tool_overlap_high"
  | "verifier_cost_high"
  | "retry_cost_high"
  | "negative_economics"
  | "no_safe_delegation_shape"
  | "approved"

// ============================================================================
// Hard-blocked task classes (wallet, crypto, destructive, credential)
// ============================================================================

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration"

export type DelegationHardBlockedMatchSource = "capability" | "text"

// ============================================================================
// Configuration
// ============================================================================

export interface DelegationDecisionConfig {
  readonly enabled?: boolean
  readonly scoreThreshold?: number
  readonly maxFanoutPerTurn?: number
  readonly maxDepth?: number
  readonly hardBlockedTaskClasses?: readonly DelegationHardBlockedTaskClass[]
}

export interface ResolvedDelegationDecisionConfig {
  readonly enabled: boolean
  readonly scoreThreshold: number
  readonly maxFanoutPerTurn: number
  readonly maxDepth: number
  readonly hardBlockedTaskClasses: ReadonlySet<DelegationHardBlockedTaskClass>
}

// ============================================================================
// Step profile (what a subagent step looks like for decision purposes)
// ============================================================================

export interface DelegationSubagentStepProfile {
  readonly name: string
  readonly objective?: string
  readonly dependsOn?: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly requiredToolCapabilities: readonly string[]
  readonly canRunParallel: boolean
  readonly effectClass?: "read_only" | "write" | "mixed"
}

// ============================================================================
// Decision input & output
// ============================================================================

export interface DelegationDecisionInput {
  readonly messageText: string
  readonly explicitDelegationRequested?: boolean
  readonly plannerConfidence?: number
  readonly complexityScore: number
  readonly totalSteps: number
  readonly synthesisSteps: number
  readonly subagentSteps: readonly DelegationSubagentStepProfile[]
  readonly config?: DelegationDecisionConfig
  readonly currentDepth?: number
}

export interface DelegationDecision {
  readonly shouldDelegate: boolean
  readonly reason: DelegationDecisionReason
  readonly threshold: number
  readonly utilityScore: number
  readonly decompositionBenefit: number
  readonly coordinationOverhead: number
  readonly latencyCostRisk: number
  readonly safetyRisk: number
  readonly confidence: number
  readonly hardBlockedTaskClass: DelegationHardBlockedTaskClass | null
  readonly hardBlockedTaskClassSource: DelegationHardBlockedMatchSource | null
  readonly hardBlockedTaskClassSignal: string | null
  readonly diagnostics: Readonly<Record<string, number | boolean | string>>
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_SCORE_THRESHOLD = 0.2
const DEFAULT_MAX_FANOUT_PER_TURN = 8
const DEFAULT_MAX_DEPTH = 4
const SAFETY_RISK_HARD_BLOCK_THRESHOLD = 0.9

const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
]

// ============================================================================
// Risk patterns
// ============================================================================

const HIGH_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^(?:wallet|solana|crypto)\./i,
  /^(?:system\.)?(?:delete|execute|open)$/i,
]

const MODERATE_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^(?:run_command|write_file)$/i,
  /^(?:browse_web|fetch_url)$/i,
]

// Hard-block text patterns for each task class
const WALLET_SIGNING_TEXT_RE =
  /\b(sign|authorize|approve)\b[\s\S]{0,48}\b(wallet|transaction|tx)\b/i
const WALLET_TRANSFER_TEXT_RE =
  /\b(transfer|send|withdraw|pay)\b[\s\S]{0,48}\b(sol|token|fund|wallet|usdc|usdt)\b/i
const STAKE_OR_REWARDS_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(stake|unstake|undelegate)\b[\s\S]{0,48}\b(sol|token|tokens|validator|stake|staking|reward|rewards|yield|wallet)\b/i,
  /\b(delegate)\b[\s\S]{0,48}\b(stake|staking|validator|vote\s+account|sol|token|tokens)\b/i,
  /\b(claim|reward|rewards)\b[\s\S]{0,48}\b(stake|staking|validator|sol|token|tokens|wallet|yield)\b/i,
]

// Credential exfiltration detection
const CREDENTIAL_MARKER_PATTERNS: readonly RegExp[] = [
  /\bsecret(?:s)?\b/i,
  /\bapi(?:[_-]?key|\s+key)\b/i,
  /\b(?:access|auth|bearer|refresh|session)\s+token\b/i,
  /\bpassword(?:s)?\b/i,
  /\bprivate[_\s-]?key\b/i,
  /\bseed\s+phrase\b/i,
  /\bmnemonic\b/i,
  /\bssh\s+key\b/i,
  /\bcredentials?\b/i,
  /\b\.env\b/i,
]

const CREDENTIAL_EXFIL_INTENT_PATTERNS: readonly RegExp[] = [
  /\b(?:exfiltrat(?:e|ion)|leak|steal|dump|export|extract|copy|print|echo|reveal|expose|show|send|upload|post|curl|transmit|forward)\b[\s\S]{0,72}\b(?:secret|api(?:[_-]?key|\s+key)|token|password|private[_\s-]?key|seed\s+phrase|mnemonic|credentials?|\.env)\b/i,
  /\b(?:secret|api(?:[_-]?key|\s+key)|token|password|private[_\s-]?key|seed\s+phrase|mnemonic|credentials?|\.env)\b[\s\S]{0,72}\b(?:exfiltrat(?:e|ion)|leak|steal|dump|export|extract|copy|print|echo|reveal|expose|show|send|upload|post|curl|transmit|forward)\b/i,
]

const NETWORK_EGRESS_CAPABILITY_RE = /^(?:run_command|browse_web|fetch_url)$/i

// ============================================================================
// Config resolution
// ============================================================================

export function resolveDelegationDecisionConfig(
  config?: DelegationDecisionConfig,
): ResolvedDelegationDecisionConfig {
  const hardBlockedTaskClasses = new Set<DelegationHardBlockedTaskClass>()
  const configured = config?.hardBlockedTaskClasses
  if (Array.isArray(configured)) {
    for (const tc of configured) {
      if (isValidHardBlockedClass(tc)) hardBlockedTaskClasses.add(tc)
    }
  } else {
    for (const tc of DEFAULT_HARD_BLOCKED_TASK_CLASSES) {
      hardBlockedTaskClasses.add(tc)
    }
  }
  return {
    enabled: config?.enabled ?? true,
    scoreThreshold: clamp01(config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD),
    maxFanoutPerTurn: Math.max(1, Math.floor(config?.maxFanoutPerTurn ?? DEFAULT_MAX_FANOUT_PER_TURN)),
    maxDepth: Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    hardBlockedTaskClasses,
  }
}

// ============================================================================
// Main decision function
// ============================================================================

/**
 * Assess whether a delegation should proceed based on safety, economics,
 * structural limits, and hard-block checks.
 */
export function assessDelegationDecision(
  input: DelegationDecisionInput,
): DelegationDecision {
  const resolvedConfig = resolveDelegationDecisionConfig(input.config)
  const hardBlockedMatch = detectHardBlockedTaskClass(input, resolvedConfig)
  const safetyRisk = computeSafetyRisk(input.subagentSteps)
  const plannerConfidence = clamp01(input.plannerConfidence ?? 0)

  // Gate 1: delegation disabled
  if (!resolvedConfig.enabled) {
    return buildDecision({
      shouldDelegate: false,
      reason: "delegation_disabled",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 2: no subagent steps
  if (input.subagentSteps.length === 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "no_subagent_steps",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 3: hard-blocked task class
  if (hardBlockedMatch) {
    return buildDecision({
      shouldDelegate: false,
      reason: "hard_blocked_task_class",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 4: safety risk above hard-block threshold
  if (safetyRisk >= SAFETY_RISK_HARD_BLOCK_THRESHOLD) {
    return buildDecision({
      shouldDelegate: false,
      reason: "safety_risk_high",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 5: fanout exceeded
  if (input.subagentSteps.length > resolvedConfig.maxFanoutPerTurn) {
    return buildDecision({
      shouldDelegate: false,
      reason: "fanout_exceeded",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 6: depth exceeded
  if ((input.currentDepth ?? 0) >= resolvedConfig.maxDepth) {
    return buildDecision({
      shouldDelegate: false,
      reason: "depth_exceeded",
      resolvedConfig,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Economics assessment
  const { utilityScore, decompositionBenefit, coordinationOverhead, latencyCostRisk } =
    computeEconomics(input)

  // Gate 7: score below threshold
  if (utilityScore < resolvedConfig.scoreThreshold) {
    return buildDecision({
      shouldDelegate: false,
      reason: "score_below_threshold",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 8: dependency coupling too high
  if (coordinationOverhead > 0.7) {
    return buildDecision({
      shouldDelegate: false,
      reason: "dependency_coupling_high",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // Gate 9: negative economics (cost exceeds benefit)
  if (utilityScore < 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "negative_economics",
      resolvedConfig,
      utilityScore,
      decompositionBenefit,
      coordinationOverhead,
      latencyCostRisk,
      safetyRisk,
      confidence: plannerConfidence,
      hardBlockedMatch,
    })
  }

  // APPROVED
  const confidence = clamp01(
    0.25 +
      plannerConfidence * 0.35 +
      (input.subagentSteps.length > 1 ? 0.2 : 0.1) +
      (1 - safetyRisk) * 0.2,
  )

  return buildDecision({
    shouldDelegate: true,
    reason: "approved",
    resolvedConfig,
    utilityScore,
    decompositionBenefit,
    coordinationOverhead,
    latencyCostRisk,
    safetyRisk,
    confidence,
    hardBlockedMatch,
  })
}

// ============================================================================
// Economics
// ============================================================================

function computeEconomics(input: DelegationDecisionInput): {
  utilityScore: number
  decompositionBenefit: number
  coordinationOverhead: number
  latencyCostRisk: number
} {
  const parallelSteps = input.subagentSteps.filter(s => s.canRunParallel).length
  const totalSteps = Math.max(1, input.subagentSteps.length)

  // Decomposition benefit: higher when more steps can run in parallel
  const parallelFraction = parallelSteps / totalSteps
  const decompositionBenefit = clamp01(
    0.3 * parallelFraction +
      0.3 * Math.min(1, input.complexityScore / 8) +
      0.2 * (input.subagentSteps.length >= 3 ? 1 : 0.5) +
      0.2 * (input.explicitDelegationRequested ? 1 : 0),
  )

  // Coordination overhead: higher when steps are interdependent
  const dependentSteps = input.subagentSteps.filter(s => s.dependsOn && s.dependsOn.length > 0).length
  const dependencyFraction = dependentSteps / totalSteps
  const coordinationOverhead = clamp01(
    0.3 * dependencyFraction +
      0.2 * (1 - parallelFraction) +
      0.1 * (input.synthesisSteps / Math.max(1, input.totalSteps)),
  )

  // Latency-cost risk: retry/verification overhead
  const verifierCost = clamp01(0.1 * totalSteps)
  const retryCost = clamp01(0.08 * totalSteps)
  const latencyCostRisk = clamp01(verifierCost * 0.45 + retryCost * 0.45 + 0.1)

  // Utility: benefit minus overhead
  const utilityScore = decompositionBenefit - coordinationOverhead * 0.4 - latencyCostRisk * 0.2

  return { utilityScore, decompositionBenefit, coordinationOverhead, latencyCostRisk }
}

// ============================================================================
// Safety risk
// ============================================================================

function computeSafetyRisk(steps: readonly DelegationSubagentStepProfile[]): number {
  let highRiskCount = 0
  let moderateRiskCount = 0
  let parallelMutableSteps = 0

  for (const step of steps) {
    if (step.canRunParallel && step.effectClass && step.effectClass !== "read_only") {
      parallelMutableSteps++
    }
    for (const cap of step.requiredToolCapabilities) {
      const normalized = cap.trim().toLowerCase()
      if (HIGH_RISK_CAPABILITY_PATTERNS.some(p => p.test(normalized))) {
        highRiskCount++
        continue
      }
      if (MODERATE_RISK_CAPABILITY_PATTERNS.some(p => p.test(normalized))) {
        moderateRiskCount++
      }
    }
  }

  const parallelExposure = clamp01(steps.length > 0 ? parallelMutableSteps / steps.length : 0)
  return clamp01(
    0.05 +
      highRiskCount * 0.22 +
      moderateRiskCount * 0.08 +
      parallelExposure * 0.18,
  )
}

// ============================================================================
// Hard-block detection
// ============================================================================

interface HardBlockedTaskClassMatch {
  readonly taskClass: DelegationHardBlockedTaskClass
  readonly source: DelegationHardBlockedMatchSource
  readonly signal: string
}

function detectHardBlockedTaskClass(
  input: DelegationDecisionInput,
  config: ResolvedDelegationDecisionConfig,
): HardBlockedTaskClassMatch | null {
  if (config.hardBlockedTaskClasses.size === 0) return null

  const capabilities = input.subagentSteps.flatMap(s =>
    s.requiredToolCapabilities.map(c => c.trim()),
  )
  const textBlob = [
    input.messageText,
    ...input.subagentSteps.map(s => s.name),
    ...input.subagentSteps.map(s => s.objective ?? ""),
    ...input.subagentSteps.flatMap(s => s.acceptanceCriteria),
  ].join("\n")

  // Wallet signing
  if (config.hardBlockedTaskClasses.has("wallet_signing")) {
    const textMatch = findTextMatch(textBlob, [WALLET_SIGNING_TEXT_RE])
    if (textMatch) return { taskClass: "wallet_signing", source: "text", signal: summarizeSignal(textMatch) }
  }

  // Wallet transfer
  if (config.hardBlockedTaskClasses.has("wallet_transfer")) {
    const textMatch = findTextMatch(textBlob, [WALLET_TRANSFER_TEXT_RE])
    if (textMatch) return { taskClass: "wallet_transfer", source: "text", signal: summarizeSignal(textMatch) }
  }

  // Stake/rewards
  if (config.hardBlockedTaskClasses.has("stake_or_rewards")) {
    const textMatch = findTextMatch(textBlob, STAKE_OR_REWARDS_TEXT_PATTERNS)
    if (textMatch) return { taskClass: "stake_or_rewards", source: "text", signal: summarizeSignal(textMatch) }
  }

  // Destructive host mutation (capabilities-only check)
  if (config.hardBlockedTaskClasses.has("destructive_host_mutation")) {
    const capMatch = findCapabilityMatch(capabilities, /^(?:delete|execute|rm)$/i)
    if (capMatch) return { taskClass: "destructive_host_mutation", source: "capability", signal: capMatch }
  }

  // Credential exfiltration (requires all three: credential marker + exfil intent + network egress)
  if (config.hardBlockedTaskClasses.has("credential_exfiltration")) {
    const credentialMatch = findTextMatch(textBlob, CREDENTIAL_MARKER_PATTERNS)
    const exfilMatch = findTextMatch(textBlob, CREDENTIAL_EXFIL_INTENT_PATTERNS)
    const networkCapMatch = findCapabilityMatch(capabilities, NETWORK_EGRESS_CAPABILITY_RE)
    if (credentialMatch && exfilMatch && networkCapMatch) {
      return { taskClass: "credential_exfiltration", source: "capability", signal: summarizeSignal(networkCapMatch) }
    }
  }

  return null
}

// ============================================================================
// Decision builder
// ============================================================================

function buildDecision(input: {
  readonly shouldDelegate: boolean
  readonly reason: DelegationDecisionReason
  readonly resolvedConfig: ResolvedDelegationDecisionConfig
  readonly utilityScore?: number
  readonly decompositionBenefit?: number
  readonly coordinationOverhead?: number
  readonly latencyCostRisk?: number
  readonly safetyRisk: number
  readonly confidence: number
  readonly hardBlockedMatch: HardBlockedTaskClassMatch | null
}): DelegationDecision {
  return {
    shouldDelegate: input.shouldDelegate,
    reason: input.reason,
    threshold: input.resolvedConfig.scoreThreshold,
    utilityScore: input.utilityScore ?? 0,
    decompositionBenefit: input.decompositionBenefit ?? 0,
    coordinationOverhead: input.coordinationOverhead ?? 0,
    latencyCostRisk: input.latencyCostRisk ?? 0,
    safetyRisk: input.safetyRisk,
    confidence: input.confidence,
    hardBlockedTaskClass: input.hardBlockedMatch?.taskClass ?? null,
    hardBlockedTaskClassSource: input.hardBlockedMatch?.source ?? null,
    hardBlockedTaskClassSignal: input.hardBlockedMatch?.signal ?? null,
    diagnostics: {
      threshold: input.resolvedConfig.scoreThreshold,
      enabled: input.resolvedConfig.enabled,
      maxFanoutPerTurn: input.resolvedConfig.maxFanoutPerTurn,
      maxDepth: input.resolvedConfig.maxDepth,
      hasHardBlockedTaskClass: input.hardBlockedMatch !== null,
    },
  }
}

// ============================================================================
// Helpers
// ============================================================================

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function isValidHardBlockedClass(value: string): value is DelegationHardBlockedTaskClass {
  return value === "wallet_signing" || value === "wallet_transfer" ||
    value === "stake_or_rewards" || value === "destructive_host_mutation" ||
    value === "credential_exfiltration"
}

function findCapabilityMatch(capabilities: readonly string[], pattern: RegExp): string | null {
  for (const cap of capabilities) {
    if (pattern.test(cap)) return cap
  }
  return null
}

function findTextMatch(textBlob: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = textBlob.match(pattern)
    if (match?.[0]) return match[0]
  }
  return null
}

function summarizeSignal(signal: string): string {
  const normalized = signal.replace(/\s+/g, " ").trim()
  return normalized.length <= 96 ? normalized : `${normalized.slice(0, 93)}...`
}
