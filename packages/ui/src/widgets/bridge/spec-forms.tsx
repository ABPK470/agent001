/**
 * spec-forms.tsx — per-kind read/write spec editors for the Bridge shell.
 *
 * The engine discriminates a spec by its `kind` field; that kind is fixed by
 * the selected connector's kind (mssql/postgres/hive → "sql", httpApi →
 * "httpApi", webhdfs → "webhdfs", denodo → "denodo"). These forms edit only
 * the kind-specific payload fields; the shell stamps the `kind` on submit.
 */

import type { JSX, ReactNode } from "react"
import type { ConnectorKindId, FileFormat, ReadSpec, WriteMode, WriteSpec } from "@mia/shared-types"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { FIELD_LABEL, META_TEXT } from "../entity-registry/chrome"
import { FormFieldGroup } from "../entity-registry/form-section"

/** The read-spec discriminator a connector kind maps to (null = no read). */
export function readSpecKindFor(
  kind: ConnectorKindId,
): "sql" | "httpApi" | "webhdfs" | "denodo" | "aws" | "azure" | "ftp" | "aqueduct" | null {
  if (kind === "mssql" || kind === "postgres" || kind === "hive" || kind === "databricks") return "sql"
  if (kind === "httpApi") return "httpApi"
  if (kind === "webhdfs") return "webhdfs"
  if (kind === "denodo") return "denodo"
  if (kind === "aws") return "aws"
  if (kind === "azure") return "azure"
  if (kind === "ftp") return "ftp"
  if (kind === "aqueduct") return "aqueduct"
  return null
}

/** The write-spec discriminator a connector kind maps to (null = no write). */
export function writeSpecKindFor(
  kind: ConnectorKindId,
): "sql" | "httpApi" | "webhdfs" | "aws" | "azure" | "ftp" | null {
  if (kind === "mssql" || kind === "postgres" || kind === "hive" || kind === "databricks") return "sql"
  if (kind === "httpApi") return "httpApi"
  if (kind === "webhdfs") return "webhdfs"
  if (kind === "aws") return "aws"
  if (kind === "azure") return "azure"
  if (kind === "ftp") return "ftp"
  return null
}

export type JsonParseResult = { value: unknown } | { error: string }

