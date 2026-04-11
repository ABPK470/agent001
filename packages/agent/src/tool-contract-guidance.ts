/**
 * Tool contract guidance — priority-sorted resolver chain for per-turn tool constraints.
 *
 * Ported from agenc-core's tool-contract-guidance pattern.
 *
 * Each resolver inspects the current loop context and, if applicable, returns
 * guidance describing:
 *   - Which tools are "routed" (preferred / required) this turn
 *   - How to enforce the routing: filter tool list or inject a runtime instruction
 *   - How long the guidance is active (one_shot / sticky / countdown)
 *
 * In agent.ts, before each LLM call:
 *   1. Build a ToolContractContext from the current loop state.
 *   2. Call resolveToolContractGuidance(ctx) for the highest-priority matching guidance.
 *   3. If enforcement === "block_other_tools": filter the tools list to routedToolNames only.
 *   4. If runtimeInstruction is set: inject it as a transient system message.
 *
 * NOTE: Our LLM client does not expose toolChoice — we achieve similar effect by filtering
 * the available tools list and adding a clear instruction.
 *
 * @module
 */

// ============================================================================
// Types
// ============================================================================

export type ToolContractEnforcement =
  /** Only routed tools are shown to the LLM this turn (hard constraint). */
  | "block_other_tools"
  /** All tools available but inject a strong runtime instruction. */
  | "suggestion"

export type ToolContractLifetime =
  | "one_shot"   // Active for 1 LLM call, then removed
  | "sticky"     // Active until explicitly cleared (or max iterations)
  | "countdown"  // Active for remainingFires calls

export interface ToolContractGuidance {
  /** Higher number = higher priority. Resolvers are sorted descending. */
  readonly priority: number
  /** Human-readable resolver name for trace/debug. */
  readonly resolverName: string
  /** Tool names that are "routed" for this turn. */
  readonly routedToolNames: readonly string[]
  readonly enforcement: ToolContractEnforcement
  /** Optional instruction injected as a system message before the LLM call. */
  readonly runtimeInstruction?: string
  readonly lifetime: ToolContractLifetime
  readonly remainingFires?: number
}

/**
 * Snapshot of the agent loop state passed to each resolver.
 * All fields are read-only — resolvers must not mutate state.
 */
export interface ToolContractContext {
  /** Current loop iteration (0-based). */
  readonly iteration: number
  /** Names of all tools currently available. */
  readonly availableToolNames: readonly string[]
  /** The last round included a delegate / delegate_parallel call. */
  readonly lastRoundHadDelegation: boolean
  /** Currently in the post-delegation verification window. */
  readonly inPostDelegationVerification: boolean
  /** Paths that must be read before a mutation is allowed. */
  readonly artifactsRequiringReadBeforeMutation: ReadonlySet<string>
  /** There are unverified file writes in the current session. */
  readonly wroteUnverifiedFiles: boolean
  /** Files written but not yet re-read (pending in-place verification). */
  readonly writtenButNotReread: ReadonlySet<string>
  /** Tool calls made in the last LLM round (empty on first call). */
  readonly lastRoundToolCalls: readonly { readonly name: string; readonly isError: boolean }[]
  /**
   * Per-key circuit breaker check — used by some resolvers to avoid routing
   * to a tool that is known to be blocked.
   */
  readonly isKeyBlocked?: (key: string) => boolean
}

// ============================================================================
// Internal resolver signature
// ============================================================================

type Resolver = (ctx: ToolContractContext) => ToolContractGuidance | null

interface ResolverEntry {
  readonly priority: number
  readonly name: string
  readonly fn: Resolver
}

// ============================================================================
// Resolvers (highest priority first when sorted)
// ============================================================================

/**
 * Priority 300 — Delegation verification.
 *
 * Immediately after a delegation call, route the next LLM turn to verification
 * tools (read_file, run_command) to confirm the subagent's output rather than
 * launching a new task blind.
 */
const delegationVerificationResolver: ResolverEntry = {
  priority: 300,
  name: "delegation-verification",
  fn(ctx) {
    if (!ctx.lastRoundHadDelegation && !ctx.inPostDelegationVerification) return null
    if (ctx.lastRoundHadDelegation) {
      const verifyTools = ctx.availableToolNames.filter(
        t => t === "read_file" || t === "run_command" || t === "browser_check" || t === "list_directory",
      )
      if (verifyTools.length === 0) return null
      return {
        priority: 300,
        resolverName: "delegation-verification",
        routedToolNames: verifyTools,
        enforcement: "block_other_tools",
        runtimeInstruction:
          "The subagent just completed work on your behalf. " +
          "Before taking any further action, verify the output: read the target files, " +
          "run build/test commands, or check the browser. Do NOT start new tasks yet.",
        lifetime: "one_shot",
      }
    }
    return null
  },
}

