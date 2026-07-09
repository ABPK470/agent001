/** Browser download helper — streams API responses to the user's machine. */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.click()
  URL.revokeObjectURL(url)
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

export async function downloadAuthenticated(
  path: string,
  fallbackFilename: string,
): Promise<{ filename: string; bytes: number }> {
  const res = await fetch(path, { credentials: "include" })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) detail = body.error
    } catch {
      /* ignore */
    }
    throw new Error(detail || `Download failed (${res.status})`)
  }
  const blob = await res.blob()
  const filename =
    filenameFromContentDisposition(res.headers.get("content-disposition")) ?? fallbackFilename
  downloadBlob(blob, filename)
  return { filename, bytes: blob.size }
}

export function traceExportFilename(runId: string, ext: "txt" | "json"): string {
  const dateTag = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `agent-loop-${dateTag}-${runId.slice(0, 8)}.${ext}`
}
