/**
 * Internal types for the sync diff engine.
 *
 * @module
 */

import type { SyncTelemetryContext } from "../../ports/events.js"

export interface DiffOptions {
  /** Per-table source row cap; if exceeded the table is flagged and skipped. */
  rowCap?: number
  /** Maximum sample rows per bucket (insert/update/delete). */
  sampleSize?: number
  /**
   * When the recipe root table has a self-referencing FK, these are the
   * expanded tree IDs. Substituted into `{ids}` placeholders in predicates.
   */
  expandedIds?: Array<string | number> | null
  /** Optional telemetry attribution for SQL emitted during this diff. */
  telemetryContext?: SyncTelemetryContext
}

export const DEFAULT_OPTS: DiffOptions = {
  rowCap: 5_000_000,
  sampleSize: 50,
  expandedIds: null,
  telemetryContext: undefined
}

/**
 * Columns excluded from row-fingerprint comparison and UPDATE SET clauses.
 * Mirrors legacy core.uspSyncObjectTran's exclusion list.
 */
export const META_EXCLUDED_COLUMNS = new Set(["validFrom", "validTo", "isLocked", "syncDate", "deployDate"])

export interface PkHashRow {
  pk: string
  rowHash: string
  pkValues: Record<string, unknown>
}

export interface HashColumn {
  name: string
  /** Base SQL Server type name (lower-case), e.g. 'datetime2', 'float', 'varbinary'. */
  systemType: string
}

export interface TableColumnInfo {
  /** All non-computed, non-meta, non-identity columns to include in the row hash. */
  hashColumns: HashColumn[]
  /** The single identity column (PK), or null if none. */
  identityColumn: string | null
}

/**
 * Session options pinned on every diff query so all pooled TDS connections
 * produce byte-identical CONVERT() output. Order matters — LANGUAGE resets
 * DATEFORMAT, so DATEFORMAT must come second.
 */
export const DETERMINISTIC_SESSION_PREFIX =
  "SET LANGUAGE us_english; " +
  "SET DATEFORMAT ymd; " +
  "SET NUMERIC_ROUNDABORT OFF; " +
  "SET ANSI_WARNINGS ON; " +
  "SET ANSI_PADDING ON; " +
  "SET ANSI_NULLS ON; " +
  "SET CONCAT_NULL_YIELDS_NULL ON; " +
  "SET ARITHABORT ON; " +
  "SET QUOTED_IDENTIFIER ON; "
