/**
 * Download run sandbox files to the user's machine (browser save dialog).
 * Workspace apply is separate — this is the always-available keep path.
 */

import { downloadAuthenticated } from "./userDownload"

export function runArtifactDownloadPath(runId: string, relativePath: string): string {
  const encoded = relativePath
    .replace(/^\/+/, "")
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/")
  return `/api/runs/${encodeURIComponent(runId)}/artifacts/${encoded}`
}

export async function downloadRunArtifactFile(
  runId: string,
  relativePath: string,
): Promise<{ filename: string; bytes: number }> {
  const fallback = relativePath.split("/").pop() || "file"
  return downloadAuthenticated(runArtifactDownloadPath(runId, relativePath), fallback)
}

/** Download added + modified files from a workspace diff (deleted have no bytes). */
export async function downloadWorkspaceDiffFiles(
  runId: string,
  paths: string[],
): Promise<{ count: number; bytes: number }> {
  let bytes = 0
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i]!
    const result = await downloadRunArtifactFile(runId, path)
    bytes += result.bytes
    // Browsers throttle multi-file downloads; brief gap keeps them flowing.
    if (i < paths.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
  return { count: paths.length, bytes }
}
