/**
 * Unified tool execution card — collapsed summary + terminal I/O (chat + trace).
 *
 * Inspector (default): flat accordion dialect — no tree knees, no boxed chrome.
 * Chat (`surface="chat"`): bordered terminal card for the transcript.
 */

import { Check, ChevronRight, X } from "lucide-react"
import { useMemo, useState, type ReactNode, type RefObject } from "react"
import { isValidJsonText } from "../lib/events/trace-tool-schema"
import {
  buildExecSummary,
  execErrorCode,
  formatExecInput,
  resolveExecStatus,
  type ToolExecStatus,
} from "../lib/tool-execution"
import { CopyControl } from "./CopyControl"
import { InlinePeekText } from "./InlinePeekText"

function ExecStatusIcon({ status }: { status: ToolExecStatus }) {
  if (status === "error") {
    return <X size={13} strokeWidth={2.25} aria-hidden className="trace-exec__icon trace-exec__icon--error" />
  }
  if (status === "done") {
    return <Check size={13} strokeWidth={2.25} aria-hidden className="trace-exec__icon trace-exec__icon--ok" />
  }
  return (
    <span
      className={`trace-exec__icon trace-exec__icon--${status}`}
      aria-hidden
    />
  )
}

function TerminalOutput({
  text,
  isError,
  showReturnGlyph,
}: {
  text: string
  isError: boolean
  showReturnGlyph: boolean
}) {
  const trimmed = text.trim()
  if (!trimmed) return null
  const code = isError ? execErrorCode(trimmed) : null
  const isJson = !isError && isValidJsonText(trimmed)
  const body =
    isJson && trimmed.length < 240 ? (
      <pre className="trace-exec__output-pre">{trimmed}</pre>
    ) : (
      <InlinePeekText text={trimmed} className="trace-exec__output-pre" />
    )

  return (
    <div className={`trace-exec__output${isError ? " is-error" : " is-success"}`}>
      <div className="trace-exec__output-body">
        {showReturnGlyph && !isError ? (
          <span className="trace-exec__return" aria-hidden>
            ↳
          </span>
        ) : null}
        <div className="trace-exec__output-main">
          {isError && code ? (
            <div className="trace-exec__error-code">{code}</div>
          ) : null}
          {body}
        </div>
      </div>
    </div>
  )
}

export function ToolExecutionCard({
  toolName,
  argumentsValue,
  argsFormatted,
  resultText,
  errorText,
  status: statusProp,
  durationMs,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  summaryRef,
  className,
  surface = "inspector",
  trailing,
  footer,
}: {
  toolName: string
  argumentsValue: Record<string, unknown>
  argsFormatted?: string | null
  resultText?: string | null
  errorText?: string | null
  status?: ToolExecStatus
  durationMs?: number | null
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  summaryRef?: RefObject<HTMLButtonElement | null>
  className?: string
  /** Inspector = flat list; chat = bordered terminal card. */
  surface?: "inspector" | "chat"
  trailing?: ReactNode
  footer?: ReactNode
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen)
  const open = openProp ?? internalOpen

  function setOpen(next: boolean) {
    onOpenChange?.(next)
    if (openProp === undefined) setInternalOpen(next)
  }

  const status = resolveExecStatus(statusProp, errorText, resultText)
  const summary = useMemo(
    () =>
      buildExecSummary({
        toolName,
        status,
        argumentsValue,
        argsFormatted,
        resultText,
        errorText,
        durationMs,
      }),
    [toolName, status, argumentsValue, argsFormatted, resultText, errorText, durationMs],
  )
  const input = useMemo(
    () => formatExecInput(toolName, argumentsValue, argsFormatted),
    [toolName, argumentsValue, argsFormatted],
  )
  const showError = Boolean(errorText?.trim())
  const showResult = !showError && Boolean(resultText?.trim())
  const hasTerminalBody =
    Boolean(input.text.trim()) || showError || showResult || trailing || footer
  const canToggle = hasTerminalBody
  const isChat = surface === "chat"

  const rootClass = [
    "trace-exec",
    open ? "is-open" : "",
    isChat ? "trace-exec--chat" : "trace-exec--inspector",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ")

  return (
    <div className={rootClass}>
      {canToggle ? (
        <button
          ref={summaryRef}
          type="button"
          className="trace-exec__summary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ExecStatusIcon status={status} />
          <span className="trace-exec__verb">{summary.verb}</span>
          <span className="trace-exec__name">{summary.name}</span>
          {summary.detail ? (
            <span className="trace-exec__detail">({summary.detail})</span>
          ) : null}
          {summary.duration ? (
            <span className="trace-exec__duration">{summary.duration}</span>
          ) : null}
          <ChevronRight
            size={14}
            className={`trace-exec__chev${open ? " is-open" : ""}`}
            aria-hidden
          />
        </button>
      ) : (
        <div className="trace-exec__summary trace-exec__summary--static">
          <ExecStatusIcon status={status} />
          <span className="trace-exec__verb">{summary.verb}</span>
          <span className="trace-exec__name">{summary.name}</span>
          {summary.detail ? (
            <span className="trace-exec__detail">({summary.detail})</span>
          ) : null}
        </div>
      )}

      {open && hasTerminalBody ? (
        <div className="trace-exec__terminal">
          {input.text.trim() ? (
            <div className="trace-exec__input">
              <div className="trace-exec__lane-head">
                <span className="trace-exec__lane-label">
                  {input.lang ? input.lang.toUpperCase() : "Input"}
                </span>
                <CopyControl value={input.copyText} ariaLabel="Copy input" />
              </div>
              <pre className="trace-exec__input-pre">{input.text}</pre>
            </div>
          ) : null}

          {showError || showResult ? (
            <div className="trace-exec__output-lane">
              <div className="trace-exec__lane-head">
                <span className="trace-exec__lane-label">Output</span>
              </div>
              {showError && errorText ? (
                <TerminalOutput text={errorText} isError showReturnGlyph={isChat} />
              ) : null}
              {showResult && resultText ? (
                <TerminalOutput text={resultText} isError={false} showReturnGlyph={isChat} />
              ) : null}
            </div>
          ) : null}

          {trailing ? <div className="trace-exec__trailing">{trailing}</div> : null}
          {footer ? <div className="trace-exec__footer">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}
