/**
 * Tenant configuration — the documented process-wide ambient exception.
 *
 * What: install-specific knobs (keywords, SQL thresholds, catalog bootstrap).
 * Why: one mia install ≠ another; loaded once at server boot.
 * Next: pass values into core as parameters when practical; getters remain
 * for the allowlisted ambient read.
 */
export * from "./tenant-config.js"
export * from "./known-vocabulary.js"
export * from "./published-sync-vocabulary.js"
