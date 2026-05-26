import { DelegationHardBlockedMatchSource } from "../../../domain/enums/delegation.js"
/**
 * Safety risk assessment and hard-block detection for delegation decisions.
 *
 * Extracted from delegation-decision.ts to keep modules under 500 LOC.
 *
 * @module
 */

import type {
    DelegationDecisionInput,
    DelegationHardBlockedTaskClass,
    DelegationSubagentStepProfile,
    ResolvedDelegationDecisionConfig,
} from "./decision/index.js"

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

const WALLET_SIGNING_TEXT_RE =
  /\b(sign|authorize|approve)\b[\s\S]{0,48}\b(wallet|transaction|tx)\b/i
const WALLET_TRANSFER_TEXT_RE =
  /\b(transfer|send|withdraw|pay)\b[\s\S]{0,48}\b(sol|token|fund|wallet|usdc|usdt)\b/i
const STAKE_OR_REWARDS_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(stake|unstake|undelegate)\b[\s\S]{0,48}\b(sol|token|tokens|validator|stake|staking|reward|rewards|yield|wallet)\b/i,
  /\b(delegate)\b[\s\S]{0,48}\b(stake|staking|validator|vote\s+account|sol|token|tokens)\b/i,
  /\b(claim|reward|rewards)\b[\s\S]{0,48}\b(stake|staking|validator|sol|token|tokens|wallet|yield)\b/i,
]

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
// Safety risk
// ============================================================================

export function computeSafetyRisk(steps: readonly DelegationSubagentStepProfile[]): number {
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

export interface HardBlockedTaskClassMatch {
  readonly taskClass: DelegationHardBlockedTaskClass
  readonly source: DelegationHardBlockedMatchSource
  readonly signal: string
}

export function detectHardBlockedTaskClass(
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

  if (config.hardBlockedTaskClasses.has("wallet_signing")) {
    const textMatch = findTextMatch(textBlob, [WALLET_SIGNING_TEXT_RE])
    if (textMatch) return { taskClass: "wallet_signing", source: DelegationHardBlockedMatchSource.Text, signal: summarizeSignal(textMatch) }
  }

  if (config.hardBlockedTaskClasses.has("wallet_transfer")) {
    const textMatch = findTextMatch(textBlob, [WALLET_TRANSFER_TEXT_RE])
    if (textMatch) return { taskClass: "wallet_transfer", source: DelegationHardBlockedMatchSource.Text, signal: summarizeSignal(textMatch) }
  }

  if (config.hardBlockedTaskClasses.has("stake_or_rewards")) {
    const textMatch = findTextMatch(textBlob, STAKE_OR_REWARDS_TEXT_PATTERNS)
    if (textMatch) return { taskClass: "stake_or_rewards", source: DelegationHardBlockedMatchSource.Text, signal: summarizeSignal(textMatch) }
  }

  if (config.hardBlockedTaskClasses.has("destructive_host_mutation")) {
    const capMatch = findCapabilityMatch(capabilities, /^(?:delete|execute|rm)$/i)
    if (capMatch) return { taskClass: "destructive_host_mutation", source: DelegationHardBlockedMatchSource.Capability, signal: capMatch }
  }

  if (config.hardBlockedTaskClasses.has("credential_exfiltration")) {
    const credentialMatch = findTextMatch(textBlob, CREDENTIAL_MARKER_PATTERNS)
    const exfilMatch = findTextMatch(textBlob, CREDENTIAL_EXFIL_INTENT_PATTERNS)
    const networkCapMatch = findCapabilityMatch(capabilities, NETWORK_EGRESS_CAPABILITY_RE)
    if (credentialMatch && exfilMatch && networkCapMatch) {
      return { taskClass: "credential_exfiltration", source: DelegationHardBlockedMatchSource.Capability, signal: summarizeSignal(networkCapMatch) }
    }
  }

  return null
}

// ============================================================================
// Helpers
// ============================================================================

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
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
