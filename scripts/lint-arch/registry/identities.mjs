/**
 * Owned identities — SSOT for domain keys that MAY cross package boundaries.
 *
 * Law (doctrine): every identity that is painted through the stack has exactly
 * one owner seam. An `*Id` appearing in ≥ MIN_PACKAGES packages without a row
 * here is shotgun surgery (the agentId failure class) — fail hard.
 *
 * Adding a legitimate cross-cutting id = add a row (additive).
 * Painting a new id through UI+server+agent without a row = lint failure.
 */

/** @typedef {{
 *   name: string
 *   ownerSeam: string
 *   packages: string[]
 *   note?: string
 *   used?: boolean
 * }} OwnedIdentity
 */

/** Minimum distinct packages for “painted through the stack”. */
export const IDENTITY_SPAN_MIN = 3

/** Property names that look like *Id but are not identities. */
export const IDENTITY_NOISE = new Set(["byId", "htmlId", "testId"])

/**
 * Registered domain / platform identities allowed to span packages.
 * @type {OwnedIdentity[]}
 */
export const OWNED_IDENTITIES = [
  { name: "runId", ownerSeam: "run-lifecycle", packages: ["agent", "server", "ui"] },
  { name: "parentRunId", ownerSeam: "run-lifecycle", packages: ["agent", "server", "ui"] },
  { name: "toolCallId", ownerSeam: "run-lifecycle", packages: ["agent", "server", "ui"] },
  { name: "planId", ownerSeam: "run-lifecycle", packages: ["agent", "server", "sync", "ui"] },
  { name: "stepId", ownerSeam: "run-lifecycle", packages: ["agent", "server", "sync", "ui"] },
  { name: "tenantId", ownerSeam: "platform", packages: ["server", "sync", "ui"] },
  { name: "entityId", ownerSeam: "sync", packages: ["agent", "server", "sync", "ui"] },
  { name: "definitionId", ownerSeam: "sync", packages: ["agent", "server", "sync", "ui"] },
  { name: "connectorId", ownerSeam: "connectors", packages: ["agent", "server", "sync", "ui"] },
  { name: "strategyId", ownerSeam: "sync", packages: ["server", "sync", "ui"] },
  { name: "flowId", ownerSeam: "sync", packages: ["server", "sync", "ui"] },
  { name: "previewId", ownerSeam: "sync", packages: ["server", "sync", "ui"] },
  { name: "sourceId", ownerSeam: "sync", packages: ["agent", "server", "ui"] },
  { name: "targetId", ownerSeam: "sync", packages: ["agent", "server", "ui"] },
]
