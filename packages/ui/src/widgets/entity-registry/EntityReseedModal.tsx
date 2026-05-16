/**
 * EntityReseedModal — admin-only "re-seed from disk" confirmation.
 *
 * Re-runs the on-boot bootstrap importer against `deploy/mssql/entities/`.
 * Add-missing-only semantics — never overwrites an existing definition.
 * Use the YAML import modal with the file body to force a re-import of
 * entities that already exist.
 */

import { AlertTriangle, CheckCircle2, Loader2, RefreshCcw } from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { api } from "../../api"
import { ModalShell } from "./ModalShell"

export interface EntityReseedModalProps {
  onClose: () => void
  onCompleted: () => void
}

interface ReseedResult { imported: number; skipped: number; errors: string[] }

export function EntityReseedModal({ onClose, onCompleted }: EntityReseedModalProps): JSX.Element {
  const [busy, setBusy]   = useState(false)
  const [err,  setErr]    = useState<string | null>(null)
  const [out,  setOut]    = useState<ReseedResult | null>(null)

  async function run() {
    setErr(null); setBusy(true)
    try {
      const r = await api.reseedEntityRegistry()
      setOut(r)
      if (r.imported > 0) onCompleted()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell
      title="Re-seed entities from disk"
      icon={<RefreshCcw className="h-4 w-4 text-accent" />}
      onClose={onClose}
      widthClass="max-w-xl"
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
              onClick={onClose}
              className="rounded border border-border-subtle px-3 py-1.5 text-xs text-text-muted hover:bg-overlay-2 hover:text-text"
            >Close</button>
            <button
              type="button"
              onClick={() => void run()}
              disabled={busy}
              className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs font-medium text-text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
              Re-seed now
            </button>
          </div>
        </>
      }
    >
      <div className="space-y-3 p-5 text-xs text-text">
        <p>
          Re-runs the boot-time importer against{" "}
          <span className="font-mono text-text-muted">deploy/mssql/entities/</span>.
        </p>
        <ul className="space-y-1 text-text-muted">
          <li>• <span className="text-text">Add-missing only</span> — never overwrites an existing entity.</li>
          <li>• To force a re-import of an existing entity, use <span className="text-text">Import YAML</span> with the file body.</li>
          <li>• Idempotent — safe to run repeatedly.</li>
        </ul>
        {out && (
          <div className={`rounded-lg border p-3 ${out.errors.length === 0 ? "border-emerald-500/40 bg-emerald-500/5" : "border-amber-500/40 bg-amber-500/5"}`}>
            <div className="flex items-center gap-2">
              {out.errors.length === 0
                ? <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                : <AlertTriangle className="h-3 w-3 text-amber-300" />}
              <span className="text-text">
                Imported {out.imported} · skipped {out.skipped} · {out.errors.length} error(s)
              </span>
            </div>
            {out.errors.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px] text-rose-300">
                {out.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}
      </div>
    </ModalShell>
  )
}
