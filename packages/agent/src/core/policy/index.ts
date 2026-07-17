/**
 * Pure policy decisions — selector matching and rule evaluation.
 *
 * What: decide allow / deny / require_approval for a tool step.
 * Why: governance without I/O; AuditService/Learner live under ports/.
 * Next: govern-tools wraps tools with RulePolicyEvaluator.
 */

export * from "./selectors.js"
export * from "./evaluate.js"
