/**
 * CatalogImportModal — import full sync configuration zip into SQLite.
 */

import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react"
import type { JSX } from "react"
import { useRef, useState } from "react"
import { api } from "../api"
import { ModalShell } from "../widgets/entity-registry/ModalShell"

export function CatalogImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [zipBase64, setZipBase64] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.importSyncCatalog>> | null>(null)

  async function readFile(file: File): Promise<void> {
    setErr(null)
    setPreview(null)
    setFileName(file.name)
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    setZipBase64(btoa(binary))
  }

  async function run(dryRun: boolean): Promise<void> {
    if (!zipBase64) return setErr("Select an export zip first")
    if (!reason.trim()) return setErr("Reason is required")
    setBusy(true)
    setErr(null)
    try {
      const result = await api.importSyncCatalog({ zipBase64, dryRun, reason: reason.trim() })
      setPreview(result)
      if (!dryRun && result.ok) onImported()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Import catalog snapshot"
      subtitle="Apply a mia-sync-export zip (entity-registry.json + sync-metadata). Repo deploy/sync files are never modified."
      icon={<Upload size={20} className="text-text-muted" />}
      onClose={onClose}
      size="default"
      widthClass="w-full max-w-3xl h-[min(88vh,900px)] min-h-[32rem]"
      footer={(
        <div className="ml-auto flex gap-2">
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs" onClick={() => void run(true)} disabled={busy || !zipBase64}>
            {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Validate
          </button>
          <button type="button" className="rounded bg-accent px-3 py-1.5 text-xs text-white" onClick={() => void run(false)} disabled={busy || !zipBase64}>
            Import
          </button>
        </div>
      )}
    >
      <div className="space-y-4 px-6 py-4">
        <input ref={inputRef} type="file" accept=".zip,application/zip" className="hidden" onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void readFile(file)
        }} />
        <button type="button" className="w-full rounded-lg border border-dashed border-border-subtle px-4 py-8 text-sm text-text-muted hover:bg-elevated/30" onClick={() => inputRef.current?.click()}>
          {fileName ? `Selected: ${fileName}` : "Choose mia-sync-export zip…"}
        </button>
        <label className="block text-sm">
          <span className="text-text-muted">Reason</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input mt-1 w-full text-sm" placeholder="Why are you applying this configuration?" />
        </label>
        {err && <p className="text-sm text-error">{err}</p>}
        {preview && (
          <div className={`rounded-lg border p-3 text-sm ${preview.ok ? "border-success/30 bg-success/5" : "border-error/30 bg-error/5"}`}>
            <div className="flex items-center gap-2 font-medium">
              {preview.ok ? <CheckCircle2 size={16} className="text-success" /> : <AlertTriangle size={16} className="text-error" />}
              {preview.preview.dryRun ? "Validation" : "Import"} {preview.ok ? "passed" : "failed"}
            </div>
            {preview.preview.errors.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-error">{preview.preview.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            )}
            {preview.ok && (
              <p className="mt-2 text-text-muted">
                environments {preview.preview.counts.environments} · flows {preview.preview.counts.flows} · entities {preview.preview.counts.entities}
                {preview.version ? ` · version ${preview.version.version}` : ""}
              </p>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
