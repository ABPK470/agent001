/**
 * Structural validation for EntityDefinition + Scd2Strategy.
 *
 * Runs on every save before the storage layer accepts the write. Validation
 * is pure (no IO) so it can run client-side in the wizard too — the server
 * re-validates on every API call regardless.
 *
 * What this DOES validate:
 *   - Id shape (regex + reserved list)
 *   - Required-field presence
 *   - Internal consistency (no duplicate tables, no execution-order cycles,
 *     scope discriminator fields all populated, scd2 strategy reference is
 *     non-empty, etc.)
 *   - Obvious SQL-injection patterns in `scope.sql` predicates
 *
 * What this does NOT validate (deferred to a separate `validateAgainstCatalog`
 * call that needs a live catalog handle):
 *   - That rootTable / idColumn / scope columns actually exist in the schema
 *   - That referenced strategy ids exist
 *   - That FK hops are real foreign keys
 *
 * The split keeps this module pure + dependency-free + safe to ship to the
 * browser.
 */

import { findEntityTableOrderViolations, orderEntityTablesDetailed } from "./order.js"
import {
    type EntityDefinition,
    type EntityTable,
    type EntityTableScope,
    type Scd2Strategy,
    type ValidationError,
    type ValidationResult,
    type ValidationWarning,
    isValidId,
    RESERVED_ENTITY_IDS,
} from "./types.js"

// ── Public entrypoints ───────────────────────────────────────────

export function validateEntityDefinition(def: EntityDefinition): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  validateIdentity(def, errors)
  validateTenant(def, errors)
  validateRoot(def, errors)
  validateTables(def, errors, warnings)
  validateScd2Reference(def, errors)
  validateLineage(def, errors, warnings)
  validateVersion(def, errors)

  return { ok: errors.length === 0, errors, warnings }
}

