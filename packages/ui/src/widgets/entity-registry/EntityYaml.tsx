/**
 * YAML tab — server-rendered, syntax-friendly pre block + download +
 * copy-to-clipboard convenience for the registry draft format. The
 * authoring tab covers repo-definition draft export.
 */

import { Copy, Download } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"

export interface EntityYamlProps {
  yaml: string
  entityId: string
}

export function EntityYaml({ yaml, entityId }: EntityYamlProps): JSX.Element {
  const [copied, setCopied] = useState(false)

  function doCopy() {
    void navigator.clipboard.writeText(yaml).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  function doDownload() {
    const blob = new Blob([yaml], { type: "application/yaml" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entityId}.yaml`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-text-muted">
          Server-rendered YAML for <span className="font-mono text-text">{entityId}</span>
        </span>
        <button
          type="button"
          onClick={doCopy}
          className="ml-auto flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
        >
          <Copy className="h-3 w-3" />
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          type="button"
          onClick={doDownload}
          className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
        >
          <Download className="h-3 w-3" /> Download
        </button>
      </div>
      <pre className="flex-1 overflow-auto rounded-lg border border-border-subtle bg-panel p-3 font-mono text-[11px] leading-relaxed text-text">{yaml || "…"}</pre>
    </div>
  )
}
