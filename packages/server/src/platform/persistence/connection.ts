/**
 * Process-wide SQLite connection.
 *
 * One database file per server process (`~/.mia/mia.db`, override with MIA_DATA_DIR).
 *
 * Lifecycle:
 *   1. Server boot calls {@link openDatabase} once — opens the file, runs migrations and seeds.
 *   2. Persistence modules call {@link getDb} when they need the handle (always the same instance).
 *
 * CLI tools and tests may call {@link getDb} without a prior {@link openDatabase}; the first call
 * opens the database lazily.
 */

import Database from "better-sqlite3"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { initMemoryFts } from "./memory/schema.js"
import { runMigrations } from "./migrations/index.js"
import { runSeeds } from "./db/seeds.js"

const DATA_DIR = process.env["MIA_DATA_DIR"] || join(homedir(), ".mia")
const DB_PATH = join(DATA_DIR, "mia.db")

let connection: Database.Database | null = null

/** Absolute path to the on-disk SQLite file (does not open the database). */
export function getDbPath(): string {
  return DB_PATH
}

function bootstrapSchema(db: Database.Database): void {
  runMigrations(db)
  runSeeds(db)
  initMemoryFts(db)
}

function createConnection(): Database.Database {
  mkdirSync(DATA_DIR, { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma("journal_mode = WAL")
  db.pragma("foreign_keys = ON")
  bootstrapSchema(db)
  return db
}

/**
 * Open the database (idempotent). Call once at server startup so migrations, seeds, and
 * maintenance run in a known order before handling traffic.
 */
export function openDatabase(): Database.Database {
  if (!connection) {
    connection = createConnection()
  }
  return connection
}

/** Return the open database connection. Opens lazily on first use when startup was skipped. */
export function getDb(): Database.Database {
  return openDatabase()
}

/** @internal Test hook — replace the process connection. */
export function _setDb(db: Database.Database): void {
  connection = db
}

/** @internal Test hook — point at a database and run migrations/seeds on it. */
export function _migrate(db: Database.Database): void {
  connection = db
  bootstrapSchema(db)
}
