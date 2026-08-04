/**
 * Structured tool I/O — Input → Result/Error → trailing → Schema (muted, last).
 */

import { ChevronRight } from "lucide-react"
import { useMemo, useState, type ReactNode } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import {
  isValidJsonText,
  validateToolArguments,
  type ToolSchemaValidation,
} from "../../lib/events/trace-tool-schema"
import type { TraceDag } from "./build-trace-dag"
import { TraceErrorBlock } from "./TraceErrorBlock"

export type TraceToolIoLayout = "standard" | "developer"

export function TraceToolIo({
  dag,
  toolName,
  argumentsValue,
  resultText,
  errorText,
  resultLabel = "Result",
  layout = "standard",
  hideResult = false,
  trailing,
}: {
  dag: TraceDag
  toolName: string
  argumentsValue: Record<string, unknown>
  resultText?: string | null
  /** When set, renders Error section (same chrome as Result) instead of Result. */
  errorText?: string | null
  resultLabel?: string
  /** `developer` — collapsible payload/schema (human-first layouts like ask_user). */
  layout?: TraceToolIoLayout
  /** Suppress result when shown elsewhere (e.g. ask_user interaction card). */
  hideResult?: boolean
  /** Between Result/Error and Schema — e.g. SQL validation. */
  trailing?: ReactNode
}) {
  const [payloadOpen, setPayloadOpen] = useState(layout === "standard")
  const [schemaOpen, setSchemaOpen] = useState(false)
  const validation = useMemo(
    () => validateToolArguments(dag.preamble.tools, toolName, argumentsValue),
    [dag.preamble.tools, toolName, argumentsValue],
  )
  const schema = dag.preamble.tools.find((t) => t.name === toolName)?.parameters
  const resultIsJson = resultText ? isValidJsonText(resultText) : false
  const showError = Boolean(errorText)
  const showResult = !hideResult && !showError && Boolean(resultText)
  const validationHint = actionableValidationHint(validation)

  if (layout === "developer") {
    return (
      <div className="trace-tool-io trace-tool-io--developer">
        <div className="trace-detail-collapsible">
          <button
            type="button"
            className="trace-detail-collapsible__head"
            aria-expanded={payloadOpen}
            onClick={() => setPayloadOpen((open) => !open)}
          >
            <ChevronRight
              size={14}
              className={`trace-detail-collapsible__chev${payloadOpen ? " is-open" : ""}`}
              aria-hidden
            />
            <span className="trace-detail-collapsible__title">Input payload & schema</span>
          </button>
          {payloadOpen ? (
            <div className="trace-detail-collapsible__body">
              {validationHint ? (
                <p className="trace-tool-io__validation-hint">{validationHint}</p>
              ) : null}
              <JsonViewer
                value={argumentsValue}
                copyable
                embedded
                inline
                label="payload"
              />
            </div>
          ) : null}
        </div>
        {showError && errorText ? <TraceToolErrorSection text={errorText} /> : null}
        {showResult ? (
          <ToolResultBlock
            resultLabel={resultLabel}
            resultText={resultText!}
            resultIsJson={resultIsJson}
          />
        ) : null}
        {trailing}
        {schema ? (
          <SchemaAccordion open={schemaOpen} onToggle={() => setSchemaOpen((v) => !v)}>
            <JsonViewer value={schema} copyable embedded defaultExpandDepth={1} label="schema" />
          </SchemaAccordion>
        ) : null}
      </div>
    )
  }

  return (
    <div className="trace-tool-io">
      {validationHint ? (
        <p className="trace-tool-io__validation-hint">{validationHint}</p>
      ) : null}
      <JsonViewer value={argumentsValue} copyable embedded inline label={toolName} />
      {showError && errorText ? <TraceToolErrorSection text={errorText} /> : null}
      {showResult ? (
        <ToolResultBlock
          resultLabel={resultLabel}
          resultText={resultText!}
          resultIsJson={resultIsJson}
        />
      ) : null}
      {trailing}
      {schema ? (
        <SchemaAccordion open={schemaOpen} onToggle={() => setSchemaOpen((v) => !v)}>
          <JsonViewer value={schema} copyable embedded defaultExpandDepth={1} label="schema" />
        </SchemaAccordion>
      ) : null}
    </div>
  )
}

/**
 * One immutable section header row — same typography for Result and Error.
 * `meta` keeps right-column alignment (PLAIN TEXT / EXCEPTION).
 */
export function TraceToolSection({
  label,
  meta,
  children,
}: {
  label: string
  meta?: string | null
  children: ReactNode
}) {
  return (
    <div className="trace-tool-io__section">
      <div className="trace-tool-io__head">
        <span className="trace-detail-section__label">{label}</span>
        {meta ? (
          <span className="trace-json-badge is-plain">{meta}</span>
        ) : (
          <span className="trace-tool-io__head-meta-slot" aria-hidden />
        )}
      </div>
      {children}
    </div>
  )
}

function ToolResultBlock({
  resultLabel,
  resultText,
  resultIsJson,
}: {
  resultLabel: string
  resultText: string
  resultIsJson: boolean
}) {
  return (
    <TraceToolSection
      label={resultLabel}
      meta={resultIsJson ? "valid JSON" : "plain text"}
    >
      {resultIsJson ? (
        <JsonViewer
          value={JSON.parse(resultText.trim())}
          copyable
          embedded
          inline
          label="result"
        />
      ) : (
        <pre className="trace-detail-plain">{resultText}</pre>
      )}
    </TraceToolSection>
  )
}

/** Failed tool output — same header chrome as Result; body is the error callout. */
export function TraceToolErrorSection({ text }: { text: string }) {
  return (
    <TraceToolSection label="Error" meta="exception">
      <TraceErrorBlock text={text} />
    </TraceToolSection>
  )
}

/** Muted collapsible meta — always last; never competes with Result. */
function SchemaAccordion({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <div className="trace-tool-io__schema trace-detail-section--accordion">
      <button
        type="button"
        className="trace-detail-accordion"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight
          size={13}
          className={`trace-detail-accordion__chev${open ? " is-open" : ""}`}
          aria-hidden
        />
        <span className="trace-detail-accordion__label">Schema</span>
        <span className="trace-detail-accordion__meta">{open ? "Collapse" : "Expand"}</span>
      </button>
      {open ? <div className="trace-detail-accordion__body">{children}</div> : null}
    </div>
  )
}

/** Actionable schema issues only — never surface "unknown field" as a panic badge. */
function actionableValidationHint(validation: ToolSchemaValidation): string | null {
  if (validation.missingRequired.length > 0) {
    const fields = validation.missingRequired.join(", ")
    return `Missing required: ${fields}`
  }
  const invalid = validation.markers.filter((m) => m.status === "invalid")
  if (invalid.length > 0) {
    const fields = invalid.map((m) => m.path).join(", ")
    return `Type mismatch: ${fields}`
  }
  return null
}
