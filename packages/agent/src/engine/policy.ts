/**
 * Policy engine — evaluates governance rules against tool steps.
 *
 * Rules are data-driven. Add/remove rules at runtime.
 * Conditions match against step action names or input properties.
 */

import { PolicyEffect } from "./enums.js"
import { PolicyViolationError } from "./errors.js"
import type { PolicyEvaluator } from "./interfaces.js"
import type { AgentRun, PolicyRule, Step } from "./models.js"

export class RulePolicyEvaluator implements PolicyEvaluator {
  private rules: PolicyRule[] = []

  addRule(rule: PolicyRule): void { this.rules.push(rule) }
  removeRule(name: string): void { this.rules = this.rules.filter(r => r.name !== name) }
  listRules(): PolicyRule[] { return [...this.rules] }

  async evaluatePreStep(_run: AgentRun, step: Step): Promise<string | null> {
    for (const rule of this.rules) {
      if (this.matches(rule, step)) {
        if (rule.effect === PolicyEffect.Deny) {
          throw new PolicyViolationError(rule.name, rule.condition)
        }
        if (rule.effect === PolicyEffect.RequireApproval) {
          return `Policy '${rule.name}': ${rule.condition}`
        }
      }
    }
    return null
  }

  /**
   * Supported conditions:
   *   "action:<name>"  — step uses a specific tool
   */
  private matches(rule: PolicyRule, step: Step): boolean {
    const condition = rule.condition

    if (condition.startsWith("action:")) {
      return step.action === condition.split(":")[1]
    }

    return false
  }
}
