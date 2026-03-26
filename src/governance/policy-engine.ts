/**
 * Policy engine — evaluates governance rules against steps.
 *
 * Rules are data-driven. Add new rules at runtime via the API.
 * The engine matches conditions against step properties.
 */

import { PolicyEffect } from "../domain/enums.js"
import { PolicyViolationError } from "../domain/errors.js"
import type { PolicyRule, Step, WorkflowRun } from "../domain/models.js"
import type { PolicyEvaluator } from "../ports/services.js"

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

  async evaluatePreStep(run: WorkflowRun, step: Step): Promise<string | null> {
    for (const rule of this.rules) {
      if (this.matches(rule, step, run)) {
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
   * Supported condition formats:
   *   "amount_gt:<number>"   — step input contains `amount` > threshold
   *   "action:<name>"        — step uses a specific action handler
   *   "tag:<tag>"            — (reserved for future: workflow has tag)
   */
  private matches(rule: PolicyRule, step: Step, _run: WorkflowRun): boolean {
    const condition = rule.condition
    const input = step.input

    if (condition.startsWith("amount_gt:")) {
      const threshold = Number(condition.split(":")[1])
      const amount = input["amount"]
      if (amount !== undefined && Number(amount) > threshold) {
        return true
      }
    } else if (condition.startsWith("action:")) {
      const target = condition.split(":")[1]
      if (step.action === target) {
        return true
      }
    }

    return false
  }
}
