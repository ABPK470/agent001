/**
 * Postgres session prefix for deterministic Sync reads/writes.
 */

export const POSTGRES_DETERMINISTIC_SESSION_PREFIX =
  `SET TIME ZONE 'UTC';\n` +
  `SET intervalstyle = 'iso_8601';\n` +
  `SET datestyle = 'ISO, YMD';\n`
