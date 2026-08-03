/**
 * Retrying warehouse query runner for the diff engine.
 * Re-exports the dialect-aware path (mssql | postgres).
 */

export { runQueryWithRetry } from "../warehouse-query.js"
export type { WarehouseQueryResult } from "../../ports/warehouse-query.js"