/** Parse an optional JSON text field; empty → undefined, invalid → error. */
export function parseJsonOpt(text: string): JsonParseResult {
  const trimmed = text.trim()
  if (trimmed === "") return { value: undefined }
  try {
    return { value: JSON.parse(trimmed) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

function jsonField(bag: Record<string, unknown>, key: string): unknown {
  const parsed = parseJsonOpt(String(bag[key] ?? ""))
  if ("error" in parsed) return undefined
  return parsed.value
}

/** Stamp the kind discriminator onto a read-spec field bag. */
export function buildReadSpec(kind: ConnectorKindId, bag: Record<string, unknown>): ReadSpec {
  const k = readSpecKindFor(kind)!
  if (k === "sql") return { kind: "sql", sql: String(bag["sql"] ?? "") }
  if (k === "httpApi") {
    const body = jsonField(bag, "body")
    const headers = jsonField(bag, "headers")
    return {
      kind: "httpApi",
      method: (bag["method"] as "GET" | "POST") ?? "GET",
      path: String(bag["path"] ?? ""),
      ...(body !== undefined ? { body } : {}),
      ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
      ...(bag["jsonPath"] ? { jsonPath: String(bag["jsonPath"]) } : {}),
    } as ReadSpec
  }
  if (k === "webhdfs") {
    return { kind: "webhdfs", path: String(bag["path"] ?? ""), format: (bag["format"] as FileFormat) ?? "csv" }
  }
  if (k === "aws" || k === "azure" || k === "ftp") {
    return { kind: k, path: String(bag["path"] ?? ""), format: (bag["format"] as FileFormat) ?? "csv" }
  }
  if (k === "aqueduct") {
    const params = jsonField(bag, "params")
    return {
      kind: "aqueduct",
      ...(params !== undefined ? { params: params as Record<string, string> } : {}),
    } as ReadSpec
  }
  // denodo
  const params = jsonField(bag, "params")
  return {
    kind: "denodo",
    view: String(bag["view"] ?? ""),
    ...(params !== undefined ? { params: params as Record<string, string> } : {}),
  } as ReadSpec
}

/** Stamp the kind discriminator onto a write-spec field bag. */
export function buildWriteSpec(kind: ConnectorKindId, bag: Record<string, unknown>): WriteSpec {
  const k = writeSpecKindFor(kind)!
  if (k === "sql") {
    const bs = bag["batchSize"]
    return {
      kind: "sql",
      table: String(bag["table"] ?? ""),
      mode: (bag["mode"] as "append" | "replace") ?? "append",
      ...(bs !== undefined && bs !== "" ? { batchSize: Number(bs) } : {}),
    } as WriteSpec
  }
  if (k === "httpApi") {
    const body = jsonField(bag, "body")
    const headers = jsonField(bag, "headers")
    return {
      kind: "httpApi",
      method: (bag["method"] as "POST" | "PUT") ?? "POST",
      path: String(bag["path"] ?? ""),
      ...(body !== undefined ? { body } : {}),
      ...(headers !== undefined ? { headers: headers as Record<string, string> } : {}),
    } as WriteSpec
  }
  if (k === "webhdfs" || k === "aws" || k === "azure" || k === "ftp") {
    return {
      kind: k,
      path: String(bag["path"] ?? ""),
      format: (bag["format"] as FileFormat) ?? "csv",
      mode: (bag["mode"] as "append" | "replace") ?? "replace",
    } as WriteSpec
  }
  throw new Error(`no write spec for kind ${kind}`)
}

/** Default empty field bag for a kind's read spec. */
export function emptyReadSpec(kind: ConnectorKindId): Record<string, unknown> {
  switch (readSpecKindFor(kind)) {
    case "sql":
      return { sql: "" }
    case "httpApi":
      return { method: "GET", path: "/", jsonPath: "" }
    case "webhdfs":
    case "aws":
    case "azure":
    case "ftp":
      return { path: "/", format: "csv" }
    case "denodo":
      return { view: "", params: "" }
    case "aqueduct":
      return { params: "" }
    default:
      return {}
  }
}

/** Default empty field bag for a kind's write spec. */
export function emptyWriteSpec(kind: ConnectorKindId): Record<string, unknown> {
  switch (writeSpecKindFor(kind)) {
    case "sql":
      return { table: "", mode: "append", batchSize: "" }
    case "httpApi":
      return { method: "POST", path: "/", body: "", headers: "" }
    case "webhdfs":
    case "aws":
    case "azure":
    case "ftp":
      return { path: "/", format: "csv", mode: "replace" }
    default:
      return {}
  }
}

const MODE_OPTIONS: ListboxOption<WriteMode>[] = [
  { value: "append", label: "Append" },
  { value: "replace", label: "Replace (truncate + insert)" },
]

const HTTP_READ_METHODS: ListboxOption<"GET" | "POST">[] = [
  { value: "GET", label: "GET" },
  { value: "POST", label: "POST" },
]
const HTTP_WRITE_METHODS: ListboxOption<"POST" | "PUT">[] = [
  { value: "POST", label: "POST" },
  { value: "PUT", label: "PUT" },
]
const FORMAT_OPTIONS: ListboxOption<"csv" | "json" | "parquet">[] = [
  { value: "csv", label: "CSV" },
  { value: "json", label: "JSON" },
  { value: "parquet", label: "Parquet" },
]

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
}): JSX.Element {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`input text-sm ${mono ? "font-mono" : ""}`}
    />
  )
}

function TextArea({
  value,
  onChange,
  placeholder,
  rows = 4,
  mono = true,
  fill = false,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  mono?: boolean
  /** Fill the parent (use inside FillFieldGroup). */
  fill?: boolean
}): JSX.Element {
  if (fill) {
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        className={[
          "input absolute inset-0 h-full w-full resize-none overflow-auto text-sm leading-relaxed",
          mono ? "font-mono" : "",
        ].join(" ")}
      />
    )
  }
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      className={`input text-sm leading-relaxed ${mono ? "font-mono" : ""}`}
    />
  )
}

/** Field group whose textarea child grows to fill remaining panel height. */
function FillFieldGroup({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border-subtle/70 bg-base/40 p-2.5">
      <div className="flex min-h-0 flex-1 flex-col gap-1.5">
        <span className={`shrink-0 ${FIELD_LABEL}`}>{label}</span>
        <div className="relative min-h-[10rem] flex-1">{children}</div>
        {hint ? <span className={`shrink-0 normal-case leading-snug ${META_TEXT}`}>{hint}</span> : null}
      </div>
    </div>
  )
}

