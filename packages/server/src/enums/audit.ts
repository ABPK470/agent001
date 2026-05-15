/**
 * Audit-log enums.
 *
 * `AuditActor` discriminates whether an audit-log row was generated
 * by the human user (clicking a UI button) or by the agent (autonomous
 * tool call / planner step). Promoted from a string-union so the 30+
 * `services.auditService.log({ actor: "..." })` call sites stop drifting.
 *
 * @module
 */

export const AuditActor = {
  User:  "user",
  Agent: "agent",
} as const

export type AuditActor = (typeof AuditActor)[keyof typeof AuditActor]

export const AUDIT_ACTORS: ReadonlyArray<AuditActor> = Object.values(AuditActor)

export const isAuditActor = (value: unknown): value is AuditActor =>
  typeof value === "string" && (AUDIT_ACTORS as readonly string[]).includes(value)
