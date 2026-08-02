/**
 * Structured tool I/O — JsonViewer + schema markers + valid JSON badge + collapse schema.
 */

import { useMemo, useState } from "react"
import { JsonViewer } from "../../components/JsonViewer"
import {
  isValidJsonText,
  statusMarkerClass,
  validateToolArguments,
  type ToolSchemaValidation,
} from "../../lib/events/trace-tool-schema"
import type { TraceDag } from "./build-trace-dag"

export function TraceToolIo({
  dag,
  toolName,
  argumentsValue,
  resultText,
  label = "Arguments",
}: {
  dag: TraceDag
  toolName: string
  argumentsValue: Record<string, unknown>
  resultText?: string | null
  label?: string
}) {
  const [schemaOpen, setSchemaOpen] = useState(false)
  const validation = useMemo(
    () => validateToolArguments(dag.preamble.tools, toolName, argumentsValue),
    [dag.preamble.tools, toolName, argumentsValue],
  )
  const schema = dag.preamble.tools.find((t) => t.name === toolName)?.parameters
  const resultIsJson = resultText ? isValidJsonText(resultText) : false

  return (
    <div className="trace-tool-io">
      <div className="trace-tool-io__head">
        <span className="trace-detail-section__label">{label}</span>
        {validation.missingRequired.length > 0 ? (
          <span className="trace-schema-summary is-invalid">
            {validation.missingRequired.length} missing
          </span>
        ) : validation.unknownFields.length > 0 ? (
          <span className="trace-schema-summary is-warn">
            {validation.unknownFields.length} unknown
          </span>
        ) : (
          <span className="trace-schema-summary is-valid">schema ok</span>
        )}
      </div>
      <SchemaMarkers validation={validation} />
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
      {resultText ? (
        <div className="trace-tool-io__result">
          <div className="trace-tool-io__head">
            <span className="trace-detail-section__label">Result</span>
            <span
              className={`trace-json-badge${resultIsJson ? " is-valid" : " is-plain"}`}
            >
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
      ) : null}
    </div>
  )
}

function SchemaMarkers({ validation }: { validation: ToolSchemaValidation }) {
  if (validation.markers.length === 0) return null
  return (
    <ul className="trace-schema-markers">
      {validation.markers.map((m) => (
        <li key={m.path} className={statusMarkerClass(m.status)}>
          <span className="trace-schema-markers__path">{m.path}</span>
          {m.message ? (
            <span className="trace-schema-markers__msg">{m.message}</span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
