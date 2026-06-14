/**
 * Turn-start policy — hard constraints applied before each LLM call.
 *
 * Our LLM client has no `toolChoice`; non-routed tools are hidden so the
 * model cannot call them. Completion rules enforce finish-time behavior.
 */

import type { LoopPolicyContext, TurnPrep, TurnStartRule } from "./types.js"

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

function applyRule(rule: string, allowed: readonly string[], hint: string | null, ctx: LoopPolicyContext): TurnPrep {
  const routed = new Set(allowed)
  let allowedToolNames = ctx.availableToolNames.filter((name) => routed.has(name))
  if (allowedToolNames.length === 0) allowedToolNames = [...ctx.availableToolNames]
  return { rule, allowedToolNames, hint }
}

/** After mutating delegation — verify before new work. */
const delegationVerification: TurnStartRule = (ctx) => {
  if (!ctx.state.lastRoundHadDelegation && !ctx.state.inPostDelegationVerification) return null
  if (ctx.state.lastDelegationWasReadOnly) return null

  const verifyTools = verificationToolsAvailable(ctx.availableToolNames)
  if (verifyTools.length === 0) return null

  const continuing = ctx.state.inPostDelegationVerification && !ctx.state.lastRoundHadDelegation
  const hint = continuing
    ? "VERIFICATION STILL REQUIRED: You attempted to finish without adequately verifying the delegation result. " +
      "Use read_file on the main code files, run_command for build/test, or browser_check — not just surface checks. " +
      "Do NOT provide a final answer until you have independently verified the output."
    : "The subagent just completed work on your behalf. " +
      "Before taking any further action, verify the output: read the target files, " +
      "run build/test commands, or check the browser. Do NOT start new tasks yet."

  return applyRule("delegation-verification", verifyTools, hint, ctx)
}

/** Replace/write miss — read current artifact before another mutation. */
const readBeforeMutation: TurnStartRule = (ctx) => {
  if (ctx.state.artifactsRequiringReadBeforeMutation.size === 0) return null
  if (!ctx.availableToolNames.includes("read_file")) return null

  const paths = [...ctx.state.artifactsRequiringReadBeforeMutation].slice(0, 3).join(", ")
  return applyRule(
    "read-before-mutation",
    ["read_file"],
    `REQUIRED: Read the current content of ${paths} before attempting any mutation. ` +
      "The previous write/replace failed because the content has changed. " +
      "Read first, then plan a repair based on the actual current state.",
    ctx
  )
}

const TURN_START_RULES: readonly TurnStartRule[] = [
  delegationVerification,
  readBeforeMutation
]

/** First matching turn-start rule wins. */
export function prepareTurn(ctx: LoopPolicyContext): TurnPrep {
  for (const rule of TURN_START_RULES) {
    const prep = rule(ctx)
    if (prep) return prep
  }
  return {
    rule: null,
    allowedToolNames: ctx.availableToolNames,
    hint: null
  }
}
