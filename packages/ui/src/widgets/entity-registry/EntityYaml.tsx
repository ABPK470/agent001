/**
 * Registry document tab — operator-friendly copy/download surface for the
 * saved entity-registry record in either YAML or JSON. The authoring tab
 * only previews a separate sync-definition export and does not persist it.
 */

import { Copy, Download } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import type { EntityRegistryDefinition } from "../../types"

export interface EntityYamlProps {
  yaml: string
  def: EntityRegistryDefinition
  entityId: string
}

export function EntityYaml({ yaml, def, entityId }: EntityYamlProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [format, setFormat] = useState<"yaml" | "json">("yaml")

  const content = format === "yaml" ? yaml : `${JSON.stringify(def, null, 2)}\n`

  function doCopy() {
    void navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  function doDownload() {
    const blob = new Blob([content], { type: format === "yaml" ? "application/yaml" : "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${entityId}.${format}`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <div className="inline-flex rounded-lg border border-border-subtle bg-panel p-0.5">
          {(["yaml", "json"] as const).map((next) => (
            <button
              key={next}
              type="button"
              onClick={() => setFormat(next)}
              className={`rounded-md px-3 py-1.5 text-xs transition-colors ${format === next ? "bg-accent/15 text-accent font-medium" : "text-text-muted hover:text-text"}`}
            >
              {next.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="text-text-muted">
          Saved registry record for <span className="font-mono text-text">{entityId}</span>
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
          <Download className="h-3 w-3" /> Download {format.toUpperCase()}
        </button>
      </div>
      <div className="rounded-lg border border-border-subtle bg-panel px-3 py-2 text-[11px] leading-6 text-text-muted">
        {format === "yaml"
          ? "This is the saved entity-registry document in YAML form. Importing YAML/JSON like this creates or updates the registry record stored by the server."
          : "This is the same saved registry record in JSON form. It is not the sync-definition export used by the Sync JSON tab."}
      </div>
      <pre className="flex-1 overflow-auto rounded-lg border border-border-subtle bg-panel p-3 font-mono text-[11px] leading-relaxed text-text">{content || "…"}</pre>
    </div>
  )
}
