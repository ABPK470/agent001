/**
 * Declarative workflow schema — the core abstraction that makes this a platform.
 *
 * Users define workflows as JSON data. The engine interprets and executes them.
 * Action handlers are registered separately and looked up by name at runtime.
 *
 * This is what separates a "platform" from a "custom app": business logic
 * lives in workflow definitions + action handlers, not in the orchestrator.
 */

// ── Workflow Definition (the "what") ─────────────────────────────

export interface ParameterDef {
  type: "string" | "number" | "boolean" | "object" | "array"
  description?: string
  required?: boolean
  default?: unknown
}

export interface RetryPolicy {
  maxAttempts: number
  backoffMs: number
}

export interface StepDefinition {
  /** Unique id within the workflow. Referenced by dependsOn / expressions. */
  id: string
  name: string
  /** Registered action handler name, e.g. "http.request", "transform.map" */
  action: string
  /** Input params — may contain expressions like "{{steps.prev.output.data}}" */
  input: Record<string, unknown>
  /** Step ids this step depends on. Engine resolves execution order. */
  dependsOn?: string[]
  /** Expression that must be truthy for the step to run. Falsy → skip. */
  condition?: string
  retryPolicy?: RetryPolicy
  timeoutMs?: number
  onError?: "fail" | "skip" | "continue"
}

export interface WorkflowDefinition {
  name: string
  description: string
  /** JSON-Schema-like description of required inputs at run time. */
  inputSchema: Record<string, ParameterDef>
  /** Ordered list of steps. `dependsOn` enables DAG execution. */
  steps: StepDefinition[]
  /** Tags for filtering / routing. */
  tags?: string[]
}
