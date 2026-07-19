/**
 * PolicySource — provenance for a `policy_configs` row.
 *
 * Wire-format: server returns it in `/api/policy/*` payloads; UI policy
 * editor compares with `===` to render source badges.
 *
 *   - Db            : explicitly authored by a host operator (persisted).
 *   - HostedDefault : seeded by hosted-mode bootstrap; may be overridden.
 *   - EnvDerived    : synthesized from environment configuration at boot.
 */
export const PolicySource = {
  Db:            "db",
  HostedDefault: "hosted_default",
  EnvDerived:    "env_derived",
} as const

export type PolicySource = (typeof PolicySource)[keyof typeof PolicySource]

export const POLICY_SOURCES: ReadonlyArray<PolicySource> = Object.values(PolicySource)

export const isPolicySource = (value: unknown): value is PolicySource =>
  typeof value === "string" && (POLICY_SOURCES as readonly string[]).includes(value)
