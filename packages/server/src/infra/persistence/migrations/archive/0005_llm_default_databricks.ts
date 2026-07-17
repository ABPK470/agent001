/**
 * Default LLM provider is Databricks (corp intranet). Rewrites only the
 * untouched factory copilot-chat row — explicit operator choices are kept.
 */

import type Database from "better-sqlite3"

const DEFAULT_DATABRICKS_MODEL = "databricks-gpt-5-4"

export function runLlmDefaultDatabricksMigration(db: Database.Database): void {
  db.prepare(
    `
    UPDATE llm_config
       SET provider = 'databricks',
           model = @model,
           api_key = '',
           base_url = '',
           updated_at = datetime('now')
     WHERE id = 1
       AND provider = 'copilot-chat'
       AND model = 'gpt-5.4'
       AND api_key = ''
       AND base_url = ''
  `
  ).run({ model: DEFAULT_DATABRICKS_MODEL })
}
