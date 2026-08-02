/**
 * Structured tool I/O — collapsible payload + schema; result block optional.
 */

import { ChevronRight } from "lucide-react"
import { useMemo, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import {
  isValidJsonText,
  validateToolArguments,
  type ToolSchemaValidation,
} from "../../lib/events/trace-tool-schema"
import type { TraceDag } from "./build-trace-dag"

export type TraceToolIoLayout = "standard" | "developer"

export function TraceToolIo({
  dag,
  toolName,
  argumentsValue,
  resultText,
  resultLabel = "Result",
  layout = "standard",
  hideResult = false,
}: {
  dag: TraceDag
  toolName: string
  argumentsValue: Record<string, unknown>
  resultText?: string | null
  resultLabel?: string
  /** `developer` — collapsible payload/schema (human-first layouts like ask_user). */
  layout?: TraceToolIoLayout
  /** Suppress result when shown elsewhere (e.g. ask_user interaction card). */
  hideResult?: boolean
}) {
  const [payloadOpen, setPayloadOpen] = useState(layout === "standard")
  const [schemaOpen, setSchemaOpen] = useState(false)
  const validation = useMemo(
    () => validateToolArguments(dag.preamble.tools, toolName, argumentsValue),
    [dag.preamble.tools, toolName, argumentsValue],
  )
  const schema = dag.preamble.tools.find((t) => t.name === toolName)?.parameters
  const resultIsJson = resultText ? isValidJsonText(resultText) : false
  const showResult = !hideResult && Boolean(resultText)
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
              {schema ? (
                <div className="trace-tool-io__schema-nested">
                  <button
                    type="button"
                    className="trace-detail-collapsible__head trace-detail-collapsible__head--nested"
                    aria-expanded={schemaOpen}
                    onClick={() => setSchemaOpen((open) => !open)}
                  >
                    <ChevronRight
                      size={13}
                      className={`trace-detail-collapsible__chev${schemaOpen ? " is-open" : ""}`}
                      aria-hidden
                    />
                    <span className="trace-detail-collapsible__title">Schema</span>
                  </button>
                  {schemaOpen ? (
                    <JsonViewer
                      value={schema}
                      copyable
                      embedded
                      defaultExpandDepth={1}
                      label="schema"
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {showResult ? (
          <ToolResultBlock
            resultLabel={resultLabel}
            resultText={resultText!}
            resultIsJson={resultIsJson}
          />
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
      {schema ? (
        <div className="trace-tool-io__schema">
          <div className="trace-detail-section__header">
            <span className="trace-detail-section__label">Schema</span>
            <button
              type="button"
              className="trace-detail-section__expand"
              onClick={() => setSchemaOpen((v) => !v)}
            >
              {schemaOpen ? "Collapse" : "Expand"}
            </button>
          </div>
          {schemaOpen ? (
            <JsonViewer value={schema} copyable embedded defaultExpandDepth={1} label="schema" />
          ) : null}
        </div>
      ) : null}
      {showResult ? (
        <ToolResultBlock
          resultLabel={resultLabel}
          resultText={resultText!}
          resultIsJson={resultIsJson}
        />
      ) : null}
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
    <div className="trace-tool-io__result">
      <div className="trace-tool-io__head">
        <span className="trace-detail-section__label">{resultLabel}</span>
        <span className={`trace-json-badge${resultIsJson ? " is-valid" : " is-plain"}`}>
          {resultIsJson ? "valid JSON" : "plain text"}
        </span>
      </div>
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
