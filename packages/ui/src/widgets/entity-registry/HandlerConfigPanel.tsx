/**
 * Structured handler configuration display — shared by edit and read-only kinds.
 */

import { Plus } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { Listbox } from "../../components/Listbox"
import type { SearchablePickOption } from "../../components/SearchablePick"
import type { AuthoredSyncFlowStep, SyncFlowKindDefinition, SyncFlowKindHandlerType, SyncProcedureParameter } from "../../types"
import { SYNC_HTTP_SERVICE_SLOTS, formatStepOutputPreviewJson, stepOutputPreview } from "../../types"
import { FIELD_LABEL, HELP_TEXT, SUBSECTION_HEADING, TAB_CODE, TEXT_BTN } from "./chrome"
import type { CustomValueSourceUiCatalog } from "./handler-editor"
import {
  defaultHandlerForType,
  defaultProcedureParameters,
  formatHttpCallPreview,
  formatProcedureCallPreview,
  HANDLER_TYPE_OPTIONS,
  SHELL_PLATFORM_OPTIONS,
  withNormalizedKindDefinition,
} from "./handler-editor"
import {
  mergeHandlerParamPatch,
  ParamBindingEditorCard,
  ParamBindingReadOnlyCard,
  HandlerTypeTag,
} from "./param-binding-ui"

const CONNECTION_OPTIONS = [
  { value: "source" as const, label: "Source" },
  { value: "target" as const, label: "Target" },
  { value: "mixed" as const, label: "Mixed" },
]

const FAILURE_OPTIONS = [
  { value: "fatal" as const, label: "Fatal — stops run" },
  { value: "warning" as const, label: "Warning — logs and continues" },
]

const HTTP_SERVICE_OPTIONS = SYNC_HTTP_SERVICE_SLOTS.map(({ id, label }) => ({ value: id, label }))

const HTTP_METHOD_OPTIONS = [
  { value: "GET" as const, label: "GET" },
  { value: "POST" as const, label: "POST" },
]

function FieldLabel({ label }: { label: string }): JSX.Element {
  return <span className={FIELD_LABEL}>{label}</span>
}

function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): JSX.Element {
  return (
    <label className="flex flex-col gap-1">
      <FieldLabel label={label} />
      {children}
    </label>
  )
}

function StaticValue({ value, mono }: { value: string; mono?: boolean }): JSX.Element {
  return (
    <span className={`text-sm text-text ${mono ? "font-mono" : ""}`}>{value || "—"}</span>
  )
}

function optionLabel<T extends string>(
  options: ReadonlyArray<{ value: T; label: string }>,
  value: T | undefined,
): string {
  return options.find((o) => o.value === value)?.label ?? value ?? "—"
}

function ProcedureParametersReadOnly({
  parameters,
  customValueSourceCatalog,
}: {
  parameters: SyncProcedureParameter[]
  customValueSourceCatalog: CustomValueSourceUiCatalog
}): JSX.Element {
  if (parameters.length === 0) {
    return <StaticValue value="—" />
  }

  return (
    <div className="space-y-3">
      {parameters.map((param, index) => (
        <ParamBindingReadOnlyCard
          key={`${param.name}-${index}`}
          param={param}
          customValueSourceCatalog={customValueSourceCatalog}
        />
      ))}
    </div>
  )
}

function ProcedureCallBlock({
  handler,
  customValueSourceCatalog,
}: {
  handler: SyncFlowKindDefinition["handler"]
  customValueSourceCatalog: CustomValueSourceUiCatalog
}): JSX.Element | null {
  if (handler.type !== "mssql_procedure") return null
  const lines = formatProcedureCallPreview(handler, customValueSourceCatalog)
  if (!lines?.length) return null
  return (
    <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
      <p className={`mb-2 ${SUBSECTION_HEADING}`}>Execute preview</p>
      <pre className={TAB_CODE}>{lines.join("\n")}</pre>
    </div>
  )
}

