/**
 * SyncEvidence — F1.8 dashboard widget.
 *
 * Surfaces signed evidence envelopes with download links + server-side
 * verification. The standalone offline verifier (`scripts/verify-evidence.mjs`)
 * complements this in-app view for auditors.
 */

import {
  AlertCircle, CheckCircle2, Download, FileCheck2, FileText, Loader2,
  RefreshCw, ShieldCheck, X,
} from "lucide-react"
import type { JSX } from "react"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api"
import { timeAgo } from "../util"

interface EvidenceRow {
  id:             string
  tenant_id:      string
  plan_id:        string
  proposal_id:    string | null
  envelope_path:  string
  pdf_path:       string | null
  content_hash:   string
  signature_alg:  string
  signer_id:      string
  signature:      string
  created_at:     string
}

interface VerificationReport {
  code:     number
  ok:       boolean
  message:  string
  details?: Record<string, unknown>
}

export function SyncEvidence(): JSX.Element {
  const [items, setItems]   = useState<EvidenceRow[]>([])
  const [selId, setSelId]   = useState<string | null>(null)
  const [busy,  setBusy]    = useState(false)
  const [err,   setErr]     = useState<string | null>(null)
  const [verifyById, setVerifyById] = useState<Record<string, VerificationReport>>({})
  const [verifyingId, setVerifyingId] = useState<string | null>(null)

  const selected = useMemo(() => items.find((i) => i.id === selId) ?? null, [items, selId])

  async function refresh(): Promise<void> {
    setBusy(true); setErr(null)
    try {
      const rows = await api.listEvidence({ limit: 200 })
      const typed = rows as unknown as EvidenceRow[]
      setItems(typed)
      if (!selId && typed.length > 0) setSelId(typed[0]!.id)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { void refresh() }, [])

  async function verify(id: string): Promise<void> {
    setVerifyingId(id)
    try {
      const r = await api.verifyEvidence(id)
      setVerifyById((m) => ({ ...m, [id]: r as unknown as VerificationReport }))
    } catch (e) {
      setVerifyById((m) => ({ ...m, [id]: { code: -1, ok: false, message: e instanceof Error ? e.message : String(e) } }))
    } finally {
      setVerifyingId(null)
    }
  }

  return (
    <div className="h-full flex flex-col text-sm">
      <div className="flex items-center gap-2 p-2 border-b border-slate-800 text-xs">
        <button onClick={refresh} className="btn-ghost" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" size={14}/> : <RefreshCw size={14}/>}
        </button>
        <span className="text-slate-400">{items.length} envelopes</span>
      </div>
      {err && <div className="px-3 py-1 text-red-300 bg-red-900/30 border-y border-red-800/40 text-xs flex gap-2 items-center"><AlertCircle size={14}/>{err}<button onClick={() => setErr(null)} className="ml-auto"><X size={14}/></button></div>}
      <div className="flex-1 min-h-0 grid grid-cols-[minmax(280px,360px)_1fr] gap-2 p-2">
        <ul className="overflow-y-auto border border-slate-800 rounded divide-y divide-slate-800">
          {items.map((r) => {
            const sel = r.id === selId
            const v = verifyById[r.id]
            return (
              <li key={r.id}>
                <button onClick={() => setSelId(r.id)}
                  className={`w-full text-left px-3 py-2 hover:bg-slate-800/60 ${sel ? "bg-slate-800/80" : ""}`}>
                  <div className="flex items-center gap-2">
                    <FileText size={12}/>
                    <span className="font-mono text-[11px] truncate">{r.plan_id}</span>
                    <span className="ml-auto text-[11px] text-slate-500">{timeAgo(r.created_at)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-500 flex gap-2 items-center">
                    <span>{r.signature_alg}</span><span>·</span><span className="truncate">{r.signer_id}</span>
                    {v && (v.ok
                      ? <CheckCircle2 size={12} className="ml-auto text-emerald-400" />
                      : <AlertCircle  size={12} className="ml-auto text-red-400" />)}
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
        <div className="overflow-y-auto border border-slate-800 rounded p-3 space-y-3 text-xs">
          {selected ? (
            <>
              <header className="flex items-center gap-2">
                <ShieldCheck size={14}/>
                <span className="font-mono">{selected.plan_id}</span>
                <span className="ml-auto text-slate-500">{timeAgo(selected.created_at)}</span>
              </header>
              <Row label="evidence id">{selected.id}</Row>
              <Row label="tenant">{selected.tenant_id}</Row>
              <Row label="proposal">{selected.proposal_id ?? "—"}</Row>
              <Row label="signer">{selected.signer_id} ({selected.signature_alg})</Row>
              <Row label="content hash"><span className="font-mono break-all">{selected.content_hash}</span></Row>
              <Row label="signature"><span className="font-mono break-all text-[10px]">{selected.signature.slice(0, 96)}…</span></Row>
              <div className="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
                <a href={api.evidenceEnvelopeUrl(selected.id)} download
                   className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 flex items-center gap-1">
                  <Download size={12}/> envelope.json
                </a>
                {selected.pdf_path && (
                  <a href={api.evidencePdfUrl(selected.id)} download
                     className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 flex items-center gap-1">
                    <Download size={12}/> evidence.pdf
                  </a>
                )}
                <button onClick={() => verify(selected.id)} disabled={verifyingId === selected.id}
                  className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 flex items-center gap-1">
                  {verifyingId === selected.id ? <Loader2 className="animate-spin" size={12}/> : <FileCheck2 size={12}/>} Verify
                </button>
              </div>
              {verifyById[selected.id] && (
                <pre className="mt-2 p-2 bg-slate-900 border border-slate-800 rounded text-[11px] whitespace-pre-wrap">
{JSON.stringify(verifyById[selected.id], null, 2)}
                </pre>
              )}
            </>
          ) : (
            <div className="text-slate-500">select an envelope</div>
          )}
        </div>
      </div>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-2">
      <span className="text-slate-500">{label}</span>
      <span>{children}</span>
    </div>
  )
}
