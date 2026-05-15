/**
 * Façade — `OperationKind` and `OperationStatus` live in
 * `@mia/shared-enums` (single source of truth shared with the UI's
 * `/api/operations` consumer). Re-export here so `import { ... } from
 * "./enums/operations.js"` call sites keep working.
 */
export {
  OperationKind,
  OPERATION_KINDS,
  isOperationKind,
  OperationStatus,
  OPERATION_STATUSES,
  isOperationStatus,
} from "@mia/shared-enums"