/**
 * Priority 270 — Read before mutation.
 *
 * When specific artifact paths require a read before mutation (e.g. after an
 * old_string miss), block all mutation tools and route to read_file.
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
        "Read first, then plan a repair based on the actual current state.",
      lifetime: "one_shot",
    }
  },
}

/**
 * Priority 240 — Unverified writes need read-back.
 *
 * When files have been written but not yet re-read into context, suggest
 * a read_file pass to catch silent write errors or truncations.
 */
const verifyWrittenFilesResolver: ResolverEntry = {
  priority: 240,
  name: "verify-written-files",
  fn(ctx) {
    if (ctx.writtenButNotReread.size === 0) return null
    if (!ctx.availableToolNames.includes("read_file")) return null
    // Only apply this after at least 1 iteration so we don't disrupt the initial write
    if (ctx.iteration < 1) return null

    const paths = [...ctx.writtenButNotReread].slice(0, 2).join(", ")
    return {
      priority: 240,
      resolverName: "verify-written-files",
      routedToolNames: ["read_file", "run_command"],
      enforcement: "suggestion",
      runtimeInstruction:
        `Consider verifying the recently written file(s): ${paths}. ` +
        "A quick read_file or run of tests confirms the write landed correctly.",
      lifetime: "one_shot",
    }
  },
}

/**
 * Priority 200 — No premature text response at iteration 0.
 *
 * On the very first iteration, if tools are available, steer the model toward
 * using a tool rather than responding immediately with text.
 */
const noPrematureTextResponseResolver: ResolverEntry = {
  priority: 200,
  name: "no-premature-text-response",
  fn(ctx) {
    if (ctx.iteration !== 0) return null
    if (ctx.availableToolNames.length === 0) return null
    return {
      priority: 200,
      resolverName: "no-premature-text-response",
      routedToolNames: ctx.availableToolNames,
      enforcement: "suggestion",
      runtimeInstruction:
        "Start by using tools to gather information or take action — " +
        "do not respond with text only on the first turn.",
      lifetime: "one_shot",
    }
  },
}

// ============================================================================
// Resolver chain
// ============================================================================

const RESOLVERS: readonly ResolverEntry[] = [
  delegationVerificationResolver,
  readBeforeMutationResolver,
  verifyWrittenFilesResolver,
  noPrematureTextResponseResolver,
].sort((a, b) => b.priority - a.priority)

/**
 * Run the resolver chain and return the first matching guidance (highest priority).
 * Returns null if no resolver applies.
 */
export function resolveToolContractGuidance(ctx: ToolContractContext): ToolContractGuidance | null {
  for (const resolver of RESOLVERS) {
    const guidance = resolver.fn(ctx)
    if (guidance !== null) return guidance
  }
  return null
}

// ============================================================================
// Application helper
// ============================================================================

export interface AppliedToolContractGuidance {
  /** Filtered tool list — may be the same as input if enforcement is "suggestion". */
  readonly filteredToolNames: readonly string[]
  /** Instruction to inject as a system message before the LLM call, or null. */
  readonly injectedInstruction: string | null
  readonly guidance: ToolContractGuidance
}

/**
 * Apply guidance to a tool name set.
 * Callers use filteredToolNames to build the LLM's tool list for this turn.
 */
export function applyToolContractGuidance(
  guidance: ToolContractGuidance,
  availableToolNames: readonly string[],
): AppliedToolContractGuidance {
  let filteredToolNames: readonly string[]

  if (guidance.enforcement === "block_other_tools") {
    // Intersection: only tools in both routedToolNames AND available
    const routed = new Set(guidance.routedToolNames)
    filteredToolNames = availableToolNames.filter(n => routed.has(n))
    // Safety: if nothing matches, fall back to full list to avoid empty tool set
    if (filteredToolNames.length === 0) filteredToolNames = availableToolNames
  } else {
    filteredToolNames = availableToolNames
  }

  return {
    filteredToolNames,
    injectedInstruction: guidance.runtimeInstruction ?? null,
    guidance,
  }
}
