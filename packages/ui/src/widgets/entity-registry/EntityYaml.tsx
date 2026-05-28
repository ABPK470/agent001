/**
 * Registry document tab — operator-friendly copy/download surface for the
 * saved entity-registry record in either YAML or JSON.
 */

import { Copy, Download } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../api"
import type { EntityRegistryDefinition } from "../../types"

export interface EntityYamlProps {
  yaml: string
  def: EntityRegistryDefinition
  entityId: string
  isAdmin: boolean
}

export function EntityYaml({ yaml, def, entityId, isAdmin }: EntityYamlProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const [draftCopied, setDraftCopied] = useState(false)
  const [draftBusy, setDraftBusy] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
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

  async function loadDraftText(): Promise<{ text: string; fileName: string }> {
    setDraftBusy(true)
    setDraftError(null)
    try {
      const result = await api.getEntityRegistrySyncDefinitionScaffold(entityId)
      return {
        text: `${JSON.stringify(result.definition, null, 2)}\n`,
        fileName: result.suggestedPath.split("/").at(-1) ?? `${entityId}.json`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setDraftError(message)
      throw error
    } finally {
      setDraftBusy(false)
    }
  }

  function downloadFile(text: string, fileName: string) {
    const blob = new Blob([text], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    a.click()
    URL.revokeObjectURL(url)
  }

  async function copyDraft() {
    const { text } = await loadDraftText()
    await navigator.clipboard.writeText(text)
    setDraftCopied(true)
    setTimeout(() => setDraftCopied(false), 1200)
  }

  async function downloadDraft() {
    const { text, fileName } = await loadDraftText()
    downloadFile(text, fileName)
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
        {isAdmin && (
          <>
            <button
              type="button"
              onClick={() => void copyDraft()}
              disabled={draftBusy}
              className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
            >
              <Copy className="h-3 w-3" /> {draftCopied ? "Draft copied" : "Copy repo draft"}
            </button>
            <button
              type="button"
              onClick={() => void downloadDraft()}
              disabled={draftBusy}
              className="flex items-center gap-1 rounded border border-border-subtle px-2 py-1 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
            >
              <Download className="h-3 w-3" /> {draftBusy ? "Preparing draft..." : "Download repo draft"}
            </button>
          </>
        )}
      </div>
      <div className="rounded-lg border border-border-subtle bg-panel px-3 py-2 text-[11px] leading-6 text-text-muted">
        {format === "yaml"
          ? "This is the saved entity-registry document in YAML form. Importing YAML/JSON like this creates or updates the registry record stored by the server."
          : "This is the same saved registry record in JSON form."}
      </div>
      {isAdmin && (
        <div className="rounded-lg border border-border-subtle bg-panel px-3 py-2 text-[11px] leading-6 text-text-muted">
          Repo draft export scaffolds the authoritative `sync-definitions/entities/*.json` shape from this saved registry record. Review and edit that repo file before publish.
        </div>
      )}
      {draftError && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] leading-6 text-rose-300">
          {draftError}
        </div>
      )}
      <pre className="flex-1 overflow-auto rounded-lg border border-border-subtle bg-panel p-3 font-mono text-[11px] leading-relaxed text-text">{content || "…"}</pre>
    </div>
  )
}
