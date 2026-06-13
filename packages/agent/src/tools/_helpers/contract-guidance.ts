/**
 * Tool contract guidance — priority-sorted resolver chain for per-turn tool constraints.
 *   1. Build a `ToolContractContext` from the current loop state.
 *   2. Call `resolveToolContractGuidance(ctx)` — first matching resolver wins.
 *   3. `applyToolContractGuidance` filters the tool list and yields an instruction.
 *
 * Our LLM client has no `toolChoice` — hard constraints are enforced by hiding
 * non-routed tools; soft constraints inject a system hint the model may ignore
 * (completion guards catch finish attempts separately).
 *
 * @module
 */

import { isDirectDialogueGoal } from "../../application/core/goal-intent.js"
import type { Message } from "../../domain/agent-types.js"

// ============================================================================
// Types
// ============================================================================

export type ToolContractEnforcement =
  /** Only routed tools are shown to the LLM this turn (hard constraint). */
  | "block_other_tools"
  /** All tools available; inject a runtime instruction. */
  | "suggestion"

export interface ToolContractGuidance {
  readonly priority: number
  /** Human-readable resolver name for trace/debug. */
  readonly resolverName: string
  readonly routedToolNames: readonly string[]
  readonly enforcement: ToolContractEnforcement
  /** Injected as a transient system message before the LLM call. */
  readonly runtimeInstruction?: string
}

/**
 * Snapshot of agent loop state for resolvers. Read-only — resolvers must not mutate.
 */
export interface ToolContractContext {
  readonly iteration: number
  readonly availableToolNames: readonly string[]
  /** The previous tool round included delegate / delegate_parallel. */
  readonly lastRoundHadDelegation: boolean
  /**
   * Previous delegation restricted the child to read-only tools — no file/build
   * verification pass is needed (the child only produced text).
   */
  readonly lastDelegationWasReadOnly: boolean
  /**
   * Completion guard opened a verification window (model tried to finish right
   * after a mutating delegation without adequate checks).
   */
  readonly inPostDelegationVerification: boolean
  /** Paths that must be read before any mutation is allowed. */
  readonly artifactsRequiringReadBeforeMutation: ReadonlySet<string>
  /** Source files written but not yet re-read into context. */
  readonly writtenButNotReread: ReadonlySet<string>
  /** Original user goal for this run — used to skip tool nudges on dialogue turns. */
  readonly userGoal?: string
  /** Run messages — for context-aware dialogue vs assent classification. */
  readonly messages?: readonly Message[]
}

// ============================================================================
// Resolver plumbing
// ============================================================================

type Resolver = (ctx: ToolContractContext) => ToolContractGuidance | null

interface ResolverEntry {
  readonly priority: number
  readonly name: string
  readonly fn: Resolver
}

const VERIFICATION_TOOL_NAMES = [
  "read_file",
  "run_command",
  "browser_check",
  "list_directory"
] as const

function verificationToolsAvailable(available: readonly string[]): string[] {
  const allowed = new Set<string>(VERIFICATION_TOOL_NAMES)
  return available.filter((name) => allowed.has(name))
}

function buildDelegationVerificationGuidance(
  ctx: ToolContractContext,
  verifyTools: readonly string[]
): ToolContractGuidance {
  const continuing = ctx.inPostDelegationVerification && !ctx.lastRoundHadDelegation
  return {
    priority: 300,
    resolverName: "delegation-verification",
    routedToolNames: verifyTools,
    enforcement: "block_other_tools",
    runtimeInstruction: continuing
      ? "VERIFICATION STILL REQUIRED: You attempted to finish without adequately verifying the delegation result. " +
        "Use read_file on the main code files, run_command for build/test, or browser_check — not just surface checks. " +
        "Do NOT provide a final answer until you have independently verified the output."
      : "The subagent just completed work on your behalf. " +
        "Before taking any further action, verify the output: read the target files, " +
        "run build/test commands, or check the browser. Do NOT start new tasks yet."
  }
}

/**
 * Priority 300 — Delegation verification.
 *
 * After a mutating delegation, or while the post-delegation verification window
 * is open, restrict the next turn(s) to verification tools.
 */
const delegationVerificationResolver: ResolverEntry = {
  priority: 300,
  name: "delegation-verification",
  fn(ctx) {
    if (!ctx.lastRoundHadDelegation && !ctx.inPostDelegationVerification) return null
    if (ctx.lastDelegationWasReadOnly) return null

    const verifyTools = verificationToolsAvailable(ctx.availableToolNames)
    if (verifyTools.length === 0) return null

    return buildDelegationVerificationGuidance(ctx, verifyTools)
  }
}

