/**
 * EntityImportModal — admin-only bulk YAML or JSON import.
 * Supports dry-run validation before commit.
 */

import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../api"
import type { EntityRegistryImportFormat, EntityRegistryYamlImportResponse } from "../../types"
import { ModalShell } from "./ModalShell"

export interface EntityImportModalProps {
  onClose: () => void
  onImported: () => void
}

export function EntityImportModal({ onClose, onImported }: EntityImportModalProps): JSX.Element {
  const [format, setFormat] = useState<EntityRegistryImportFormat>("yaml")
  const [content, setContent] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy]     = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [result, setResult] = useState<EntityRegistryYamlImportResponse | null>(null)

  async function run(dryRun: boolean) {
    setErr(null); setResult(null)
    if (!content.trim()) return setErr(`${format.toUpperCase()} body is required`)
    if (!reason.trim()) return setErr("reason is required")
    setBusy(true)
    try {
      const r = await api.importEntityRegistryDocument(content, format, reason, { dryRun })
      setResult(r)
      if (!dryRun && r.ok) onImported()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Import entities from YAML or JSON"
      icon={<Upload className="h-4 w-4 text-accent" />}
      onClose={onClose}
      widthClass="max-w-3xl"
      footer={
        <>
          {err && (
            <div className="flex items-center gap-2 text-xs text-rose-300">
              <AlertTriangle className="h-3 w-3" /> {err}
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => void run(true)}
              disabled={busy}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text disabled:opacity-50"
            >
              {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Dry-run"}
            </button>
            <button
              type="button"
              onClick={() => void run(false)}
              disabled={busy}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              Import
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-3 p-5 text-xs">
        <div className="space-y-1">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Format</span>
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
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Reason <span className="text-rose-400">*</span></span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="why this import" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">{format === "yaml" ? "YAML" : "JSON"} body</span>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={18}
            spellCheck={false}
            placeholder={format === "yaml"
              ? "id: my-entity\ntenantId: _default\n..."
              : '{\n  "id": "my-entity",\n  "tenantId": "_default"\n}'}
            className="input font-mono text-[11px]"
          />
          <p className="text-[11px] text-text-muted">
            {format === "yaml"
              ? "Accepts a single entity document or a multi-document YAML stream."
              : "Accepts either one entity object or an array of entity objects."}
          </p>
        </label>
        {result && <ResultPanel result={result} />}
      </div>
    </ModalShell>
  )
}

function ResultPanel({ result }: { result: EntityRegistryYamlImportResponse }) {
  return (
    <div className={`rounded-lg border p-3 ${result.ok ? "border-emerald-500/40 bg-emerald-500/5" : "border-rose-500/40 bg-rose-500/5"}`}>
      <div className="flex items-center gap-2 text-xs">
        {result.ok
          ? <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          : <AlertTriangle className="h-3 w-3 text-rose-400" />}
        <span className="text-text">
          {result.dryRun ? "Dry-run" : "Result"}: {result.saved.length} saved, {result.errors.length} error(s)
        </span>
      </div>
      {result.saved.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-text">
          {result.saved.map((s, i) => (
            <li key={i}>
              <span className="font-mono">{s.id}</span> → v{s.version} {s.created ? "(created)" : "(updated)"}
            </li>
          ))}
        </ul>
      )}
      {result.errors.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-[11px] text-rose-300">
          {result.errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono">{e.id ?? "<parse>"}</span>:{" "}
              {typeof e.error === "string" ? e.error : JSON.stringify(e.error.errors)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
