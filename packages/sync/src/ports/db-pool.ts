/**
 * MSSQL pool port — injected at execute composition root.
 */

import type { MssqlConnectionPool } from "../internal/mssql-types.js"

export interface DbPoolPort {
  getPool(envName: string): Promise<{ pool: MssqlConnectionPool | null }>
}