function ProcedureParametersEditor({
  parameters,
  customValueSourceCatalog,
  flowStepOptions,
  resolveKind,
  flowStepsForOutputHints,
  onChange,
}: {
  parameters: SyncProcedureParameter[]
  customValueSourceCatalog: CustomValueSourceUiCatalog
  flowStepOptions?: readonly SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
  onChange: (parameters: SyncProcedureParameter[]) => void
}): JSX.Element {
  function patchRow(index: number, patch: Partial<SyncProcedureParameter>): void {
    onChange(parameters.map((row, i) => (i === index ? mergeHandlerParamPatch(row, patch) : row)))
  }

  function replaceRow(index: number, param: SyncProcedureParameter): void {
    onChange(parameters.map((row, i) => (i === index ? param : row)))
  }

  function removeRow(index: number): void {
    onChange(parameters.filter((_, i) => i !== index))
  }

  return (
    <div className="space-y-3">
      {parameters.map((param, index) => (
        <ParamBindingEditorCard
          key={index}
          param={param}
          customValueSourceCatalog={customValueSourceCatalog}
          flowStepOptions={flowStepOptions}
          resolveKind={resolveKind}
          flowStepsForOutputHints={flowStepsForOutputHints}
          onPatch={(patch) => patchRow(index, patch)}
          onReplace={(next) => replaceRow(index, next)}
          onRemove={() => removeRow(index)}
        />
      ))}
      <button
        type="button"
        className={TEXT_BTN}
        onClick={() => onChange([...parameters, { name: "", source: { type: "literal", value: "" } }])}
      >
        <Plus className="h-3.5 w-3.5" />
        Add parameter
      </button>
    </div>
  )
}

function MssqlProcedureFields({
  handler,
  customValueSourceCatalog,
  flowStepOptions,
  resolveKind,
  flowStepsForOutputHints,
  readOnly,
  patchHandler,
  onParametersChange,
}: {
  handler: Extract<SyncFlowKindDefinition["handler"], { type: "mssql_procedure" }>
  customValueSourceCatalog: CustomValueSourceUiCatalog
  flowStepOptions?: readonly SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
  readOnly?: boolean
  patchHandler: (patch: Partial<SyncFlowKindDefinition["handler"]>) => void
  onParametersChange?: (parameters: SyncProcedureParameter[]) => void
}): JSX.Element {
  const parameters =
    handler.parameters !== undefined ? handler.parameters : defaultProcedureParameters()

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Procedure">
          {readOnly ? (
            <StaticValue value={handler.procedure?.trim() ?? ""} mono />
          ) : (
            <input
              value={handler.procedure ?? ""}
              onChange={(e) => patchHandler({ procedure: e.target.value })}
              className="input font-mono text-sm"
              placeholder="core.uspExample"
            />
          )}
        </Field>
        <Field label="Connection">
          {readOnly ? (
            <StaticValue value={optionLabel(CONNECTION_OPTIONS, handler.connection)} />
          ) : (
            <Listbox
              value={handler.connection}
              options={CONNECTION_OPTIONS.filter((o) => o.value !== "mixed")}
              onChange={(connection) => patchHandler({ connection })}
              className="w-full"
              ariaLabel="Connection"
            />
          )}
        </Field>
      </div>

      <Field label="Parameters">
        {readOnly ? (
          <ProcedureParametersReadOnly
            parameters={parameters}
            customValueSourceCatalog={customValueSourceCatalog}
          />
        ) : (
          <ProcedureParametersEditor
            parameters={parameters}
            customValueSourceCatalog={customValueSourceCatalog}
            flowStepOptions={flowStepOptions}
            resolveKind={resolveKind}
            flowStepsForOutputHints={flowStepsForOutputHints}
            onChange={onParametersChange!}
          />
        )}
      </Field>
      <ProcedureCallBlock handler={handler} customValueSourceCatalog={customValueSourceCatalog} />
    </div>
  )
}

