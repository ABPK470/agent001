/**
 * Policy engine — evaluates governance rules against tool steps.
 *
 * Two coexisting rule modes (back-compat by design):
 *
 *   1. Legacy "action:<tool-name>" condition.
 *      Matches when `step.action === <tool-name>`. Existing rules and
 *      tests use this exclusively.
 *
 *   2. Selector mode (condition === "selectors").
 *      Rule's `parameters.selectors` describes a conjunction over actor
 *      role, runMode, tool, path, command, network, scope, and MSSQL
 *      environment/operation. Resolution picks the highest-priority
 *      matching rule, with deny > require_approval > allow on ties.
 *      See {@link policy-selectors.ts} for the matcher.
 *
 * Hosted default-deny:
 *   When the active {@link HostedPolicyContext.runMode} is "hosted" and
 *   no rule (legacy or selector) matched the step, the engine throws a
 *   {@link PolicyViolationError}. Developer mode preserves the legacy
 *   "no match → allow" behavior so existing flows are not affected.
 */

import { PolicyEffect } from "../enums/index.js"
import { PolicyViolationError } from "../types/errors.js"
import type { PolicyEvaluator } from "../types/interfaces.js"
import type { AgentRun, PolicyRule, Step } from "../types/run-models.js"
import { stripRuntimeToolArgs } from "@mia/shared-types"

import type { HostedPolicyContext } from "./policy-context.js"
import { extractToolFacts, resolveSelectorRules } from "./policy-selectors.js"

function stableArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(stripRuntimeToolArgs(args))
}

function hasToolApprovalGrant(
  ctx: HostedPolicyContext | null | undefined,
  step: Step
): boolean {
  if (!ctx?.toolApprovalGrants?.length) return false
  const key = stableArgsKey(step.input)
  return ctx.toolApprovalGrants.some(
    (grant) => grant.toolName === step.action && stableArgsKey(grant.args) === key
  )
}

export class RulePolicyEvaluator implements PolicyEvaluator {
  private rules: PolicyRule[] = []

  addRule(rule: PolicyRule): void {
    this.rules.push(rule)
  }
  removeRule(name: string): void {
    this.rules = this.rules.filter((r) => r.name !== name)
  }
  listRules(): PolicyRule[] {
    return [...this.rules]
  }

  async evaluatePreStep(
    _run: AgentRun,
    step: Step,
    ctx: HostedPolicyContext | null = null
  ): Promise<string | null> {
    if (hasToolApprovalGrant(ctx, step)) {
      return null
    }

    // 1. Legacy action: rules — preserve original first-match semantics.
    for (const rule of this.rules) {
      if (rule.condition === "selectors") continue
      if (!matchesLegacy(rule, step)) continue
      if (rule.effect === PolicyEffect.Deny) {
        throw new PolicyViolationError(rule.name, rule.condition)
      }
      if (rule.effect === PolicyEffect.RequireApproval) {
        return `Policy '${rule.name}': ${rule.condition}`
      }
      // Allow → fall through; explicit allow does not short-circuit
      // a deny that selector rules might still raise.
    }

    // 2. Selector rules — collect matches and resolve by priority/rank.
    const facts = extractToolFacts(step, ctx ?? undefined)
    const resolution = resolveSelectorRules(this.rules, facts, ctx ?? undefined)
    if (resolution) {
      const params = resolution.rule.parameters as { reason?: string }
      const reason = params?.reason ?? `selector match: ${resolution.rule.name}`
      if (resolution.effect === PolicyEffect.Deny) {
        throw new PolicyViolationError(resolution.rule.name, reason)
      }
      if (resolution.effect === PolicyEffect.RequireApproval) {
        return `Policy '${resolution.rule.name}': ${reason}`
      }
      return null // Allow
    }

    // 3. Hosted default-deny — only when explicitly in hosted mode.
    if (ctx?.runMode === "hosted") {
      throw new PolicyViolationError(
        "hosted_default_deny",
        `no policy rule allows tool "${step.action}" in hosted mode`
      )
    }

    return null
  }
}

function matchesLegacy(rule: PolicyRule, step: Step): boolean {
  const condition = rule.condition
  if (condition.startsWith("action:")) {
    return step.action === condition.split(":")[1]
  }
  return false
}
