/**
 * DeployArtifactImportModal — import deploy/sync git layout zip (format A → B bulk).
 */

import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react"
import type { JSX } from "react"
import { useRef, useState } from "react"
import { api } from "../api"
import { ModalShell } from "../widgets/entity-registry/ModalShell"

export function DeployArtifactImportModal({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [zipBase64, setZipBase64] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.importDeployArtifacts>> | null>(null)

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
    if (!zipBase64) return setErr("Select a deploy artifacts zip first")
    setBusy(true)
    setErr(null)
    try {
      const result = await api.importDeployArtifacts({ zipBase64, dryRun })
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
      title="Import deploy artifacts"
      subtitle="Apply a mia-deploy-artifacts zip (artifacts/entities/*.json + sync-metadata). Does not factory-reset SQLite."
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
          {fileName ? fileName : "Choose mia-deploy-artifacts zip"}
        </button>
        {err && <p className="text-sm text-error">{err}</p>}
        {preview?.preview && (
          <div className={`rounded-lg border px-3 py-2 text-sm ${preview.ok ? "border-success/30 text-text" : "border-error/30 text-error"}`}>
            {preview.ok ? <CheckCircle2 className="mr-1 inline h-4 w-4 text-success" /> : <AlertTriangle className="mr-1 inline h-4 w-4" />}
            Entities: {preview.preview.counts.entities}
            {preview.preview.errors.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {preview.preview.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
