/**
 * Kysely MssqlDialect factory — sole platform MSSQL connection stack.
 *
 * Uses tedious + tarn (Kysely’s supported MSSQL drivers). Warehouse Sync /
 * Bridge keep npm `mssql` pools separately; never share those with platform.
 */

import { Kysely, MssqlDialect } from "kysely"
import * as Tarn from "tarn"
import * as Tedious from "tedious"
import type { PlatformDatabase } from "../../schema/tables.js"
import type { MssqlPlatformConfig } from "./config.js"

export function createMssqlPlatformKysely(
  cfg: MssqlPlatformConfig,
): Kysely<PlatformDatabase> {
  return new Kysely<PlatformDatabase>({
    dialect: new MssqlDialect({
      tarn: {
        ...Tarn,
        options: {
          min: 0,
          max: 10,
        },
      },
      tedious: {
        ...Tedious,
        connectionFactory: () =>
          new Tedious.Connection({
            server: cfg.server,
            authentication: {
              type: "default",
              options: {
                userName: cfg.user,
                password: cfg.password,
              },
            },
            options: {
              database: cfg.database,
              port: cfg.port,
              encrypt: cfg.encrypt,
              trustServerCertificate: cfg.trustServerCertificate,
              enableArithAbort: true,
            },
          }),
      },
    }),
  })
}
