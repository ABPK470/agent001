/**
 * Run sandbox artifacts — list and resolve paths for user download.
 * Files live on the server only while the run workspace exists; delivery
 * to the user is always via Content-Disposition attachment streams.
 */

import { createReadStream, type Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"

export interface RunArtifactEntry {
  path: string
  sizeBytes: number
}

const MAX_LIST_FILES = 500
const MAX_FILE_BYTES = 64 * 1024 * 1024

export function resolveRunArtifactFile(executionRoot: string, relativePath: string): string | null {
  const root = resolve(executionRoot)
  const normalized = relativePath.replace(/^\/+/, "").replace(/\\/g, "/")
  if (!normalized || normalized.includes("..")) return null
  const target = resolve(root, normalized)
  if (target !== root && !target.startsWith(root + sep)) return null
  return target
}

async function walkDir(
  dir: string,
  root: string,
  out: RunArtifactEntry[],
): Promise<void> {
  if (out.length >= MAX_LIST_FILES) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    if (out.length >= MAX_LIST_FILES) return
    if (ent.name.startsWith(".")) continue
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      await walkDir(abs, root, out)
      continue
    }
    if (!ent.isFile()) continue
    try {
      const st = await stat(abs)
      const rel = abs.slice(root.length + 1).replace(/\\/g, "/")
      out.push({ path: rel, sizeBytes: st.size })
    } catch (err: unknown) { console.error("[mia]", err) }
  }
}

export async function listRunArtifactFiles(executionRoot: string): Promise<RunArtifactEntry[]> {
  const root = resolve(executionRoot)
  const out: RunArtifactEntry[] = []
  await walkDir(root, root, out)
  out.sort((a, b) => a.path.localeCompare(b.path))
  return out
}

export async function openRunArtifactStream(
  executionRoot: string,
  relativePath: string,
): Promise<{ stream: ReturnType<typeof createReadStream>; sizeBytes: number; filename: string } | null> {
  const abs = resolveRunArtifactFile(executionRoot, relativePath)
  if (!abs) return null
  let st
  try {
    st = await stat(abs)
  } catch {
    return null
  }
  if (!st.isFile()) return null
  if (st.size > MAX_FILE_BYTES) return null
  return {
    stream: createReadStream(abs),
    sizeBytes: st.size,
    filename: basename(abs),
  }
}
