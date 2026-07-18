/**
 * Universal platform import gate — validate → impact → reason → apply.
 * Kind-specific surfaces pass thin validate/apply adapters only.
 */

import { Loader2, Upload } from "lucide-react"
import { useRef, useState, type JSX } from "react"
import type { PlatformImportGateResult } from "@mia/shared-types"
import {
  canApply,
  canValidate,
  fingerprintPayload,
} from "../../lib/import-gate"
import { ModalShell } from "../entity-registry/ModalShell"
import { TEXT_BTN, TEXT_BTN_PRIMARY } from "../entity-registry/chrome"
import { ImportImpactPanel } from "./ImportImpactPanel"

export type ImportGateSession = {
  fileName: string | null
  payload: string | null
  fingerprint: string | null
  reason: string
  preview: PlatformImportGateResult | null
  previewFingerprint: string | null
  busy: boolean
  err: string | null
}

function emptySession(): ImportGateSession {
  return {
    fileName: null,
    payload: null,
    fingerprint: null,
    reason: "",
    preview: null,
    previewFingerprint: null,
    busy: false,
    err: null,
  }
}

export function ImportGateModal({
  title,
  subtitle,
  accept,
  fileLabel,
  applyLabel = "Import",
  validate,
  apply,
  onApplied,
  onClose,
  fixedPayload,
  fixedPayloadLabel,
  stackLevel = 0,
}: {
  title: string
  subtitle: string
  accept?: string
  fileLabel: string
  applyLabel?: string
  validate: (payload: string, reason: string) => Promise<PlatformImportGateResult>
  apply: (payload: string, reason: string) => Promise<PlatformImportGateResult>
  onApplied: () => void
  onClose: () => void
  /** When set, skip file picker (e.g. catalog rollback version id). */
  fixedPayload?: string
  fixedPayloadLabel?: string
  stackLevel?: number
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [session, setSession] = useState<ImportGateSession>(() => {
    if (fixedPayload != null) {
      return {
        ...emptySession(),
        fileName: fixedPayloadLabel ?? "restore",
        payload: fixedPayload,
        fingerprint: fingerprintPayload(fixedPayload),
      }
    }
    return emptySession()
  })

  function patch(fields: Partial<ImportGateSession>): void {
    setSession((current) => ({ ...current, ...fields }))
  }

  async function readFile(file: File): Promise<void> {
    const buffer = await file.arrayBuffer()
    const bytes = new Uint8Array(buffer)
    let binary = ""
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
    const isZip = file.name.endsWith(".zip") || file.type.includes("zip")
    const payload = isZip ? btoa(binary) : new TextDecoder().decode(bytes)
    patch({
      fileName: file.name,
      payload,
      fingerprint: fingerprintPayload(payload),
      preview: null,
      previewFingerprint: null,
      err: null,
    })
  }

  async function onValidate(): Promise<void> {
    if (!session.payload || !canValidate(session.payload)) {
      patch({ err: "Select a file first" })
      return
    }
    patch({ busy: true, err: null })
    try {
      const preview = await validate(session.payload, session.reason)
      patch({
        preview,
        previewFingerprint: session.fingerprint,
        busy: false,
        err: preview.ok ? null : preview.errors[0] ?? "Validation failed",
      })
    } catch (error) {
      patch({
        busy: false,
        preview: null,
        previewFingerprint: null,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function onApply(): Promise<void> {
    if (
      !session.payload ||
      !canApply({
        preview: session.preview,
        payloadFingerprint: session.previewFingerprint,
        currentFingerprint: session.fingerprint,
        reason: session.reason,
      })
    ) {
      patch({ err: "Validate successfully and enter a reason before applying." })
      return
    }
    patch({ busy: true, err: null })
    try {
      const result = await apply(session.payload, session.reason.trim())
      patch({ preview: result, busy: false })
      if (result.ok && result.applied) onApplied()
      else patch({ err: result.errors[0] ?? "Import failed" })
    } catch (error) {
      patch({
        busy: false,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const applyEnabled = canApply({
    preview: session.preview,
    payloadFingerprint: session.previewFingerprint,
    currentFingerprint: session.fingerprint,
    reason: session.reason,
  })

  return (
    <ModalShell
      title={title}
      subtitle={subtitle}
      icon={<Upload size={20} className="text-text-muted" />}
      onClose={onClose}
      size="default"
      stackLevel={stackLevel}
      widthClass="w-full max-w-3xl h-[min(88vh,900px)] min-h-[32rem]"
      footer={(
        <div className="ml-auto flex gap-2">
          <button type="button" className={TEXT_BTN} onClick={onClose} disabled={session.busy}>
            Cancel
          </button>
          <button
            type="button"
            className={TEXT_BTN}
            onClick={() => void onValidate()}
            disabled={session.busy || !canValidate(session.payload)}
          >
            {session.busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null} Validate
          </button>
          <button
            type="button"
            className={TEXT_BTN_PRIMARY}
            onClick={() => void onApply()}
            disabled={session.busy || !applyEnabled}
            title={
              applyEnabled
                ? applyLabel
                : "Validate successfully and enter a reason before applying"
            }
          >
            {applyLabel}
          </button>
        </div>
      )}
    >
      <div className="space-y-4 px-6 py-4">
        {fixedPayload == null ? (
          <>
            <input
              ref={inputRef}
              type="file"
              accept={accept}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void readFile(file)
              }}
            />
            <button
              type="button"
              className="w-full rounded-lg border border-dashed border-border-subtle px-4 py-8 text-sm text-text-muted hover:bg-elevated/30"
              onClick={() => inputRef.current?.click()}
            >
              {session.fileName ? `Selected: ${session.fileName}` : fileLabel}
            </button>
          </>
        ) : (
          <div className="rounded-lg border border-border-subtle px-4 py-3 text-sm text-text-muted">
            {fixedPayloadLabel ?? `Restore payload: ${fixedPayload}`}
          </div>
        )}
        <label className="block text-sm">
          <span className="text-text-muted">Reason</span>
          <input
            value={session.reason}
            onChange={(event) => patch({ reason: event.target.value })}
            className="input mt-1 w-full text-sm"
            placeholder="Why are you applying this configuration?"
          />
        </label>
        {session.err && <p className="text-sm text-error">{session.err}</p>}
        {session.preview && <ImportImpactPanel result={session.preview} />}
        {!session.preview && (
          <p className="text-xs text-text-faint">
            Run Validate to see creates, overwrites, and errors. {applyLabel} stays disabled until
            validation succeeds for the current file and a reason is entered.
          </p>
        )}
      </div>
    </ModalShell>
  )
}
