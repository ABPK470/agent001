/**
 * Server-only enums for the `effects` domain.
 */

/** Effect kind in the deferred effect ledger. */
export const EffectKind = {
  Create: "create",
  Modify: "modify",
  Delete: "delete",
  Command: "command",
  Network: "network"
} as const

export type EffectKind = (typeof EffectKind)[keyof typeof EffectKind]

export const EFFECT_KINDS: ReadonlyArray<EffectKind> = Object.values(EffectKind)

export const isEffectKind = (value: unknown): value is EffectKind =>
  typeof value === "string" && (EFFECT_KINDS as readonly string[]).includes(value)

/** Effect lifecycle status. */
export const EffectStatus = {
  Pending: "pending",
  Applied: "applied",
  Compensated: "compensated",
  Skipped: "skipped"
} as const

export type EffectStatus = (typeof EffectStatus)[keyof typeof EffectStatus]

export const EFFECT_STATUSES: ReadonlyArray<EffectStatus> = Object.values(EffectStatus)

export const isEffectStatus = (value: unknown): value is EffectStatus =>
  typeof value === "string" && (EFFECT_STATUSES as readonly string[]).includes(value)

/**
 * Action taken during effect rollback (broadcast in EventType.RollbackEffect data).
 *   - Deleted   — created artefact removed (undo Create)
 *   - Restored  — modified artefact reverted to pre-state (undo Modify)
 *   - Recreated — deleted artefact restored from snapshot (undo Delete)
 */
export const RollbackActionType = {
  Deleted: "deleted",
  Restored: "restored",
  Recreated: "recreated"
} as const

export type RollbackActionType = (typeof RollbackActionType)[keyof typeof RollbackActionType]

export const ROLLBACK_ACTION_TYPES: ReadonlyArray<RollbackActionType> = Object.values(RollbackActionType)

export const isRollbackActionType = (value: unknown): value is RollbackActionType =>
  typeof value === "string" && (ROLLBACK_ACTION_TYPES as readonly string[]).includes(value)