function JsonField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  fill = false,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
  fill?: boolean
}): JSX.Element {
  if (fill) {
    return (
      <FillFieldGroup label={label} hint={hint}>
        <TextArea value={value} onChange={onChange} placeholder={placeholder} fill />
      </FillFieldGroup>
    )
  }
  return (
    <FormFieldGroup label={label} hint={hint}>
      <TextArea value={value} onChange={onChange} placeholder={placeholder} rows={3} />
    </FormFieldGroup>
  )
}

export function ReadSpecForm({
  kind,
  spec,
  onPatch,
}: {
  kind: ConnectorKindId
  spec: Record<string, unknown>
  onPatch: (patch: Record<string, unknown>) => void
}): JSX.Element | null {
  const k = readSpecKindFor(kind)
  if (!k) return null
  const patch = (p: Record<string, unknown>) => onPatch({ ...spec, ...p })

  if (k === "sql") {
    return (
      <FillFieldGroup label="SQL query" hint="Streaming SELECT — rows are pulled in batches.">
        <TextArea
          value={String(spec["sql"] ?? "")}
          onChange={(v) => patch({ sql: v })}
          placeholder="SELECT id, name FROM schema.table WHERE …"
          fill
        />
      </FillFieldGroup>
    )
  }
  if (k === "httpApi") {
    return (
      <>
        <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
          <FormFieldGroup label="Method">
            <Listbox
              value={(spec["method"] as "GET" | "POST") ?? "GET"}
              options={HTTP_READ_METHODS}
              onChange={(v) => patch({ method: v })}
              size="sm"
              className="w-full"
              ariaLabel="HTTP method"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Path" hint="Appended to the connector base URL.">
            <TextInput value={String(spec["path"] ?? "")} onChange={(v) => patch({ path: v })} placeholder="/api/items" mono />
          </FormFieldGroup>
        </div>
        <div className="shrink-0">
          <FormFieldGroup label="JSON path" hint="Dot-path to the rows array, e.g. data.items. Empty = top-level array.">
            <TextInput value={String(spec["jsonPath"] ?? "")} onChange={(v) => patch({ jsonPath: v })} placeholder="data.items" mono />
          </FormFieldGroup>
        </div>
        <JsonField
          label="Body (JSON, POST only)"
          value={String(spec["body"] ?? "")}
          onChange={(v) => patch({ body: v })}
          placeholder='{"filter":"active"}'
          fill
        />
        <div className="shrink-0">
          <JsonField
            label="Extra headers (JSON)"
            value={String(spec["headers"] ?? "")}
            onChange={(v) => patch({ headers: v })}
            placeholder='{"X-Tenant":"acme"}'
          />
        </div>
      </>
    )
  }
  if (k === "webhdfs" || k === "aws" || k === "azure" || k === "ftp") {
    const pathLabel =
      k === "webhdfs" ? "HDFS path" : k === "aws" ? "S3 object key" : k === "azure" ? "Blob path" : "Remote file path"
    const pathPlaceholder =
      k === "aws" ? "exports/data.csv" : k === "azure" ? "folder/export.csv" : "/data/export.csv"
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_8rem]">
        <FormFieldGroup label={pathLabel}>
          <TextInput value={String(spec["path"] ?? "")} onChange={(v) => patch({ path: v })} placeholder={pathPlaceholder} mono />
        </FormFieldGroup>
        <FormFieldGroup label="Format">
          <Listbox
            value={(spec["format"] as FileFormat) ?? "csv"}
            options={FORMAT_OPTIONS}
            onChange={(v) => patch({ format: v })}
            size="sm"
            className="w-full"
            ariaLabel="File format"
          />
        </FormFieldGroup>
      </div>
    )
  }
  if (k === "aqueduct") {
    return (
      <JsonField
        label="Preview params (JSON, optional)"
        value={String(spec["params"] ?? "")}
        onChange={(v) => patch({ params: v })}
        placeholder='{"limit":"100"}'
        hint="Pipeline id comes from the connector config. Params are passed to the Aqueduct preview API."
        fill
      />
    )
  }
  if (k === "denodo") {
    return (
      <>
        <div className="shrink-0">
          <FormFieldGroup label="View" hint="Denodo view path, e.g. my_db/my_view.">
            <TextInput value={String(spec["view"] ?? "")} onChange={(v) => patch({ view: v })} placeholder="my_db/my_view" mono />
          </FormFieldGroup>
        </div>
        <JsonField
          label="Params (JSON)"
          value={String(spec["params"] ?? "")}
          onChange={(v) => patch({ params: v })}
          placeholder='{"limit":"100"}'
          fill
        />
      </>
    )
  }
  return null
}

