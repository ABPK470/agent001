/**
 * Explicit handler parameter binding — no blank-field semantics in the UI.
 */

import { Trash2 } from "lucide-react"
import type { JSX, ReactNode } from "react"
import { Listbox } from "../../components/Listbox"
import { SearchablePick, type SearchablePickOption } from "../../components/SearchablePick"
import type { AuthoredSyncFlowStep, SyncFlowKindDefinition, SyncProcedureParameter, ValueSource } from "../../types"
import {
  formatValueSourcePreview,
  isLiteralValueSource,
  isStepBoundHandlerSlot,
  publishedOutputKeysForStep,
} from "../../types"
import { FIELD_LABEL } from "./chrome"
import type { CustomValueSourceUiCatalog } from "./handler-editor"
import {
  bindingRuntimeHint,
  bindingSourceListboxOptions,
  handlerInputSourceListValue,
  parseValueSourceListboxValue,
  PRIOR_STEP_OUTPUT_LISTBOX_VALUE,
  stepFieldListboxOptions,
  valueSourceListboxValue,
} from "./handler-editor"

export type HandlerParamBindingMode =
  | "literal"
  | "fixed-resolver"
  | "text-field"
  | "earlier-step"
  | "set-on-flow-step"

export const HANDLER_PARAM_BINDING_MODE_OPTIONS: ReadonlyArray<{
  value: HandlerParamBindingMode
  label: string
  hint: string
}> = [
  { value: "fixed-resolver", label: "Fixed resolver", hint: "System look up, same for every flow" },
  {
    value: "set-on-flow-step",
    label: "Choose on each flow step",
    hint: "System look up, but which lookup varies per flow",
  },
  { value: "literal", label: "Fixed literal", hint: "Constant value, same for every flow" },
  { value: "text-field", label: "Operator text field", hint: "Operator must type something" },
  { value: "earlier-step", label: "Earlier step output", hint: "Output from an earlier step in the flow" },
]

export const HANDLER_TYPE_TAG: Record<string, string> = {
  metadata_sync: "Metadata",
  mssql_procedure: "Procedure",
  http_request: "HTTP",
  custom_sql: "Custom SQL",
  custom_shell_script: "Shell",
}

export function inferHandlerParamBindingMode(param: SyncProcedureParameter): HandlerParamBindingMode {
  if (isStepBoundHandlerSlot(param)) return "set-on-flow-step"
  const source = param.source
  if (!source) return "literal"
  if (isLiteralValueSource(source)) return "literal"
  if (source.type === "priorOutput") return "earlier-step"
  if (source.type === "stepField") return "text-field"
  return "fixed-resolver"
}

export function mergeHandlerParamPatch(
  row: SyncProcedureParameter,
  patch: Partial<SyncProcedureParameter>,
): SyncProcedureParameter {
  const next: SyncProcedureParameter = { ...row, ...patch }
  if ("source" in patch && patch.source === undefined) delete next.source
  return next
}

export function applyHandlerParamBindingMode(
  param: SyncProcedureParameter,
  mode: HandlerParamBindingMode,
  ctx: {
    resolverOptions: ReadonlyArray<{ value: string }>
    textFieldOptions: ReadonlyArray<{ value: string }>
    flowStepOptions: readonly SearchablePickOption[]
  },
): SyncProcedureParameter {
  const name = param.name
  switch (mode) {
    case "set-on-flow-step":
      return { name }
    case "literal": {
      const existing = isLiteralValueSource(param.source) ? param.source.value : ""
      return { name, source: { type: "literal", value: existing ?? "" } }
    }
    case "fixed-resolver": {
      const existing =
        param.source &&
        !isLiteralValueSource(param.source) &&
        param.source.type !== "stepField" &&
        param.source.type !== "priorOutput"
          ? param.source
          : undefined
      const fallback =
        parseValueSourceListboxValue(ctx.resolverOptions[0]?.value ?? "planEntityId") ?? {
          type: "planEntityId",
        }
      return { name, source: existing ?? fallback }
    }
    case "text-field": {
      const existing = param.source?.type === "stepField" ? param.source : undefined
      const fallback =
        parseValueSourceListboxValue(ctx.textFieldOptions[0]?.value ?? "stepField:auditObjectType") ?? {
          type: "stepField",
          field: "auditObjectType",
        }
      return { name, source: existing ?? fallback }
    }
    case "earlier-step": {
      const existing = param.source?.type === "priorOutput" ? param.source : undefined
      return {
        name,
        source: {
          type: "priorOutput",
          stepId: existing?.stepId ?? ctx.flowStepOptions[0]?.value ?? "",
          output: existing?.output ?? "",
        },
      }
    }
  }
}