function HttpRequestFields({
  handler,
  readOnly,
  patchHandler,
  customValueSourceCatalog,
  flowStepOptions,
  resolveKind,
  flowStepsForOutputHints,
  onHttpBodyChange,
}: {
  handler: Extract<SyncFlowKindDefinition["handler"], { type: "http_request" }>
  readOnly?: boolean
  patchHandler: (patch: Partial<SyncFlowKindDefinition["handler"]>) => void
  customValueSourceCatalog: CustomValueSourceUiCatalog
  flowStepOptions?: readonly SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
  onHttpBodyChange?: (httpBody: SyncProcedureParameter[]) => void
}): JSX.Element {
  const method = handler.httpMethod ?? "POST"
  const service = handler.httpService ?? "etl"
  const path = handler.httpPath ?? ""
  const httpBody = handler.httpBody ?? []

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Connection">
        {readOnly ? (
          <StaticValue value={optionLabel(CONNECTION_OPTIONS, handler.connection)} />
        ) : (
          <Listbox
            value={handler.connection}
            options={CONNECTION_OPTIONS.filter((o) => o.value !== "mixed")}
            onChange={(connection) => patchHandler({ connection })}
            className="w-full"
            ariaLabel="Connection"
          />
        )}
      </Field>
      <Field label="HTTP service">
        {readOnly ? (
          <StaticValue value={optionLabel(HTTP_SERVICE_OPTIONS, service)} />
        ) : (
          <Listbox
            value={service}
            options={HTTP_SERVICE_OPTIONS}
            onChange={(httpService) => patchHandler({ httpService })}
            className="w-full"
            ariaLabel="HTTP service"
          />
        )}
      </Field>
      <Field label="HTTP method">
        {readOnly ? (
          <StaticValue value={method} mono />
        ) : (
          <Listbox
            value={method}
            options={HTTP_METHOD_OPTIONS}
            onChange={(httpMethod) => patchHandler({ httpMethod })}
            className="w-full"
            ariaLabel="HTTP method"
          />
        )}
      </Field>
      <Field label="HTTP path">
        {readOnly ? (
          <StaticValue value={path} mono />
        ) : (
          <input
            value={path}
            onChange={(e) => patchHandler({ httpPath: e.target.value })}
            className="input font-mono text-sm"
            placeholder="/dataset/deploy"
          />
        )}
      </Field>
      </div>
      {method !== "GET" && (readOnly || onHttpBodyChange) && (
        <Field label="JSON body fields">
          {readOnly ? (
            <ProcedureParametersReadOnly
              parameters={httpBody}
              customValueSourceCatalog={customValueSourceCatalog}
            />
          ) : (
            <ProcedureParametersEditor
              parameters={httpBody}
              customValueSourceCatalog={customValueSourceCatalog}
              flowStepOptions={flowStepOptions}
              resolveKind={resolveKind}
              flowStepsForOutputHints={flowStepsForOutputHints}
              onChange={onHttpBodyChange!}
            />
          )}
        </Field>
      )}
    </div>
  )
}

function HttpBodyPreview({
  handler,
  customValueSourceCatalog,
}: {
  handler: Extract<SyncFlowKindDefinition["handler"], { type: "http_request" }>
  customValueSourceCatalog: CustomValueSourceUiCatalog
}): JSX.Element | null {
  const lines = formatHttpCallPreview(handler, customValueSourceCatalog)
  if (!lines?.length) return null
  return (
    <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
      <p className={`mb-2 ${SUBSECTION_HEADING}`}>Execute preview</p>
      <pre className={TAB_CODE}>{lines.join("\n")}</pre>
    </div>
  )
}

