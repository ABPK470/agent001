/**
 * Evidence envelopes — signed audit artifacts for sync runs.
 */

import { CheckCircle2, Download, FileCheck2, Loader2, XCircle } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../client/index"
import { timeAgo } from "../../lib/util"
import { ModalBtnSecondary } from "./chrome"
import { useConsole } from "./console-context"
import { DetailBody, DetailToolbar, Empty, ItemShell, RailEmpty, RailList, RailListItem } from "./shared"
import { DetailField, DetailGrid } from "../entity-registry/DetailField"
import { useLiveReload } from "./useLiveReload"

export interface EvidenceRow {
  id: string
  tenant_id: string
  plan_id: string
  proposal_id: string | null
  content_hash: string
  signature_alg: string
  signer_id: string
  signature: string
  pdf_path: string | null
  created_at: string
}

interface VerificationReport {
  ok: boolean
  message: string
  details?: Record<string, unknown>
}

export function EvidencePanel({ tabsToolbar }: { tabsToolbar?: ReactNode }): JSX.Element {
  const { notify, notifyError } = useConsole()
  const [items, setItems] = useState<EvidenceRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verify, setVerify] = useState<VerificationReport | null>(null)

  const chosen = useMemo(() => items.find((i) => i.id === selected) ?? null, [items, selected])

  const refresh = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const rows = await api.listEvidence({ limit: 200 })
      const typed = rows as unknown as EvidenceRow[]
      setItems(typed)
      setSelected((c) => (c && typed.some((r) => r.id === c) ? c : (typed[0]?.id ?? null)))
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [notifyError])

  useLiveReload(refresh, (t) => t.startsWith("sync.evidence") || t.startsWith("sync.run"))

  useEffect(() => { void refresh().catch((err: unknown) => { console.error("[mia]", err) }) }, [refresh])
  useEffect(() => { setVerify(null) }, [selected])

  async function doVerify(id: string): Promise<void> {
    setVerifying(true)
    try {
      const r = await api.verifyEvidence(id)
      setVerify(r as unknown as VerificationReport)
      notify((r as { ok?: boolean }).ok ? "Signature valid" : "Verification failed")
    } catch (e) {
      notifyError(e instanceof Error ? e.message : String(e))
    } finally {
      setVerifying(false)
    }
  }

  return (
    <ItemShell
      busy={busy}
      detailToolbar={(
        <>
          {tabsToolbar}
          {chosen ? (
            <DetailToolbar title={chosen.plan_id} subtitle={chosen.id} />
          ) : null}
        </>
      )}
      empty={items.length === 0 ? <RailEmpty title="No evidence yet" /> : undefined}
      list={(
        <RailList label="Evidence">
          {items.map((r) => (
            <RailListItem
              key={r.id}
              active={r.id === selected}
              onClick={() => setSelected(r.id)}
              title={r.plan_id}
              meta={`${r.signature_alg} · ${r.signer_id}`}
              meta2={timeAgo(r.created_at)}
            />
          ))}
        </RailList>
      )}
      detail={
        chosen ? (
          <DetailBody>
            <DetailGrid>
              <DetailField label="Plan" value={chosen.plan_id} mono />
              <DetailField label="Signer" value={chosen.signer_id} />
              <DetailField label="Hash" value={`${chosen.content_hash.slice(0, 24)}…`} mono span={2} />
            </DetailGrid>
            <div className="mt-4 flex flex-wrap gap-2 border-t border-border-subtle pt-3">
              <a href={api.evidenceEnvelopeUrl(chosen.id)} download className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs hover:bg-elevated">
                <Download size={12} /> envelope.json
              </a>
              {chosen.pdf_path && (
                <a href={api.evidencePdfUrl(chosen.id)} download className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-xs hover:bg-elevated">
                  <Download size={12} /> evidence.pdf
                </a>
              )}
              <ModalBtnSecondary onClick={() => void doVerify(chosen.id).catch((err: unknown) => { console.error("[mia]", err) })} disabled={verifying || busy}>
                {verifying ? <Loader2 size={12} className="animate-spin" /> : <FileCheck2 size={12} />}
                Verify
              </ModalBtnSecondary>
            </div>
            {verify && (
              <div className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${verify.ok ? "border-success/30 text-success" : "border-error/30 text-error"}`}>
                {verify.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                <span>{verify.message}</span>
              </div>
            )}
          </DetailBody>
        ) : (
          <Empty title="Select an envelope" />
        )
      }
    />
  )
}
