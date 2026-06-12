/**
 * Database connection — singleton SQLite instance.
 *
 * All domain-specific persistence modules import getDb() from here.
 * Data lives in ~/.mia/mia.db — survives server restarts.
 * Env override: MIA_DATA_DIR.
 *
 * Schema changes: add `000N_*.ts` under `persistence/migrations/` and register
 * it in `migrations/index.ts` (MIGRATIONS array).
 */

import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { initMemoryFts } from "../memory/schema.js"
import { runMigrations } from "../migrations/index.js"
import { runSeeds } from "./seeds.js"

const DATA_DIR = process.env["MIA_DATA_DIR"] || join(homedir(), ".mia")
mkdirSync(DATA_DIR, { recursive: true })

const DB_PATH = join(DATA_DIR, "mia.db")

/** Absolute path to the on-disk SQLite file (for logging / diagnostics). */
export function getDbPath(): string {
  return DB_PATH
}

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH)
    _db.pragma("journal_mode = WAL")
    _db.pragma("foreign_keys = ON")
    initializeDatabase(_db)
  }
  return _db
}

/** @internal — for testing only. Swap the backing database. */
export function _setDb(db: Database.Database): void {
  _db = db
}

function initializeDatabase(db: Database.Database): void {
  runMigrations(db)
  runSeeds(db)
  initMemoryFts(db)
}

/** @internal — exported for tests. Runs migrations + seeds on the given database. */
export function _migrate(db: Database.Database): void {
  _db = db
  initializeDatabase(db)
}