/**
 * Priority 270 — Read before mutation.
 *
 * After replace_in_file miss or tool outcome requiring inspection, block mutations
 * until read_file refreshes the artifact in context.
 */
const readBeforeMutationResolver: ResolverEntry = {
  priority: 270,
  name: "read-before-mutation",
  fn(ctx) {
    if (ctx.artifactsRequiringReadBeforeMutation.size === 0) return null
    if (!ctx.availableToolNames.includes("read_file")) return null

    const paths = [...ctx.artifactsRequiringReadBeforeMutation].slice(0, 3).join(", ")
    return {
      priority: 270,
      resolverName: "read-before-mutation",
      routedToolNames: ["read_file"],
      enforcement: "block_other_tools",
      runtimeInstruction:
        `REQUIRED: Read the current content of ${paths} before attempting any mutation. ` +
        "The previous write/replace failed because the content has changed. " +
        "Read first, then plan a repair based on the actual current state."
    }
  }
}

/**
 * Priority 240 — Unverified writes need read-back.
 *
 * Soft nudge when source files were written but not re-read (hard block is handled
 * by completion guards when the model tries to finish).
 */
const verifyWrittenFilesResolver: ResolverEntry = {
  priority: 240,
  name: "verify-written-files",
  fn(ctx) {
    if (ctx.writtenButNotReread.size === 0) return null
    if (!ctx.availableToolNames.includes("read_file")) return null
    if (ctx.iteration < 1) return null

    const paths = [...ctx.writtenButNotReread].slice(0, 2).join(", ")
    return {
      priority: 240,
      resolverName: "verify-written-files",
      routedToolNames: ["read_file", "run_command"],
      enforcement: "suggestion",
      runtimeInstruction:
        `Consider verifying the recently written file(s): ${paths}. ` +
        "A quick read_file or run of tests confirms the write landed correctly."
    }
  }
}

/**
 * Priority 200 — Encourage tool use on iteration 0 for task goals only.
 *
 * Conversational goals (greetings, meta questions) are excluded — those should
 * get a natural text reply without performative tool calls.
 */
const encourageFirstTurnToolsResolver: ResolverEntry = {
  priority: 200,
  name: "encourage-first-turn-tools",
  fn(ctx) {
    if (ctx.iteration !== 0) return null
    if (ctx.availableToolNames.length === 0) return null
    if (ctx.userGoal && isDirectDialogueGoal(ctx.userGoal, { messages: ctx.messages })) return null
    return {
      priority: 200,
      resolverName: "encourage-first-turn-tools",
      routedToolNames: ctx.availableToolNames,
      enforcement: "suggestion",
      runtimeInstruction:
        "This goal requires action in the environment. " +
        "Start by using tools to gather information or make progress — " +
        "do not respond with text only on the first turn."
    }
  }
}

const RESOLVERS: readonly ResolverEntry[] = [
  delegationVerificationResolver,
  readBeforeMutationResolver,
  verifyWrittenFilesResolver,
  encourageFirstTurnToolsResolver
].sort((a, b) => b.priority - a.priority)

/** First matching resolver wins (sorted by priority, highest first). */
export function resolveToolContractGuidance(ctx: ToolContractContext): ToolContractGuidance | null {
  for (const resolver of RESOLVERS) {
    const guidance = resolver.fn(ctx)
    if (guidance !== null) return guidance
  }
  return null
}

// ============================================================================
// Application
// ============================================================================

export interface AppliedToolContractGuidance {
  readonly filteredToolNames: readonly string[]
  readonly injectedInstruction: string | null
  readonly guidance: ToolContractGuidance
}

/** Apply guidance to the available tool name list for one LLM call. */
export function applyToolContractGuidance(
  guidance: ToolContractGuidance,
  availableToolNames: readonly string[]
): AppliedToolContractGuidance {
  let filteredToolNames: readonly string[]

  if (guidance.enforcement === "block_other_tools") {
    const routed = new Set(guidance.routedToolNames)
    filteredToolNames = availableToolNames.filter((n) => routed.has(n))
    if (filteredToolNames.length === 0) filteredToolNames = availableToolNames
  } else {
    filteredToolNames = availableToolNames
  }

  return {
    filteredToolNames,
    injectedInstruction: guidance.runtimeInstruction ?? null,
    guidance
  }
}