export function handlerParamBindingModeLabel(mode: HandlerParamBindingMode): string {
  return HANDLER_PARAM_BINDING_MODE_OPTIONS.find((entry) => entry.value === mode)?.label ?? mode
}

export function ParamBindingModeBadge({ mode }: { mode: HandlerParamBindingMode }): JSX.Element {
  return (
    <span className="shrink-0 rounded-full border border-border-subtle bg-elevated/80 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-muted">
      {handlerParamBindingModeLabel(mode)}
    </span>
  )
}

export function HandlerTypeTag({ type }: { type: string }): JSX.Element {
  const label = HANDLER_TYPE_TAG[type] ?? type
  return (
    <span className="shrink-0 rounded-md bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">
      {label}
    </span>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="grid gap-1 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-start sm:gap-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-text-faint">{label}</dt>
      <dd className="min-w-0 text-sm text-text">{children}</dd>
    </div>
  )
}

export function ParamBindingReadOnlyCard({
  param,
  customValueSourceCatalog,
}: {
  param: SyncProcedureParameter
  customValueSourceCatalog: CustomValueSourceUiCatalog
}): JSX.Element {
  const mode = inferHandlerParamBindingMode(param)
  const name = param.name.trim() || "param"
  const previewOptions = {
    customCatalog: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.definition]),
    ),
    customLabels: Object.fromEntries(
      Object.entries(customValueSourceCatalog).map(([id, entry]) => [id, entry.label]),
    ),
  }

  let body: JSX.Element
  switch (mode) {
    case "set-on-flow-step":
      body = (
        <DetailRow label="On flow step">
          Pick which resolver supplies <code className="font-mono text-[13px]">@{name}</code>
        </DetailRow>
      )
      break
    case "literal":
      body = (
        <DetailRow label="Value">
          <code className="font-mono text-[13px]">
            {isLiteralValueSource(param.source) && param.source.value === null
              ? "null"
              : String(isLiteralValueSource(param.source) ? param.source.value ?? "" : "")}
          </code>
        </DetailRow>
      )
      break
    case "text-field":
    case "fixed-resolver":
    case "earlier-step":
      body = (
        <>
          <DetailRow label="Source">
            {formatValueSourcePreview(param.source, previewOptions)}
          </DetailRow>
          {param.source && mode === "fixed-resolver" && (
            <DetailRow label="At run time">
              <span className="text-text-muted">{bindingRuntimeHint(customValueSourceCatalog, param.source)}</span>
            </DetailRow>
          )}
        </>
      )
      break
  }

  return (
    <article className="rounded-lg border border-border-subtle bg-base/40 p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2 border-b border-border-subtle pb-3">
        <code className="text-base font-semibold text-text">@{name}</code>
        <ParamBindingModeBadge mode={mode} />
      </header>
      <dl className="space-y-2">{body}</dl>
    </article>
  )
}

