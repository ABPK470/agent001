/**
 * Save run sandbox files onto the user's machine.
 *
 * 1. Folder picker (File System Access) — user chooses destination, files written there.
 * 2. Else save-file picker for a zip (or single file).
 * 3. Else one zip via `<a download>` (fixed to actually land in Downloads).
 *
 * Multi-file `<a download>` loops were blocked by Chromium and also revoked
 * blob URLs immediately — toasts claimed success while Downloads stayed empty.
 */

import { zipSync } from "fflate"
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

export type WorkspaceSaveMode = "folder" | "file" | "downloads"

export interface WorkspaceSaveResult {
  count: number
  bytes: number
  mode: WorkspaceSaveMode
  /** Directory or file name when the picker path succeeded. */
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
  if (blob.size === 0) {
    throw new Error(`Artifact is empty: ${relativePath}`)
  }
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

function canPickSaveFile(): boolean {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function"
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

async function writeBlobWithSavePicker(blob: Blob, suggestedName: string): Promise<string> {
  const pick = window.showSaveFilePicker
  if (!pick) throw new Error("Save file picker unavailable")
  const handle = await pick({
    suggestedName,
    excludeAcceptAllOption: false,
  })
  const writable = await handle.createWritable()
  try {
    await writable.write(blob)
  } finally {
    await writable.close()
  }
  return handle.name
}

function isUserCancel(err: unknown): boolean {
  return (
    (err instanceof DOMException && (err.name === "AbortError" || err.name === "NotAllowedError")) ||
    (err instanceof Error && (err.name === "AbortError" || err.name === "NotAllowedError"))
  )
}

/** User cancelled the folder/file picker — not a failure toast. */
export class WorkspaceSaveCancelled extends Error {
  constructor() {
    super("Save cancelled")
    this.name = "WorkspaceSaveCancelled"
  }
}

function zipArtifactFiles(
  files: Array<{ path: string; bytes: Uint8Array }>,
): Uint8Array {
  const tree: Record<string, Uint8Array> = {}
  for (const file of files) {
    const key = file.path.replace(/^\/+/, "")
    tree[key] = file.bytes
  }
  return zipSync(tree, { level: 1 })
}

/**
 * Let the user choose where files go. Never claim success without a real write.
 */
export async function downloadWorkspaceDiffFiles(
  runId: string,
  paths: string[],
): Promise<WorkspaceSaveResult> {
  if (paths.length === 0) {
    return { count: 0, bytes: 0, mode: "downloads" }
  }

  // ── 1. Folder picker: write the relative tree where the user points ──
  if (canPickDirectory()) {
    const pickDirectory = window.showDirectoryPicker
    if (!pickDirectory) throw new Error("Directory picker unavailable")
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

  // Fetch once — used for zip / single-file save.
  const fetched: Array<{ path: string; blob: Blob; bytes: Uint8Array }> = []
  for (const path of paths) {
    const { blob } = await fetchArtifactBlob(runId, path)
    fetched.push({
      path,
      blob,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    })
  }
  const totalBytes = fetched.reduce((sum, f) => sum + f.blob.size, 0)

  // ── 2. Save-file picker: one file or one zip at a chosen path ──
  if (canPickSaveFile()) {
    try {
      if (fetched.length === 1) {
        const only = fetched[0]!
        const name = only.path.split("/").pop() || "file"
        const savedAs = await writeBlobWithSavePicker(only.blob, name)
        return { count: 1, bytes: totalBytes, mode: "file", folderName: savedAs }
      }
      const zipName = `mia-run-${runId.slice(0, 8)}-files.zip`
      const zipped = zipArtifactFiles(fetched.map((f) => ({ path: f.path, bytes: f.bytes })))
      const savedAs = await writeBlobWithSavePicker(
        new Blob([new Uint8Array(zipped)], { type: "application/zip" }),
        zipName,
      )
      return { count: fetched.length, bytes: totalBytes, mode: "file", folderName: savedAs }
    } catch (err) {
      if (isUserCancel(err)) throw new WorkspaceSaveCancelled()
      throw err
    }
  }

  // ── 3. Legacy: one zip via <a download> (multi a.download is blocked) ──
  if (fetched.length === 1) {
    const only = fetched[0]!
    const name = only.path.split("/").pop() || "file"
    downloadBlob(only.blob, name)
    return { count: 1, bytes: totalBytes, mode: "downloads", folderName: name }
  }
  const zipName = `mia-run-${runId.slice(0, 8)}-files.zip`
  const zipped = zipArtifactFiles(fetched.map((f) => ({ path: f.path, bytes: f.bytes })))
  downloadBlob(new Blob([new Uint8Array(zipped)], { type: "application/zip" }), zipName)
  return { count: fetched.length, bytes: totalBytes, mode: "downloads", folderName: zipName }
}

export function formatWorkspaceSaveMessage(result: WorkspaceSaveResult): string {
  if (result.count === 0) return "Nothing to save"
  if (result.mode === "folder") {
    const where = result.folderName ? `“${result.folderName}”` : "the folder you chose"
    return result.count === 1
      ? `Saved 1 file to ${where}`
      : `Saved ${result.count} files to ${where}`
  }
  if (result.mode === "file") {
    const name = result.folderName ? `“${result.folderName}”` : "the location you chose"
    return result.count === 1 ? `Saved to ${name}` : `Saved ${result.count} files as ${name}`
  }
  const name = result.folderName ? ` (${result.folderName})` : ""
  return result.count === 1
    ? `Saved 1 file to your Downloads folder${name}`
    : `Saved ${result.count} files as a zip to your Downloads folder${name}`
}
