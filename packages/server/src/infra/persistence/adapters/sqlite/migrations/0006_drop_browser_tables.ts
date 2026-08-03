/**
 * Migration 6 — drop retired Playwright/browser automation tables.
 * Version 6 so installs that recorded pre-squash follow-ups (v2–v5) still apply this.
 * Application code was removed earlier; schema leftover only.
 */

import type Database from "better-sqlite3"

export function runDropBrowserTablesMigration(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS browser_audit_log;
    DROP TABLE IF EXISTS browser_domain_policy_configs;
    DROP TABLE IF EXISTS browser_proxy_config;
    DROP TABLE IF EXISTS browser_credentials;
    DROP TABLE IF EXISTS browser_contexts;
  `)
}
