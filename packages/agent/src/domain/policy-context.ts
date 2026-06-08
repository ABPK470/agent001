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
 * The shell constructs one of these records per run and passes it into the
 * policy engine / host-side bridges explicitly. No globals are mutated.
 */

import { PolicyDbEnvironment, PolicyRole, PolicyRunMode } from "./enums/policy.js"

export interface HostedPolicyContext {
  /** Run identity (for audit cross-referencing). */
  readonly runId: string
  /** Effective execution profile of the run. Drives default-deny. */
  readonly runMode: PolicyRunMode
  /** Caller role used by selector rules. */
  readonly role: PolicyRole
  /** Canonical sandbox root path; required when runMode === "hosted". */
  readonly sandboxRoot: string | null
  /** Default MSSQL environment if a tool call does not specify one. */
  readonly defaultDbEnvironment?: PolicyDbEnvironment
  /**
   * UPN of the user who initiated the run. Used by host-side bridges
   * (notably the attachment service) to bind ownership of artifacts the
   * agent produces. Null when the run is service-internal.
   */
  readonly actorUpn?: string | null
  /** Originating session id, mirrored from cookie sid. */
  readonly sessionId?: string | null
}
