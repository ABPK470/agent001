/**
 * Hosted policy context — request-scoped policy inputs.
 *
 * The policy engine is data-driven and stateless, but selector-based rules
 * depend on facts that are not visible from a tool step alone:
 *
 *   - actor role (admin / hosted_user / visitor),
 *   - the run's execution profile / runMode (developer | hosted),
 *   - the canonical sandbox root for path containment checks,
 *   - the default MSSQL environment when a tool call does not name one.
 *
 * Following the existing AsyncLocalStorage convention used by
 * {@link runWithSyncContext} and the MSSQL kill-signal scope, callers wrap
 * a unit of work with {@link runWithPolicyContext}; the policy engine reads
 * the current context with {@link getPolicyContext} during evaluation.
 *
 * No globals are mutated. Concurrent runs see independent contexts.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export type PolicyRunMode = "developer" | "hosted"
export type PolicyRole = "admin" | "hosted_user" | "visitor"

export interface HostedPolicyContext {
  /** Run identity (for audit cross-referencing). */
  readonly runId:        string
  /** Effective execution profile of the run. Drives default-deny. */
  readonly runMode:      PolicyRunMode
  /** Caller role used by selector rules. */
  readonly role:         PolicyRole
  /** Canonical sandbox root path; required when runMode === "hosted". */
  readonly sandboxRoot:  string | null
  /** Default MSSQL environment if a tool call does not specify one. */
  readonly defaultDbEnvironment?: "dev" | "uat" | "prod"
}

const _als = new AsyncLocalStorage<HostedPolicyContext>()

export function runWithPolicyContext<T>(ctx: HostedPolicyContext, fn: () => Promise<T>): Promise<T> {
  return _als.run(ctx, fn)
}

export function getPolicyContext(): HostedPolicyContext | undefined {
  return _als.getStore()
}
