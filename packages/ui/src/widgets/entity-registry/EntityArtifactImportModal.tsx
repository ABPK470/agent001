/**
 * EntityArtifactImportModal — import deploy artifact JSON (format A → B).
 */

import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react"
import type { JSX } from "react"
import { useRef, useState } from "react"
import { api } from "../../client/index"
import { ModalShell } from "./ModalShell"

export interface EntityArtifactImportModalProps {
  entityId?: string
  onClose: () => void
  onImported: () => void
}

export function EntityArtifactImportModal({
  entityId,
  onClose,
  onImported,
}: EntityArtifactImportModalProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [json, setJson] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.importEntityDeployArtifact>> | null>(null)

  async function readFile(file: File): Promise<void> {
    setErr(null)
    setPreview(null)
    setFileName(file.name)
    setJson(await file.text())
  }

  async function run(dryRun: boolean): Promise<void> {
    if (!json) return setErr("Select a deploy artifact JSON file first")
    if (!reason.trim()) return setErr("Reason is required")
    setBusy(true)
    setErr(null)
    try {
      const result = await api.importEntityDeployArtifact(json, reason.trim(), { dryRun })
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
      title="Import deploy artifact"
      subtitle={
        entityId
          ? `Apply ${entityId}.json (AuthoredSyncDefinition) into SQLite. Registry YAML/JSON is a separate import path.`
          : "Apply deploy/sync/artifacts/entities/*.json into SQLite."
      }
      icon={<Upload size={20} className="text-text-muted" />}
      onClose={onClose}
      size="default"
      widthClass="w-full max-w-3xl h-[min(88vh,900px)] min-h-[32rem]"
      footer={(
        <div className="ml-auto flex gap-2">
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="rounded border border-border-subtle px-3 py-1.5 text-xs" onClick={() => void run(true)} disabled={busy || !json}>
            {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Validate
          </button>
          <button type="button" className="rounded bg-accent px-3 py-1.5 text-xs text-white" onClick={() => void run(false)} disabled={busy || !json}>
            Import
          </button>
        </div>
      )}
    >
      <div className="space-y-4 px-6 py-4">
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void readFile(file)
          }}
        />
        <button
          type="button"
          className="w-full rounded-lg border border-dashed border-border-subtle px-4 py-8 text-sm text-text-muted hover:bg-elevated/30"
          onClick={() => inputRef.current?.click()}
        >
          {fileName ? fileName : "Choose deploy artifact JSON"}
        </button>
        <label className="block text-xs text-text-muted">
          Reason
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mt-1 w-full rounded border border-border-subtle bg-surface px-3 py-2 text-sm text-text"
            placeholder="Why are you importing this artifact?"
          />
        </label>
        {err && <p className="text-sm text-error">{err}</p>}
        {preview && (
          <div className={`rounded-lg border px-3 py-2 text-sm ${preview.ok ? "border-success/30 text-text" : "border-error/30 text-error"}`}>
            {preview.ok ? <CheckCircle2 className="mr-1 inline h-4 w-4 text-success" /> : <AlertTriangle className="mr-1 inline h-4 w-4" />}
            {preview.dryRun ? "Validation" : "Import"}: {preview.saved.length} saved
            {preview.errors.length > 0 ? `, ${preview.errors.length} error(s)` : ""}
            {preview.errors.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs">
                {preview.errors.map((item, index) => (
                  <li key={index}>{item.id ?? "unknown"}: {typeof item.error === "string" ? item.error : "validation failed"}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