export function ParamBindingEditorCard({
  param,
  customValueSourceCatalog,
  flowStepOptions = [],
  resolveKind,
  flowStepsForOutputHints = [],
  onPatch,
  onRemove,
  onReplace,
}: {
  param: SyncProcedureParameter
  customValueSourceCatalog: CustomValueSourceUiCatalog
  flowStepOptions?: readonly SearchablePickOption[]
  resolveKind?: (kindId: string) => SyncFlowKindDefinition | undefined
  flowStepsForOutputHints?: readonly AuthoredSyncFlowStep[]
  onPatch: (patch: Partial<SyncProcedureParameter>) => void
  onReplace?: (param: SyncProcedureParameter) => void
  onRemove?: () => void
}): JSX.Element {
  const mode = inferHandlerParamBindingMode(param)
  const name = param.name.trim() || "param"
  const prior = param.source?.type === "priorOutput" ? param.source : null
  const resolverOptions = bindingSourceListboxOptions(customValueSourceCatalog).filter(
    (option) => option.value !== PRIOR_STEP_OUTPUT_LISTBOX_VALUE,
  )
  const textFieldOptions = stepFieldListboxOptions()

  const priorStep = prior?.stepId
    ? flowStepsForOutputHints.find((entry) => entry.id.trim() === prior.stepId.trim())
    : undefined
  const priorKindId = priorStep?.kind

  const outputKeyOptions: SearchablePickOption[] =
    prior?.stepId && resolveKind
      ? publishedOutputKeysForStep(prior.stepId, flowStepsForOutputHints, resolveKind).map((key) => ({
          value: key,
          label: key,
        }))
      : []

  function setMode(next: HandlerParamBindingMode): void {
    const replacement = applyHandlerParamBindingMode(param, next, {
      resolverOptions,
      textFieldOptions,
      flowStepOptions,
    })
    if (onReplace) onReplace(replacement)
    else onPatch(replacement)
  }

  function patchSource(source: ValueSource | undefined): void {
    onPatch(source === undefined ? { source: undefined } : { source })
  }

  return (
    <article className="rounded-lg border border-border-subtle bg-base/40 p-4">
      <header className="mb-3 flex items-start gap-2 border-b border-border-subtle pb-3">
        <label className="min-w-0 flex-1">
          <span className={FIELD_LABEL}>Parameter name</span>
          <span className="mb-1 block text-xs normal-case text-text-faint">
            Slot passed to the handler as <code className="font-mono">@{name || "name"}</code>
          </span>
          <input
            value={param.name}
            onChange={(e) => onPatch({ name: e.target.value })}
            placeholder="id"
            className="input w-full font-mono text-sm"
            aria-label="Parameter name"
          />
        </label>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="mt-5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-elevated hover:text-rose-400"
            title="Remove parameter"
            aria-label={`Remove parameter ${param.name || "slot"}`}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </header>

      <div className="mb-3">
        <span className={FIELD_LABEL}>How this value is supplied</span>
        <Listbox
          value={mode}
          options={HANDLER_PARAM_BINDING_MODE_OPTIONS.map((entry) => ({
            value: entry.value,
            label: entry.label,
            hint: entry.hint,
          }))}
          onChange={(next) => setMode(next as HandlerParamBindingMode)}
          className="mt-1 w-full"
          ariaLabel="How this value is supplied"
        />
      </div>

      {mode === "set-on-flow-step" && (
        <p className="text-sm text-text-muted">
          Each flow step chooses which resolver supplies <code className="font-mono">@{name}</code>.
        </p>
      )}

      {mode === "literal" && (
        <label className="block">
          <span className={FIELD_LABEL}>Value</span>
          <input
            value={
              isLiteralValueSource(param.source) && param.source.value === null
                ? "null"
                : String(isLiteralValueSource(param.source) ? param.source.value ?? "" : "")
            }
            onChange={(e) => {
              const raw = e.target.value
              let value: string | number | boolean | null = raw
              if (raw === "null") value = null
              else if (raw === "true" || raw === "false") value = raw === "true"
              else if (/^-?\d+$/.test(raw)) value = Number(raw)
              patchSource({ type: "literal", value })
            }}
            className="input w-full font-mono text-sm"
            placeholder="literal value"
          />
        </label>
      )}

      {mode === "fixed-resolver" && (
        <label className="block">
          <span className={FIELD_LABEL}>Resolver</span>
          <Listbox
            value={handlerInputSourceListValue(param.source)}
            options={resolverOptions}
            onChange={(value) => patchSource(parseValueSourceListboxValue(value))}
            className="w-full"
            ariaLabel="Resolver"
          />
        </label>
      )}

      {mode === "text-field" && (
        <label className="block">
          <span className={FIELD_LABEL}>Text field</span>
          <Listbox
            value={valueSourceListboxValue(param.source)}
            options={textFieldOptions}
            onChange={(value) => patchSource(parseValueSourceListboxValue(value))}
            className="w-full"
            ariaLabel="Text field"
          />
        </label>
      )}

      {mode === "earlier-step" && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block min-w-0">
            <span className={FIELD_LABEL}>Earlier step</span>
            <SearchablePick
              value={prior?.stepId ?? ""}
              options={flowStepOptions}
              onChange={(stepId) =>
                patchSource({
                  type: "priorOutput",
                  stepId,
                  output: prior?.output ?? "",
                })
              }
              placeholder="Step id…"
              ariaLabel="Earlier step"
            />
          </label>
          <label className="block min-w-0">
            <span className={FIELD_LABEL}>Output key</span>
            <SearchablePick
              value={prior?.output ?? ""}
              options={outputKeyOptions}
              onChange={(output) =>
                patchSource({
                  type: "priorOutput",
                  stepId: prior?.stepId ?? "",
                  output,
                })
              }
              placeholder={outputKeyOptions.length > 0 ? "datasetId…" : "Pick an earlier step first"}
              ariaLabel="Output key"
            />
            {prior?.stepId && outputKeyOptions.length === 0 && (
              <p className="mt-1 text-xs text-text-muted">
                {priorKindId
                  ? `No keys for ${priorKindId} — open that action to see Step output.`
                  : "Earlier step not found in catalog."}
              </p>
            )}
          </label>
        </div>
      )}
    </article>
  )
}
