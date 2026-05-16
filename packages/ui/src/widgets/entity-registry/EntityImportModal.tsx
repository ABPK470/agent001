/**
 * EntityImportModal — admin-only bulk YAML import (single or multi-doc).
 * Supports dry-run validation before commit.
 */

import { AlertTriangle, CheckCircle2, Loader2, Upload } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../api"
import type { EntityRegistryYamlImportResponse } from "../../types"
import { ModalShell } from "./ModalShell"

export interface EntityImportModalProps {
  onClose: () => void
  onImported: () => void
}

export function EntityImportModal({ onClose, onImported }: EntityImportModalProps): JSX.Element {
  const [yaml, setYaml]     = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy]     = useState(false)
  const [err, setErr]       = useState<string | null>(null)
  const [result, setResult] = useState<EntityRegistryYamlImportResponse | null>(null)

  async function run(dryRun: boolean) {
    setErr(null); setResult(null)
    if (!yaml.trim())   return setErr("YAML body is required")
    if (!reason.trim()) return setErr("reason is required")
    setBusy(true)
    try {
      const r = await api.importEntityRegistryYaml(yaml, reason, { dryRun })
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
      title="Import entities from YAML"
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
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">Reason <span className="text-rose-400">*</span></span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className="input" placeholder="why this import" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">YAML (single or multi-doc)</span>
          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            rows={18}
            spellCheck={false}
            placeholder={"id: my-entity\ntenantId: _default\n..."}
            className="input font-mono text-[11px]"
          />
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
