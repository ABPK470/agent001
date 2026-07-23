/**
 * Save run sandbox files the same way as /trace: fetch → blob → browser download.
 * Multi-file diffs become a single zip. No folder picker.
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

export type WorkspaceSaveMode = "downloads"

export interface WorkspaceSaveResult {
  count: number
  bytes: number
  mode: WorkspaceSaveMode
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

/** Kept for call-site cancel handling — unused now that there is no picker. */
export class WorkspaceSaveCancelled extends Error {
  constructor() {
    super("Save cancelled")
    this.name = "WorkspaceSaveCancelled"
  }
}

/**
 * Download sandbox files like /trace: one save into the browser Downloads
 * folder (or the browser's default download destination).
 */
export async function downloadWorkspaceDiffFiles(
  runId: string,
  paths: string[],
): Promise<WorkspaceSaveResult> {
  if (paths.length === 0) {
    return { count: 0, bytes: 0, mode: "downloads" }
  }

  if (paths.length === 1) {
    const only = paths[0]!
    const { blob, filename } = await fetchArtifactBlob(runId, only)
    downloadBlob(blob, filename)
    return { count: 1, bytes: blob.size, mode: "downloads", folderName: filename }
  }

  const tree: Record<string, Uint8Array> = {}
  let bytes = 0
  for (const path of paths) {
    const { blob } = await fetchArtifactBlob(runId, path)
    const key = path.replace(/^\/+/, "")
    tree[key] = new Uint8Array(await blob.arrayBuffer())
    bytes += blob.size
  }
  const zipped = zipSync(tree, { level: 1 })
  const zipName = `mia-run-${runId.slice(0, 8)}-files.zip`
  downloadBlob(new Blob([new Uint8Array(zipped)], { type: "application/zip" }), zipName)
  return { count: paths.length, bytes, mode: "downloads", folderName: zipName }
}

export function formatWorkspaceSaveMessage(result: WorkspaceSaveResult): string {
  if (result.count === 0) return "Nothing to save"
  const name = result.folderName ? ` (${result.folderName})` : ""
  if (result.count === 1) {
    return `Downloaded 1 file${name} — check your browser Downloads`
  }
  return `Downloaded ${result.count} files as a zip${name} — check your browser Downloads`
}
