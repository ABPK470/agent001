/**
 * Tip SoT is entity.flowId. The sync_definition_configs cache table is gone.
 * Publish/admin resolve flow from the entity document + flow catalog only.
 */

import type Database from "better-sqlite3"

export function runDropSyncDefinitionConfigsMigration(db: Database.Database): void {
  db.exec(`DROP TABLE IF EXISTS sync_definition_configs`)
}
