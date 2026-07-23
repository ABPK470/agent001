/**
 * Browser save helpers — blob download must actually reach the user's disk.
 * Chromium silently ignores `<a download>` when the node is not in the DOM
 * or the object URL is revoked before the download starts.
 */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = filename
  anchor.rel = "noopener"
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  // Revoke after the browser has started the download — immediate revoke
  // cancels the transfer and leaves Downloads empty while callers toast success.
  window.setTimeout(() => {
    anchor.remove()
    URL.revokeObjectURL(url)
  }, 2_000)
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

/** Fetch an authenticated API path and save the response on the user's machine. */
export async function downloadAuthenticated(
  path: string,
  fallbackFilename: string,
  opts?: RequestInit,
): Promise<{ filename: string; bytes: number }> {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string> | undefined) }
  if (opts?.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json"
  const signal = opts?.signal ?? AbortSignal.timeout(60_000)
  const res = await fetch(path, { ...opts, headers, credentials: "include", signal })
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
    filenameFromContentDisposition(res.headers.get("content-disposition")) ?? fallbackFilename
  downloadBlob(blob, filename)
  return { filename, bytes: blob.size }
}
