import type Database from "better-sqlite3"

import { backfillSyncSqlEventLogLinks } from "../db/sync-sql-log-backfill.js"

/**
 * Repair legacy event_log rows that are missing sqlLogId / sql preview.
 *
 * Runs once at migration time with strict uniqueness — no runtime guessing.
 */
export function runBackfillSyncSqlEventLinksMigration(db: Database.Database): void {
  const result = backfillSyncSqlEventLogLinks(db)
  if (result.repaired > 0 || result.skippedAmbiguous > 0 || result.skippedNoMatch > 0) {
    console.log(
      `[migration] sync_sql_event_links: repaired=${result.repaired} ` +
        `skipped_no_match=${result.skippedNoMatch} skipped_ambiguous=${result.skippedAmbiguous}`,
    )
  }
}
