/**
 * Save run sandbox files onto the user's machine.
 *
 * Preferred path: File System Access API — user picks a folder, then we
 * write the relative tree there. Fallback: browser download (usually the
 * Downloads folder) when the picker API is unavailable.
 */

import { downloadBlob } from "./userDownload"

export function runArtifactDownloadPath(runId: string, relativePath: string): string {
  const encoded = relativePath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encoded}`
}

export type WorkspaceSaveMode = "folder" | "downloads"

export interface WorkspaceSaveResult {
  count: number
  bytes: number
  mode: WorkspaceSaveMode
  /** Directory name when mode is folder (browser rarely exposes full path). */
  folderName?: string
}

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null
  const star = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = header.match(/filename="([^"]+)"/i) ?? header.match(/filename=([^;]+)/i)
  return plain?.[1]?.trim() ?? null
}

async function fetchArtifactBlob(
  runId: string,
  relativePath: string,
): Promise<{ blob: Blob; filename: string }> {
  const fallback = relativePath.split("/").pop() || "file"
  const res = await fetch(runArtifactDownloadPath(runId, relativePath), {
    credentials: "include",
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch (err: unknown) {
      console.error("[mia]", err)
    }
    throw new Error(detail || `Download failed (${res.status})`)
  }
  const blob = await res.blob()
  const filename =
    filenameFromContentDisposition(res.headers.get("content-disposition")) ?? fallback
  return { blob, filename }
}

export async function downloadRunArtifactFile(
  runId: string,
  relativePath: string,
): Promise<{ filename: string; bytes: number }> {
  const { blob, filename } = await fetchArtifactBlob(runId, relativePath)
  downloadBlob(blob, filename)
  return { filename, bytes: blob.size }
}

function canPickDirectory(): boolean {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"
}

async function ensureNestedDirectory(
  root: FileSystemDirectoryHandle,
  parts: readonly string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  return dir
}

async function writeRelativeFile(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  blob: Blob,
): Promise<void> {
  const parts = relativePath.replace(/^\/+/, "").split("/").filter(Boolean)
  const filename = parts.pop()
  if (!filename) throw new Error(`Invalid artifact path: ${relativePath}`)
  const dir = parts.length > 0 ? await ensureNestedDirectory(root, parts) : root
  const file = await dir.getFileHandle(filename, { create: true })
  const writable = await file.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
}

function isUserCancel(err: unknown): boolean {
  return (
    (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError")) ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "NotAllowedError"))
  )
}

/** User cancelled the folder picker — not a failure toast. */
export class WorkspaceSaveCancelled extends Error {
  constructor() {
    super("Save cancelled")
    this.name = "WorkspaceSaveCancelled"
  }
}

/**
 * Let the user choose a folder and write sandbox files there (preserving
 * relative paths). Falls back to per-file browser downloads when the
 * directory picker is unavailable.
 */
export async function downloadWorkspaceDiffFiles(
  runId: string,
  paths: string[],
): Promise<WorkspaceSaveResult> {
  if (paths.length === 0) {
    return { count: 0, bytes: 0, mode: "downloads" }
  }

  if (canPickDirectory()) {
    const pickDirectory = window.showDirectoryPicker
    if (!pickDirectory) {
      // Narrowing for TS — canPickDirectory already checked.
      throw new Error("Directory picker unavailable")
    }
    let root: FileSystemDirectoryHandle
    try {
      root = await pickDirectory({
        id: "mia-run-artifacts",
        mode: "readwrite",
        startIn: "downloads",
      })
    } catch (err) {
      if (isUserCancel(err)) throw new WorkspaceSaveCancelled()
      throw err
    }

    let bytes = 0
    for (const path of paths) {
      const { blob } = await fetchArtifactBlob(runId, path)
      await writeRelativeFile(root, path, blob)
      bytes += blob.size
    }
    return {
      count: paths.length,
      bytes,
      mode: "folder",
      folderName: root.name,
    }
  }

  // Legacy browsers: sequential <a download> into the default Downloads folder.
  let bytes = 0
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!
    const result = await downloadRunArtifactFile(runId, path)
    bytes += result.bytes
    if (i < paths.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  return { count: paths.length, bytes, mode: "downloads" }
}

export function formatWorkspaceSaveMessage(result: WorkspaceSaveResult): string {
  if (result.count === 0) return "Nothing to save"
  if (result.mode === "folder") {
    const where = result.folderName ? `“${result.folderName}”` : "the folder you chose"
    return result.count === 1
      ? `Saved 1 file to ${where}`
      : `Saved ${result.count} files to ${where}`
  }
  return result.count === 1
    ? "Saved 1 file to your Downloads folder"
    : `Saved ${result.count} files to your Downloads folder`
}
