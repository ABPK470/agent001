/**
 * Tool execution UI — inspector (flat) vs chat (VS Code Copilot dialect).
 *
 * Chat collapsed:  [glyph] Ran  [command pill…]  ⌄
 * Chat expanded:   bordered panel — multi-line input (if any) + output only.
 *                  Single-line prompts stay on the summary pill (no duplicate).
 * Inspector:       flat accordion summary + indented lanes (trace detail).
 */

import {
  Check,
  ChevronRight,
  Database,
  FileCode,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react"
import { useMemo, useState, type ReactNode, type RefObject } from "react"
import { isValidJsonText } from "../lib/events/trace-tool-schema"
import {
  buildExecSummary,
  chatToolPillText,
  chatToolVerb,
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

function ChatToolGlyph({ toolName }: { toolName: string }) {
  const cls = "chat-tool__glyph"
  if (toolName === "run_command") {
    return <SquareTerminal size={14} strokeWidth={1.75} className={cls} aria-hidden />
  }
  if (toolName.includes("query") || toolName.includes("mssql") || toolName.includes("sql")) {
    return <Database size={14} strokeWidth={1.75} className={cls} aria-hidden />
  }
  if (
    toolName.includes("file") ||
    toolName.includes("directory") ||
    toolName.includes("dir")
  ) {
    return <FileCode size={14} strokeWidth={1.75} className={cls} aria-hidden />
  }
  return <Wrench size={14} strokeWidth={1.75} className={cls} aria-hidden />
}

function InspectorOutput({
  text,
  isError,
}: {
  text: string
  isError: boolean
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
  preview,
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
  /** Prefers args summary for the collapsed chat pill. */
  preview?: string | null
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  summaryRef?: RefObject<HTMLButtonElement | null>
  className?: string
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
  const inputText = input.text.trim()
  const hasOutputPayload =
    showError || showResult || Boolean(trailing) || Boolean(footer)
  const hasTerminalBody = Boolean(inputText) || hasOutputPayload
  const canToggle = hasTerminalBody
  const isChat = surface === "chat"
  const chatVerb = chatToolVerb(toolName, status, errorText)
  const chatPill = chatToolPillText(inputText, preview ?? summary.detail)
  // Pill already owns single-line prompts — expand body keeps multi-line input only.
  const showChatInputBody =
    Boolean(inputText) && (inputText.includes("\n") || !chatPill)
  const outputCopyText = (
    showError ? errorText : showResult ? resultText : ""
  )?.trim() ?? ""

  const rootClass = [
    isChat ? "chat-tool" : "trace-exec",
    open ? "is-open" : "",
    isChat ? "" : "trace-exec--inspector",
    status === "error" ? "is-error" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ")

  if (isChat) {
    return (
      <div className={rootClass}>
        {canToggle ? (
          <button
            ref={summaryRef}
            type="button"
            className="chat-tool__summary"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <ChatToolGlyph toolName={toolName} />
            <span className="chat-tool__verb">{chatVerb}</span>
            {chatPill ? <span className="chat-tool__pill">{chatPill}</span> : null}
            <span className="chat-tool__chev-slot" aria-hidden>
              <ChevronRight
                size={16}
                strokeWidth={1.5}
                className={`chat-tool__chev chat-trace-chev${open ? " is-open" : ""}`}
              />
            </span>
          </button>
        ) : (
          <div className="chat-tool__summary chat-tool__summary--static">
            <ChatToolGlyph toolName={toolName} />
            <span className="chat-tool__verb">{chatVerb}</span>
            {chatPill ? <span className="chat-tool__pill">{chatPill}</span> : null}
          </div>
        )}

        {open && hasTerminalBody ? (
          <div className="chat-tool__panel" data-chat-expand-body="">
            {showChatInputBody ? (
              <div className="chat-tool__cmd">
                <span className="chat-tool__dot" aria-hidden />
                <pre className="chat-tool__cmd-text">{inputText}</pre>
                <CopyControl value={input.copyText} ariaLabel="Copy input" iconOnly />
              </div>
            ) : null}

            {showError || showResult ? (
              <>
                {showChatInputBody ? <div className="chat-tool__sep" /> : null}
                <div className="chat-tool__cmd">
                  {showError && errorText ? (
                    <pre className="chat-tool__out is-error">{errorText.trim()}</pre>
                  ) : null}
                  {showResult && resultText ? (
                    resultText.trim().length > 480 ? (
                      <InlinePeekText
                        text={resultText.trim()}
                        className="chat-tool__out"
                      />
                    ) : (
                      <pre className="chat-tool__out">{resultText.trim()}</pre>
                    )
                  ) : null}
                  {outputCopyText ? (
                    <CopyControl
                      value={outputCopyText}
                      ariaLabel={showError ? "Copy error" : "Copy output"}
                      iconOnly
                    />
                  ) : null}
                </div>
              </>
            ) : !hasOutputPayload ? (
              <>
                {showChatInputBody ? <div className="chat-tool__sep" /> : null}
                <p className="chat-tool__empty">No output was produced.</p>
              </>
            ) : null}

            {trailing ? (
              <>
                {showChatInputBody && !showError && !showResult ? (
                  <div className="chat-tool__sep" />
                ) : null}
                <div className="chat-tool__trailing">{trailing}</div>
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    )
  }

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
                <InspectorOutput text={errorText} isError />
              ) : null}
              {showResult && resultText ? (
                <InspectorOutput text={resultText} isError={false} />
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
