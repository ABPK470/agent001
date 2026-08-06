/**
 * Structured tool I/O.
 *
 * - pane: inspector owns the tool title — Input/Output lanes only (no nested Executed pill)
 * - standard: collapsible TraceExecutionCard (lists under Work)
 * - developer: ask_user payload accordion
 */

import { useMemo, type ReactNode } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import { formatExecInput } from "../../lib/tool-execution"
import {
  isValidJsonText,
  validateToolArguments,
  type ToolSchemaValidation,
} from "../../lib/events/trace-tool-schema"
import type { TraceDag } from "./build-trace-dag"
import { CopyControl } from "./TraceCopy"
import { TraceDetailCollapsible } from "./TraceDetailCollapsible"
import { TraceExecutionCard } from "./TraceExecutionCard"
import { ExpandableText } from "./TraceExpandable"
import type { ToolExecStatus } from "../../lib/tool-execution"

export type TraceToolIoLayout = "standard" | "developer" | "pane"

export function TraceToolIo({
  dag,
  toolName,
  argumentsValue,
  argsFormatted,
  resultText,
  errorText,
  layout = "standard",
  hideResult = false,
  status,
  durationMs,
  trailing,
}: {
  dag: TraceDag
  toolName: string
  argumentsValue: Record<string, unknown>
  argsFormatted?: string | null
  resultText?: string | null
  errorText?: string | null
  resultLabel?: string
  layout?: TraceToolIoLayout
  hideResult?: boolean
  status?: ToolExecStatus
  durationMs?: number | null
  trailing?: ReactNode
}) {
  const validation = useMemo(
    () => validateToolArguments(dag.preamble.tools, toolName, argumentsValue),
    [dag.preamble.tools, toolName, argumentsValue],
  )
  const schema = dag.preamble.tools.find((t) => t.name === toolName)?.parameters
  const resultIsJson = resultText ? isValidJsonText(resultText) : false
  const showError = Boolean(errorText)
  const showResult = !hideResult && !showError && Boolean(resultText)
  const validationHint = actionableValidationHint(validation)
  const input = formatExecInput(toolName, argumentsValue, argsFormatted)

  const schemaFooter = schema ? (
    <TraceDetailCollapsible label="Schema" defaultOpen={false} sticky={false}>
      <JsonViewer value={schema} copyable embedded defaultExpandDepth={1} label="schema" />
    </TraceDetailCollapsible>
  ) : null

  if (layout === "pane") {
    return (
      <div className="trace-tool-io trace-tool-io--pane">
        {validationHint ? (
          <p className="trace-tool-io__validation-hint">{validationHint}</p>
        ) : null}
        {input.text.trim() ? (
          <div className="trace-exec__input">
            <div className="trace-exec__lane-head">
              <span className="trace-exec__lane-label">
                {input.lang ? input.lang.toUpperCase() : "Input"}
              </span>
              <CopyControl value={input.copyText} ariaLabel="Copy input" />
            </div>
            <ExpandableText text={input.text.trim()} className="trace-exec__input-pre" />
          </div>
        ) : null}
        {showError && errorText ? <TraceToolErrorSection text={errorText} /> : null}
        {showResult && resultText ? (
          <div className="trace-exec__output-lane">
            <div className="trace-exec__lane-head">
              <span className="trace-exec__lane-label">Output</span>
              <CopyControl value={resultText} ariaLabel="Copy output" />
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
              <ExpandableText text={resultText} className="trace-exec__output-pre" />
            )}
          </div>
        ) : null}
        {trailing}
        {schemaFooter}
      </div>
    )
  }

  if (layout === "developer") {
    return (
      <div className="trace-tool-io trace-tool-io--developer">
        <TraceDetailCollapsible
          label="Input payload & schema"
          defaultOpen={false}
          sticky={false}
        >
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
        </TraceDetailCollapsible>
        {showError && errorText ? <TraceToolErrorSection text={errorText} /> : null}
        {showResult ? (
          <TraceToolSection label="Result" meta={resultIsJson ? "valid JSON" : "plain text"}>
            {resultIsJson ? (
              <JsonViewer
                value={JSON.parse(resultText!.trim())}
                copyable
                embedded
                inline
                label="result"
              />
            ) : (
              <pre className="trace-detail-plain">{resultText}</pre>
            )}
          </TraceToolSection>
        ) : null}
        {trailing}
        {schemaFooter}
      </div>
    )
  }

  return (
    <div className="trace-tool-io">
      {validationHint ? (
        <p className="trace-tool-io__validation-hint">{validationHint}</p>
      ) : null}
      <TraceExecutionCard
        toolName={toolName}
        argumentsValue={argumentsValue}
        argsFormatted={argsFormatted}
        resultText={showResult ? resultText : null}
        errorText={showError ? errorText : null}
        status={status}
        durationMs={durationMs}
        trailing={trailing}
        footer={schemaFooter}
      />
    </div>
  )
}

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

export function TraceToolErrorSection({ text }: { text: string }) {
  return (
    <TraceToolSection label="Error" meta="exception">
      <div className="trace-exec__output is-error is-standalone">
        <div className="trace-exec__output-body">
          <div className="trace-exec__output-main">
            <ExpandableText text={text} className="trace-exec__output-pre" />
          </div>
        </div>
      </div>
    </TraceToolSection>
  )
}

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
