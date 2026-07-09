import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Process-wide server runtime data root.
 *
 * Default `~/.mia`; override with `MIA_DATA_DIR`. Holds SQLite (`mia.db`),
 * schema catalog cache, sync plan snapshots, evidence blobs, attachments,
 * browser contexts, and vault key file — everything server-local and not in git.
 */
export function resolveServerDataDir(): string {
  return process.env.MIA_DATA_DIR || join(homedir(), ".mia")
}

export function resolveDbPath(): string {
  return join(resolveServerDataDir(), "mia.db")
}

export function resolveSyncPlansDir(): string {
  return join(resolveServerDataDir(), "sync-plans")
}

export function resolveEvidenceDir(): string {
  return join(resolveServerDataDir(), "evidence")
}
