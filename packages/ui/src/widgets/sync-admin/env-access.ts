/**
 * Derive sync environment allowedOperations from access mode + deny flags.
 * Must stay aligned with server policy seeding and assertEnvOperationAllowed.
 */

import type { EnvAccessMode, EnvOperation } from "../../types"

const READ_OPS: EnvOperation[] = ["query_read", "schema_introspect", "sync_preview"]

/** Effective whitelist sent to the API. */
export function deriveAllowedOperations(
  accessMode: EnvAccessMode,
  denyDml: boolean,
  denyDdl: boolean,
): EnvOperation[] {
  const ops: EnvOperation[] = [...READ_OPS]
  if (accessMode === "read_write") {
    ops.push("sync_execute")
    if (!denyDml) ops.push("dml")
    if (!denyDdl) ops.push("ddl")
  }
  return ops
}

/** Suggest access flags from connection name (prod/uat → locked down). */
export function suggestAccessForName(name: string): {
  defaultAccessMode: EnvAccessMode
  denyDml: boolean
  denyDdl: boolean
} {
  const locked = /\bprod\b|\buat\b|\bstag(e|ing)?\b/i.test(name)
  return {
    defaultAccessMode: locked ? "read_only" : "read_write",
    denyDml: locked,
    denyDdl: locked,
  }
}

export function denyFlagsForAccessMode(mode: EnvAccessMode): { denyDml: boolean; denyDdl: boolean } {
  if (mode === "read_only") return { denyDml: true, denyDdl: true }
  return { denyDml: false, denyDdl: false }
}

export const OP_LABELS: Record<EnvOperation, string> = {
  query_read: "read queries",
  schema_introspect: "schema introspect",
  sync_preview: "sync preview",
  sync_execute: "sync execute",
  dml: "DML writes",
  ddl: "DDL changes",
}