export function validateScd2Strategy(strategy: Scd2Strategy): ValidationResult {
  const errors: ValidationError[] = []
  const warnings: ValidationWarning[] = []

  if (!isValidId(strategy.id)) {
    errors.push({ code: "id_invalid", message: `Invalid strategy id "${strategy.id}"`, path: "/id" })
  }
  if (!strategy.displayName || strategy.displayName.trim().length === 0) {
    errors.push({ code: "id_invalid", message: "displayName is required", path: "/displayName" })
  }
  if (!Number.isInteger(strategy.version) || strategy.version < 1) {
    errors.push({ code: "version_not_positive", message: "version must be a positive integer", path: "/version" })
  }
  // Identity handling: enforce enum even if the type system already does
  // (defence in depth for JSON imports).
  const validIdentity = ["none", "setIdentityInsertOn", "preserveSequence"]
  if (!validIdentity.includes(strategy.identityHandling)) {
    errors.push({
      code: "id_invalid",
      message: `identityHandling must be one of: ${validIdentity.join(", ")}`,
      path: "/identityHandling",
    })
  }
  // Sanity-warn if validTo is set without validFrom (or vice versa).
  if (strategy.validFromCol && !strategy.validToCol) {
    warnings.push({
      code: "scd2_validity_half",
      message: "validFromCol is set but validToCol is null — SCD2 close-on-update will not happen",
      path: "/validToCol",
    })
  }
  if (strategy.validToCol && !strategy.validFromCol) {
    warnings.push({
      code: "scd2_validity_half",
      message: "validToCol is set but validFromCol is null — new rows will have unbounded validity",
      path: "/validFromCol",
    })
  }
  // onInsert / onUpdate values are raw SQL — flag obvious unsafe patterns.
  for (const [col, expr] of Object.entries(strategy.onInsert)) {
    if (looksUnsafeSqlFragment(expr)) {
      errors.push({
        code: "scope_sql_unsafe",
        message: `onInsert[${col}] expression contains suspicious tokens (semicolon, comment, multi-statement)`,
        path: `/onInsert/${col}`,
      })
    }
  }
  for (const [col, expr] of Object.entries(strategy.onUpdate)) {
    if (looksUnsafeSqlFragment(expr)) {
      errors.push({
        code: "scope_sql_unsafe",
        message: `onUpdate[${col}] expression contains suspicious tokens (semicolon, comment, multi-statement)`,
        path: `/onUpdate/${col}`,
      })
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ── Sub-validators ───────────────────────────────────────────────

function validateIdentity(def: EntityDefinition, errors: ValidationError[]): void {
  if (!isValidId(def.id)) {
    errors.push({
      code: "id_invalid",
      message: `Invalid entity id "${def.id}". Must match /^[a-z][a-z0-9_-]{0,63}$/.`,
      path: "/id",
    })
    return
  }
  if ((RESERVED_ENTITY_IDS as readonly string[]).includes(def.id)) {
    errors.push({
      code: "id_reserved",
      message: `Entity id "${def.id}" is reserved at the platform level.`,
      path: "/id",
    })
  }
  if (!def.displayName || def.displayName.trim().length === 0) {
    errors.push({ code: "id_invalid", message: "displayName is required", path: "/displayName" })
  }
}

function validateTenant(def: EntityDefinition, errors: ValidationError[]): void {
  if (!def.tenantId || def.tenantId.trim().length === 0) {
    errors.push({ code: "tenant_missing", message: "tenantId is required", path: "/tenantId" })
  }
}

function validateRoot(def: EntityDefinition, errors: ValidationError[]): void {
  if (!isSchemaQualifiedTable(def.rootTable)) {
    errors.push({
      code: "root_table_invalid",
      message: `rootTable must be schema-qualified (e.g. "core.Contract"); got "${def.rootTable}"`,
      path: "/rootTable",
    })
  }
  if (!isIdentifier(def.idColumn)) {
    errors.push({
      code: "id_column_missing",
      message: `idColumn must be a valid SQL identifier; got "${def.idColumn}"`,
      path: "/idColumn",
    })
  }
  if (def.labelColumn !== null && !isIdentifier(def.labelColumn)) {
    errors.push({
      code: "id_column_missing",
      message: `labelColumn must be a valid SQL identifier or null; got "${def.labelColumn}"`,
      path: "/labelColumn",
    })
  }
  if (def.selfJoinColumn !== null && !isIdentifier(def.selfJoinColumn)) {
    errors.push({
      code: "id_column_missing",
      message: `selfJoinColumn must be a valid SQL identifier or null; got "${def.selfJoinColumn}"`,
      path: "/selfJoinColumn",
    })
  }
}

function validateTables(
  def: EntityDefinition,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  const seenNames = new Set<string>()
  const seenOrders = new Set<number>()
  for (let i = 0; i < def.tables.length; i++) {
    const t = def.tables[i]!
    const path = `/tables/${i}`
    if (!isSchemaQualifiedTable(t.name)) {
      errors.push({
        code: "table_name_invalid",
        message: `Table name must be schema-qualified; got "${t.name}"`,
        path: `${path}/name`,
      })
    }
    const lc = t.name.toLowerCase()
    if (seenNames.has(lc)) {
      errors.push({ code: "table_duplicate", message: `Duplicate table "${t.name}"`, path: `${path}/name` })
    }
    seenNames.add(lc)
    if (!Number.isInteger(t.executionOrder) || t.executionOrder < 0) {
      errors.push({
        code: "execution_order_duplicate",
        message: `executionOrder must be a non-negative integer; got ${t.executionOrder}`,
        path: `${path}/executionOrder`,
      })
    } else {
      if (seenOrders.has(t.executionOrder)) {
        warnings.push({
          code: "execution_order_duplicate",
          message: `executionOrder ${t.executionOrder} appears more than once — tie-break by table position is implementation-defined`,
          path: `${path}/executionOrder`,
        })
      }
      seenOrders.add(t.executionOrder)
    }
    validateScope(t.scope, errors, `${path}/scope`)
    validateTableScd2Override(t, errors, `${path}/scd2Override`)
  }
  if (def.tables.length === 0) {
    warnings.push({
      code: "tables_empty",
      message: "Entity has no tables. Preview/execute will be a no-op until at least one table is added.",
      path: "/tables",
    })
  } else {
    const violations = findEntityTableOrderViolations(def)
    const tableIndexByName = new Map(def.tables.map((table, index) => [table.name.toLowerCase(), index]))
    for (const violation of violations) {
      const childIndex = tableIndexByName.get(violation.child.toLowerCase())
      errors.push({
        code: "execution_order_cycle",
        message: `executionOrder violates dependency order: "${violation.parent}" must precede "${violation.child}" (${violation.reason}).`,
        path: childIndex == null ? "/tables" : `/tables/${childIndex}/executionOrder`,
      })
    }
    const ordered = orderEntityTablesDetailed(def)
    if (ordered.cycleDetected) {
      errors.push({
        code: "execution_order_cycle",
        message: "executionOrder dependencies contain a cycle or unresolved ordering ambiguity.",
        path: "/tables",
      })
    }
  }
}

function validateScope(scope: EntityTableScope, errors: ValidationError[], path: string): void {
  switch (scope.kind) {
    case "rootPk":
      if (!isIdentifier(scope.column)) {
        errors.push({
          code: "scope_invalid",
          message: `rootPk.column must be a valid SQL identifier; got "${scope.column}"`,
          path: `${path}/column`,
        })
      }
      break
    case "fkPath":
      if (!Array.isArray(scope.through) || scope.through.length === 0) {
        errors.push({
          code: "scope_invalid",
          message: "fkPath.through must be a non-empty array",
          path: `${path}/through`,
        })
        break
      }
      for (let i = 0; i < scope.through.length; i++) {
        const hop = scope.through[i]!
        const hopPath = `${path}/through/${i}`
        if (!isSchemaQualifiedTable(hop.table)) {
          errors.push({
            code: "scope_invalid",
            message: `fkPath hop ${i}: table must be schema-qualified; got "${hop.table}"`,
            path: `${hopPath}/table`,
          })
        }
        if (!isIdentifier(hop.fromColumn)) {
          errors.push({
            code: "scope_invalid",
            message: `fkPath hop ${i}: fromColumn must be a valid SQL identifier`,
            path: `${hopPath}/fromColumn`,
          })
        }
        if (!isIdentifier(hop.toColumn)) {
          errors.push({
            code: "scope_invalid",
            message: `fkPath hop ${i}: toColumn must be a valid SQL identifier`,
            path: `${hopPath}/toColumn`,
          })
        }
      }
      break
    case "sql":
      if (typeof scope.predicate !== "string" || scope.predicate.trim().length === 0) {
        errors.push({
          code: "scope_invalid",
          message: "sql.predicate must be a non-empty string",
          path: `${path}/predicate`,
        })
        break
      }
      // Require a placeholder so the predicate is actually parameterised.
      if (!scope.predicate.includes("{id}") && !scope.predicate.includes("{ids}")) {
        errors.push({
          code: "scope_invalid",
          message: "sql.predicate must reference {id} or {ids}",
          path: `${path}/predicate`,
        })
      }
      if (looksUnsafeSqlFragment(scope.predicate)) {
        errors.push({
          code: "scope_sql_unsafe",
          message: "sql.predicate contains suspicious tokens (semicolon, comment, multi-statement). Predicates must be a single boolean expression.",
          path: `${path}/predicate`,
        })
      }
      break
    default:
      errors.push({
        code: "scope_invalid",
        message: `Unknown scope kind`,
        path,
      })
  }
}

function validateTableScd2Override(
  t: EntityTable,
  errors: ValidationError[],
  path: string,
): void {
  const o = t.scd2Override
  if (o === null) return
  // Identifiers must be valid SQL names when set (null is allowed = unset).
  const idCols: Array<[keyof typeof o, string]> = [
    ["validFromCol", "validFromCol"],
    ["validToCol", "validToCol"],
    ["isLockedCol", "isLockedCol"],
    ["syncDateCol", "syncDateCol"],
    ["deployDateCol", "deployDateCol"],
  ]
  for (const [key, label] of idCols) {
    const v = o[key]
    if (v !== undefined && v !== null && !isIdentifier(v as string)) {
      errors.push({
        code: "scope_invalid",
        message: `${label} override must be a valid SQL identifier or null`,
        path: `${path}/${label}`,
      })
    }
  }
  if (o.excludedFromDiffCols !== undefined) {
    for (let i = 0; i < o.excludedFromDiffCols.length; i++) {
      if (!isIdentifier(o.excludedFromDiffCols[i]!)) {
        errors.push({
          code: "scope_invalid",
          message: `excludedFromDiffCols[${i}] must be a valid SQL identifier`,
          path: `${path}/excludedFromDiffCols/${i}`,
        })
      }
    }
  }
  if (o.onInsert) {
    for (const [col, expr] of Object.entries(o.onInsert)) {
      if (looksUnsafeSqlFragment(expr)) {
        errors.push({
          code: "scope_sql_unsafe",
          message: `onInsert[${col}] override expression contains suspicious tokens`,
          path: `${path}/onInsert/${col}`,
        })
      }
    }
  }
  if (o.onUpdate) {
    for (const [col, expr] of Object.entries(o.onUpdate)) {
      if (looksUnsafeSqlFragment(expr)) {
        errors.push({
          code: "scope_sql_unsafe",
          message: `onUpdate[${col}] override expression contains suspicious tokens`,
          path: `${path}/onUpdate/${col}`,
        })
      }
    }
  }
}

function validateScd2Reference(def: EntityDefinition, errors: ValidationError[]): void {
  if (!isValidId(def.scd2.strategyId)) {
    errors.push({
      code: "scd2_strategy_unknown",
      message: `scd2.strategyId "${def.scd2.strategyId}" is not a valid id`,
      path: "/scd2/strategyId",
    })
  }
  const v = def.scd2.strategyVersion
  if (v !== "latest" && (!Number.isInteger(v) || (v as number) < 1)) {
    errors.push({
      code: "scd2_strategy_version_unknown",
      message: `scd2.strategyVersion must be a positive integer or "latest"; got ${String(v)}`,
      path: "/scd2/strategyVersion",
    })
  }
}

function validateLineage(
  def: EntityDefinition,
  errors: ValidationError[],
  _warnings: ValidationWarning[],
): void {
  for (let i = 0; i < def.lineageRefs.length; i++) {
    const ref = def.lineageRefs[i]!
    if (!isSchemaQualifiedTable(ref.object)) {
      errors.push({
        code: "lineage_object_invalid",
        message: `lineageRefs[${i}].object must be schema-qualified; got "${ref.object}"`,
        path: `/lineageRefs/${i}/object`,
      })
    }
  }
}

function validateVersion(def: EntityDefinition, errors: ValidationError[]): void {
  if (!Number.isInteger(def.version) || def.version < 1) {
    errors.push({
      code: "version_not_positive",
      message: `version must be a positive integer; got ${def.version}`,
      path: "/version",
    })
  }
}

// ── Lexical helpers ──────────────────────────────────────────────

/**
 * Permissive but safe SQL identifier matcher. Accepts unquoted MSSQL-style
 * identifiers including bracket-quoted variants like `[Order]`. Reject any
 * input that contains whitespace, statement separators, comments, or quote
 * characters likely to break out of an identifier context.
 *
 * Intentionally does NOT try to be a full T-SQL parser — this is a guard
 * against pathological inputs in stored config, paired with the
 * `validateAgainstCatalog` server-side check that confirms the name actually
 * exists in the schema before any SQL is emitted.
 */
export function isIdentifier(name: unknown): name is string {
  if (typeof name !== "string") return false
  if (name.length === 0 || name.length > 128) return false
  // Bracket-quoted: [Anything except ] and newline].
  if (name.startsWith("[") && name.endsWith("]")) {
    const inner = name.slice(1, -1)
    return inner.length > 0 && !/[\]\r\n]/.test(inner)
  }
  // Unquoted: starts with letter/underscore, body alphanumeric+underscore.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * Schema-qualified table reference: `schema.name`, both parts validated as
 * identifiers. Three-part names (server.db.schema.table) are NOT accepted
 * here.
 */
export function isSchemaQualifiedTable(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = value.split(".")
  if (parts.length !== 2) return false
  return isIdentifier(parts[0]!) && isIdentifier(parts[1]!)
}

/**
 * Reject SQL fragments that look like they're attempting to chain statements
 * or hide content. The orchestrator emits everything via parameterised paths
 * (4-part-name + OPENQUERY); user-supplied predicates participate only as
 * substring substitution into a WHERE clause, so any of these tokens would
 * indicate either malice or operator error worth catching at save time.
 *
 * Conservative: false-positives are preferred to false-negatives. Users
 * needing semicolons inside a sub-expression can split into multiple tables
 * each with its own scope, or use fkPath instead of raw sql.
 */
export function looksUnsafeSqlFragment(fragment: string): boolean {
  if (typeof fragment !== "string") return true
  // Strip placeholder tokens so they don't trip the regex.
  const stripped = fragment.replace(/\{ids?\}/g, "PLACEHOLDER")
  // Statement separator outside of a string literal — approximated by any
  // semicolon at all (predicates have no legitimate use for one).
  if (stripped.includes(";")) return true
  // Line comments and block comments.
  if (stripped.includes("--")) return true
  if (stripped.includes("/*") || stripped.includes("*/")) return true
  // GO batch separator on its own line.
  if (/(^|\n)\s*GO\s*($|\n)/i.test(stripped)) return true
  // Backtick is never valid T-SQL — strong signal of copy-paste from
  // another dialect or markdown.
  if (stripped.includes("`")) return true
  return false
}