function StepOutputPreviewPanel({
  kindId,
  value,
}: {
  kindId?: string
  value: SyncFlowKindDefinition
}): JSX.Element {
  const preview = stepOutputPreview(kindId, withNormalizedKindDefinition(value, kindId))
  return (
    <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
      <p className={`mb-1 ${SUBSECTION_HEADING}`}>Step output</p>
      <p className={`mb-2 ${HELP_TEXT}`}>{preview.note}</p>
      <pre className={TAB_CODE}>{formatStepOutputPreviewJson(preview)}</pre>
    </div>
  )
}

export function HandlerConfigPanel({
  value,
  onChange,
  readOnly,
  kindId,
  customValueSourceCatalog,
  bindingSourceCatalog,
  flowStepOptions,
  resolveKind,
  flowStepsForOutputHints,
}: {
  value: SyncFlowKindDefinition
  onChange?: (value: SyncFlowKindDefinition) => void
  readOnly?: boolean
  kindId?: string
  customValueSourceCatalog?: CustomValueSourceUiCatalog
  /** @deprecated Use customValueSourceCatalog */
  bindingSourceCatalog?: CustomValueSourceUiCatalog
  flowStepOptions?: readonly SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
}): JSX.Element {
  const resolvedCatalog = customValueSourceCatalog ?? bindingSourceCatalog ?? {}
  const handler = value.handler

  function patch(patch: Partial<SyncFlowKindDefinition>): void {
    onChange?.(withNormalizedKindDefinition({ ...value, ...patch }, kindId))
  }

  function patchHandler(patch: Partial<SyncFlowKindDefinition["handler"]>): void {
    onChange?.(
      withNormalizedKindDefinition({ ...value, handler: { ...handler, ...patch } }, kindId),
    )
  }

  function setHandlerType(type: SyncFlowKindHandlerType): void {
    onChange?.(
      withNormalizedKindDefinition({
        ...value,
        handler: defaultHandlerForType(type),
        createsDatasetLayer: undefined,
        publishedOutputs: undefined,
      }, kindId),
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Handler type">
          {readOnly ? (
            <div className="flex items-center gap-2">
              <HandlerTypeTag type={handler.type} />
              <span className="text-sm text-text">{optionLabel(HANDLER_TYPE_OPTIONS, handler.type)}</span>
            </div>
          ) : (
            <Listbox
              value={handler.type}
              options={HANDLER_TYPE_OPTIONS.map(({ value, label }) => ({ value, label }))}
              onChange={setHandlerType}
              className="w-full"
              ariaLabel="Handler type"
            />
          )}
        </Field>
        <Field label="Failure mode">
          {readOnly ? (
            <StaticValue value={optionLabel(FAILURE_OPTIONS, value.failureMode)} />
          ) : (
            <Listbox
              value={value.failureMode}
              options={FAILURE_OPTIONS}
              onChange={(failureMode) => patch({ failureMode })}
              className="w-full"
              ariaLabel="Failure mode"
            />
          )}
        </Field>
      </div>

      {handler.type === "mssql_procedure" && (
        <MssqlProcedureFields
          handler={handler}
          customValueSourceCatalog={resolvedCatalog}
          flowStepOptions={flowStepOptions}
          resolveKind={resolveKind}
          flowStepsForOutputHints={flowStepsForOutputHints}
          readOnly={readOnly}
          patchHandler={patchHandler}
          onParametersChange={
            readOnly ? undefined : (parameters) => patchHandler({ parameters })
          }
        />
      )}

      {handler.type === "http_request" && (
        <>
          <HttpRequestFields
            handler={handler}
            readOnly={readOnly}
            patchHandler={patchHandler}
            customValueSourceCatalog={resolvedCatalog}
            flowStepOptions={flowStepOptions}
            resolveKind={resolveKind}
            flowStepsForOutputHints={flowStepsForOutputHints}
            onHttpBodyChange={
              readOnly ? undefined : (httpBody) => patchHandler({ httpBody })
            }
          />
          <HttpBodyPreview
            handler={handler}
            customValueSourceCatalog={resolvedCatalog}
          />
        </>
      )}

      {handler.type === "custom_sql" && (
        <>
          <Field label="Connection">
            {readOnly ? (
              <StaticValue value={optionLabel(CONNECTION_OPTIONS, handler.connection)} />
            ) : (
              <Listbox
                value={handler.connection}
                options={CONNECTION_OPTIONS.filter((o) => o.value !== "mixed")}
                onChange={(connection) => patchHandler({ connection })}
                className="w-full"
                ariaLabel="Connection"
              />
            )}
          </Field>
          <Field label="Input slots">
            {readOnly ? (
              <ProcedureParametersReadOnly
                parameters={handler.inputs ?? []}
                customValueSourceCatalog={resolvedCatalog}
              />
            ) : (
              <ProcedureParametersEditor
                parameters={handler.inputs ?? []}
                customValueSourceCatalog={resolvedCatalog}
                flowStepOptions={flowStepOptions}
                resolveKind={resolveKind}
                flowStepsForOutputHints={flowStepsForOutputHints}
                onChange={(inputs) => patchHandler({ inputs })}
              />
            )}
          </Field>
          <Field label="SQL batch">
            {readOnly ? (
              <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
                <pre className={TAB_CODE}>{handler.sqlBatch?.trim() || "—"}</pre>
              </div>
            ) : (
              <textarea
                value={handler.sqlBatch ?? ""}
                onChange={(e) => patchHandler({ sqlBatch: e.target.value })}
                rows={6}
                className="input font-mono text-sm"
                placeholder={"UPDATE core.Example SET updatedAt = GETUTCDATE() WHERE id = @id"}
              />
            )}
          </Field>
        </>
      )}

      {handler.type === "custom_shell_script" && (
        <>
          <Field label="Policy environment">
            {readOnly ? (
              <StaticValue value={optionLabel(CONNECTION_OPTIONS, handler.connection)} />
            ) : (
              <Listbox
                value={handler.connection}
                options={CONNECTION_OPTIONS.filter((o) => o.value !== "mixed")}
                onChange={(connection) => patchHandler({ connection })}
                className="w-full"
                ariaLabel="Policy environment"
              />
            )}
          </Field>
          <Field label="Platform">
            {readOnly ? (
              <StaticValue value={optionLabel(SHELL_PLATFORM_OPTIONS, handler.shellPlatform ?? "any")} />
            ) : (
              <Listbox
                value={handler.shellPlatform ?? "any"}
                options={SHELL_PLATFORM_OPTIONS}
                onChange={(shellPlatform) => patchHandler({ shellPlatform })}
                className="w-full"
                ariaLabel="Shell platform"
              />
            )}
          </Field>
          <Field label="Input slots">
            {readOnly ? (
              <ProcedureParametersReadOnly
                parameters={handler.inputs ?? []}
                customValueSourceCatalog={resolvedCatalog}
              />
            ) : (
              <ProcedureParametersEditor
                parameters={handler.inputs ?? []}
                customValueSourceCatalog={resolvedCatalog}
                flowStepOptions={flowStepOptions}
                resolveKind={resolveKind}
                flowStepsForOutputHints={flowStepsForOutputHints}
                onChange={(inputs) => patchHandler({ inputs })}
              />
            )}
          </Field>
          <Field label="Shell command">
            {readOnly ? (
              <div className="rounded-lg border border-border-subtle bg-base/60 px-3 py-2.5">
                <pre className={TAB_CODE}>{handler.shellCommand?.trim() || "—"}</pre>
              </div>
            ) : (
              <textarea
                value={handler.shellCommand ?? ""}
                onChange={(e) => patchHandler({ shellCommand: e.target.value })}
                rows={4}
                className="input font-mono text-sm"
                placeholder={"/opt/scripts/post-sync.sh @id"}
              />
            )}
          </Field>
        </>
      )}

      <StepOutputPreviewPanel kindId={kindId} value={value} />
    </div>
  )
}