export function WriteSpecForm({
  kind,
  spec,
  onPatch,
}: {
  kind: ConnectorKindId
  spec: Record<string, unknown>
  onPatch: (patch: Record<string, unknown>) => void
}): JSX.Element | null {
  const k = writeSpecKindFor(kind)
  if (!k) {
    return (
      <p className="text-sm text-text-muted">
        This connector kind has no write path — it can only be a source.
      </p>
    )
  }
  const patch = (p: Record<string, unknown>) => onPatch({ ...spec, ...p })

  if (k === "sql") {
    return (
      <>
        <FormFieldGroup label="Table" hint="Schema-qualified destination table.">
          <TextInput value={String(spec["table"] ?? "")} onChange={(v) => patch({ table: v })} placeholder="dbo.staging_items" mono />
        </FormFieldGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Mode" hint="Replace runs TRUNCATE+INSERT in one transaction.">
            <Listbox
              value={(spec["mode"] as WriteMode) ?? "append"}
              options={MODE_OPTIONS}
              onChange={(v) => patch({ mode: v })}
              size="sm"
              className="w-full"
              ariaLabel="Write mode"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Batch size" hint="Empty = driver default (1000).">
            <TextInput
              value={String(spec["batchSize"] ?? "")}
              onChange={(v) => patch({ batchSize: v })}
              placeholder="1000"
              mono
            />
          </FormFieldGroup>
        </div>
      </>
    )
  }
  if (k === "httpApi") {
    return (
      <>
        <div className="grid shrink-0 grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
          <FormFieldGroup label="Method">
            <Listbox
              value={(spec["method"] as "POST" | "PUT") ?? "POST"}
              options={HTTP_WRITE_METHODS}
              onChange={(v) => patch({ method: v })}
              size="sm"
              className="w-full"
              ariaLabel="HTTP method"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Path">
            <TextInput value={String(spec["path"] ?? "")} onChange={(v) => patch({ path: v })} placeholder="/api/upsert" mono />
          </FormFieldGroup>
        </div>
        <JsonField
          label="Static body (JSON, merged with each row — row wins)"
          value={String(spec["body"] ?? "")}
          onChange={(v) => patch({ body: v })}
          placeholder='{"source":"etl"}'
          fill
        />
        <div className="shrink-0">
          <JsonField
            label="Extra headers (JSON)"
            value={String(spec["headers"] ?? "")}
            onChange={(v) => patch({ headers: v })}
            placeholder='{"X-Tenant":"acme"}'
          />
        </div>
      </>
    )
  }
  if (k === "webhdfs" || k === "aws" || k === "azure" || k === "ftp") {
    const pathLabel =
      k === "webhdfs" ? "HDFS path" : k === "aws" ? "S3 object key" : k === "azure" ? "Blob path" : "Remote file path"
    const pathPlaceholder =
      k === "aws" ? "exports/out.csv" : k === "azure" ? "folder/out.csv" : "/out/export.csv"
    return (
      <>
        <FormFieldGroup label={pathLabel}>
          <TextInput value={String(spec["path"] ?? "")} onChange={(v) => patch({ path: v })} placeholder={pathPlaceholder} mono />
        </FormFieldGroup>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormFieldGroup label="Format">
            <Listbox
              value={(spec["format"] as FileFormat) ?? "csv"}
              options={FORMAT_OPTIONS}
              onChange={(v) => patch({ format: v })}
              size="sm"
              className="w-full"
              ariaLabel="File format"
            />
          </FormFieldGroup>
          <FormFieldGroup label="Mode" hint="Replace overwrites the file; append adds to it.">
            <Listbox
              value={(spec["mode"] as WriteMode) ?? "replace"}
              options={MODE_OPTIONS}
              onChange={(v) => patch({ mode: v })}
              size="sm"
              className="w-full"
              ariaLabel="Write mode"
            />
          </FormFieldGroup>
        </div>
      </>
    )
  }
  return null
}
