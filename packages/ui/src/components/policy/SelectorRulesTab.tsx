/**
 * SelectorRulesTab — second-pass redesign.
 *
 * The mental model we communicate to the user:
 *   "A rule says: WHEN these dimensions match → ALLOW / REQUIRE APPROVAL / DENY.
 *    There are exactly 9 dimensions. That's the whole policy surface."
 *
 * Concretely:
 *  - All 9 dimensions are ALWAYS visible — each as a single labelled dropdown
 *    with "Any" as the default. No add/remove chips. The user immediately sees
 *    the entire policy lattice.
 *  - A "Common templates" strip at the top of the New-rule editor provides
 *    one-click starters that pre-fill the form.
 *  - Linear numbered sections: 1. Name → 2. Effect → 3. Match → 4. Priority/Reason.
 *  - Inline edit-in-place (clicking Edit on row N expands editor inside row N).
 *  - JSON view stays available as a small toggle for power users.
 */

import {
    AlertCircle,
    BookOpen,
    ChevronDown,
    ChevronRight,
    FilePlus,
    Info,
    Sparkles,
    Trash2,
    X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { api } from "../../api"
import type { PolicyRule, ToolInfo } from "../../types"
import { Listbox, type ListboxOption } from "../Listbox"
import {
    CONDITION_FORMS,
    EFFECT_META,
    EMPTY_RULE_FORM,
    formToParameters,
    getEffectMeta,
    getPriorityBand,
    parseRuleParameters,
    PRIORITY_BANDS,
    RULE_TEMPLATES,
    ruleToForm,
    SELECTOR_KEYS,
    SOURCE_META,
    summarizeRule,
    type Effect,
    type PolicySource,
    type RuleFormValue,
    type RuleTemplate,
    type SelectorKeyMeta,
} from "./selector-schema"

interface Props {
  rules:    PolicyRule[]
  tools:    ToolInfo[]
  onReload: () => Promise<void>
  onDelete: (name: string) => Promise<void>
}

type Filter = "all" | PolicySource

const FILTERS: ReadonlyArray<{ v: Filter; label: string }> = [
  { v: "all",            label: "All"      },
  { v: "db",             label: "Operator" },
  { v: "hosted_default", label: "Default"  },
  { v: "env_derived",    label: "Env"      },
]

const NEW_KEY = "__new__"
const ANY = ""  // empty selector value = "Any" (rule ignores this dimension)

/** Common tool wildcards we offer in the tool dropdown alongside concrete names. */
const COMMON_TOOL_GLOBS = ["mssql_*"]

export function SelectorRulesTab({ rules, tools, onReload, onDelete }: Props) {
  const [filter, setFilter]       = useState<Filter>("all")
  const [helpOpen, setHelpOpen]   = useState(false)
  const [editing, setEditing]     = useState<string | null>(null)
  const [form, setForm]           = useState<RuleFormValue>(EMPTY_RULE_FORM)
  const [mode, setMode]           = useState<"form" | "json">("form")
  const [jsonDraft, setJsonDraft] = useState<string>("{}")
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState<string | null>(null)

  const filteredRules = useMemo(
    () => filter === "all" ? rules : rules.filter((r) => (r.source ?? "db") === filter),
    [rules, filter],
  )

  const counts = useMemo(() => ({
    all:            rules.length,
    db:             rules.filter((r) => (r.source ?? "db") === "db").length,
    hosted_default: rules.filter((r) => r.source === "hosted_default").length,
    env_derived:    rules.filter((r) => r.source === "env_derived").length,
  }), [rules])

  function openEdit(rule: PolicyRule | null, prefill?: RuleFormValue) {
    setError(null)
    setMode("form")
    if (prefill) {
      setForm(prefill)
      setJsonDraft(JSON.stringify(formToParameters(prefill), null, 2))
      setEditing(NEW_KEY)
      return
    }
    if (rule) {
      const f = ruleToForm(rule)
      setForm(f)
      setJsonDraft(JSON.stringify(formToParameters(f), null, 2))
      setEditing(rule.name)
    } else {
      setForm(EMPTY_RULE_FORM)
      setJsonDraft(JSON.stringify(formToParameters(EMPTY_RULE_FORM), null, 2))
      setEditing(NEW_KEY)
    }
  }

  function closeEdit() {
    setEditing(null)
    setError(null)
  }

  async function saveRule() {
    setSaving(true)
    setError(null)
    try {
      let parameters: Record<string, unknown>
      if (mode === "json") {
        try { parameters = JSON.parse(jsonDraft) as Record<string, unknown> }
        catch (e) {
          setError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`)
          setSaving(false)
          return
        }
      } else {
        parameters = formToParameters(form)
      }
      if (!form.name.trim()) {
        setError("Name is required.")
        setSaving(false)
        return
      }
      await api.createPolicy({
        name:      form.name.trim(),
        effect:    form.effect,
        condition: form.condition.trim() || "selectors",
        parameters,
      })
      await onReload()
      closeEdit()
    } catch {
      setError("Save failed.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <HelpPanel open={helpOpen} onToggle={() => setHelpOpen((v) => !v)} toolCount={tools.length} />

      <div className="flex items-center justify-between gap-3 flex-wrap pb-3 border-b border-border-subtle">
        <div className="flex items-center gap-1 rounded-lg bg-overlay-2 border border-border-subtle p-1">
          {FILTERS.map((f) => (
            <button
              key={f.v}
              onClick={() => setFilter(f.v)}
              className={`px-2.5 py-1 text-[12px] rounded-md transition-colors ${
                filter === f.v
                  ? "bg-surface text-text shadow-sm"
                  : "text-text-muted hover:text-text"
              }`}
            >{f.label} <span className="opacity-60">{counts[f.v]}</span></button>
          ))}
        </div>
        <button
          className="px-3 py-1.5 text-[13px] rounded-lg bg-accent/20 text-accent hover:bg-accent/30 flex items-center gap-1.5"
          onClick={() => openEdit(null)}
        ><FilePlus size={13} /> New rule</button>
      </div>

      {editing === NEW_KEY && (
        <RuleEditor
          title="New rule"
          form={form}
          setForm={setForm}
          mode={mode}
          setMode={setMode}
          jsonDraft={jsonDraft}
          setJsonDraft={setJsonDraft}
          tools={tools}
          saving={saving}
          error={error}
          onSave={saveRule}
          onCancel={closeEdit}
          onUseTemplate={(t) => openEdit(null, { ...t.form } as RuleFormValue)}
          showTemplates
        />
      )}

      <div className="space-y-1.5">
        {filteredRules.map((r) => (
          <RuleRow
            key={r.name}
            rule={r}
            isEditing={editing === r.name}
            onEdit={() => openEdit(r)}
            onCancelEdit={closeEdit}
            onDelete={() => onDelete(r.name)}
            form={form}
            setForm={setForm}
            mode={mode}
            setMode={setMode}
            jsonDraft={jsonDraft}
            setJsonDraft={setJsonDraft}
            tools={tools}
            saving={saving}
            error={error}
            onSave={saveRule}
          />
        ))}
        {filteredRules.length === 0 && (
          <div className="text-text-muted text-[13px] text-center py-6">No rules match this filter.</div>
        )}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Help / schema reference panel
// ────────────────────────────────────────────────────────────────────────

function HelpPanel({ open, onToggle, toolCount }: { open: boolean; onToggle: () => void; toolCount: number }) {
  const enumValueCount = SELECTOR_KEYS
    .filter((s) => s.type === "enum")
    .reduce((n, s) => n + (s.enumValues?.length ?? 0), 0)

  return (
    <div className="rounded-xl bg-overlay-2/60 border border-border-subtle">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-text">
          <BookOpen size={14} className="text-accent" />
          How Selector Rules work
        </span>
        <span className="flex items-center gap-2">
          <span className="text-[11px] text-text-muted hidden sm:inline">
            <strong className="text-text">{SELECTOR_KEYS.length}</strong> dimensions ·{" "}
            <strong className="text-text">{enumValueCount}</strong> fixed values ·{" "}
            <strong className="text-text">{toolCount}</strong> tools ·{" "}
            <strong className="text-text">{EFFECT_META.length}</strong> effects
          </span>
          {open ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 text-[12.5px] text-text-secondary leading-relaxed border-t border-border-subtle pt-3">
          <section>
            <h4 className="font-semibold text-text mb-1">The model</h4>
            <p>
              Every tool call passes through the policy engine. A rule says:{" "}
              <strong>"WHEN these dimensions match → ALLOW / REQUIRE APPROVAL / DENY"</strong>.
              The engine collects every rule whose dimensions all match the request, then picks
              the winner: <em>highest priority wins</em>; ties broken by{" "}
              <em>deny &gt; require_approval &gt; allow</em>.
            </p>
            <p className="mt-1.5 text-text-muted">
              The whole policy surface is finite: {SELECTOR_KEYS.length} dimensions,
              {" "}{enumValueCount} fixed enum values, {toolCount} tools, 3 effects.
              There is nothing else the engine reads.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-text mb-1.5">Effects</h4>
            <ul className="space-y-1.5">
              {EFFECT_META.map((e) => {
                const Icon = e.icon
                return (
                  <li key={e.value} className="flex items-start gap-2">
                    <Icon size={13} className={`${e.color} mt-0.5 shrink-0`} />
                    <span><code className={`font-mono ${e.color}`}>{e.value}</code> — {e.description}</span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-text-muted">
              <code className="font-mono">require_approval</code> emits an <code>approval.required</code>{" "}
              event that surfaces in the Notification panel (top-right bell). Currently you must edit
              the policy and resume the run; there is no inline accept/decline button yet.
            </p>
          </section>

          <section>
            <h4 className="font-semibold text-text mb-1.5">The 9 dimensions</h4>
            <p className="mb-2 text-text-muted">
              All optional. A rule matches a request only if <em>every</em> dimension you set narrows
              in on it. Leave a dimension on <strong>Any</strong> to ignore it.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SELECTOR_KEYS.map((s) => (
                <div key={s.key} className="rounded-md bg-canvas/40 border border-border-subtle px-3 py-2">
                  <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
                    <code className="font-mono text-text font-semibold">{s.key}</code>
                    <span className="text-[10px] text-text-muted uppercase tracking-wider">{s.type}</span>
                  </div>
                  <p className="text-[11.5px] text-text-muted mb-1">{s.description}</p>
                  {s.enumValues && (
                    <ul className="space-y-0.5 text-[11.5px]">
                      {s.enumValues.map((v) => (
                        <li key={v.value}>
                          <code className="font-mono text-accent">{v.value}</code>
                          <span className="text-text-muted"> — {v.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.examples && (
                    <p className="text-[11.5px] text-text-faint mt-1">
                      e.g. {s.examples.map((ex, i) => (
                        <span key={ex}>{i > 0 && ", "}<code className="font-mono">{ex}</code></span>
                      ))}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section>
            <h4 className="font-semibold text-text mb-1.5">Conditions</h4>
            <ul className="space-y-1">
              {CONDITION_FORMS.map((c) => (
                <li key={c.value}>
                  <code className="font-mono text-text">{c.value}</code>
                  <span className="text-text-muted"> — {c.description}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h4 className="font-semibold text-text mb-1.5">Priority bands (suggested)</h4>
            <ul className="space-y-1">
              {PRIORITY_BANDS.map((b) => (
                <li key={b.label} className="flex items-baseline gap-2">
                  <code className={`font-mono ${b.color} w-16 shrink-0`}>{b.min}–{b.max === 999 ? "∞" : b.max}</code>
                  <span><strong className="text-text">{b.label}</strong> — {b.description}</span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h4 className="font-semibold text-text mb-1.5">Sources</h4>
            <ul className="space-y-1">
              {Object.values(SOURCE_META).map((s) => (
                <li key={s.value}>
                  <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${s.badgeClass}`}>{s.label}</span>
                  <span className="text-text-muted"> — {s.description}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Rule row (collapsed + inline-expanded states)
// ────────────────────────────────────────────────────────────────────────

interface RowProps {
  rule:         PolicyRule
  isEditing:    boolean
  onEdit:       () => void
  onCancelEdit: () => void
  onDelete:     () => void
  form:         RuleFormValue
  setForm:      (f: RuleFormValue | ((prev: RuleFormValue) => RuleFormValue)) => void
  mode:         "form" | "json"
  setMode:      (m: "form" | "json") => void
  jsonDraft:    string
  setJsonDraft: (s: string) => void
  tools:        ToolInfo[]
  saving:       boolean
  error:        string | null
  onSave:       () => Promise<void>
}

function RuleRow(props: RowProps) {
  const { rule, isEditing, onEdit, onCancelEdit, onDelete } = props
  const eff = getEffectMeta(rule.effect)
  const EffIcon = eff.icon
  const src = (rule.source ?? "db") as PolicySource
  const badge = SOURCE_META[src]
  const { priority } = parseRuleParameters(rule)
  const summary = summarizeRule(rule)
  const isReadOnly = src !== "db"

  return (
    <div className={`rounded-lg border ${isEditing ? "border-accent/40 bg-overlay-2" : "border-border-subtle bg-overlay-2"}`}>
      <div className="flex items-center gap-3 px-3 py-2">
        <EffIcon size={14} className={`${eff.color} shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-mono text-text truncate">{rule.name}</span>
            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.badgeClass}`}>
              {badge.label}
            </span>
            {priority !== null && <span className="text-[10px] text-text-muted">prio {priority}</span>}
            {rule.updatedAt && <span className="text-[10px] text-text-muted">edited by {rule.updatedBy ?? "?"}</span>}
          </div>
          <div className="text-[12px] text-text-muted truncate" title={summary}>{summary}</div>
        </div>
        {!isEditing && (
          <>
            <button onClick={onEdit} className="text-text-muted hover:text-text text-[12px] px-2">
              {isReadOnly ? "Override" : "Edit"}
            </button>
            <button onClick={onDelete} className="text-error/70 hover:text-error p-1" title="Delete">
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>

      {isEditing && (
        <div className="border-t border-border-subtle">
          <RuleEditor
            title={isReadOnly ? `Override "${rule.name}" with an operator rule` : `Edit "${rule.name}"`}
            form={props.form}
            setForm={props.setForm}
            mode={props.mode}
            setMode={props.setMode}
            jsonDraft={props.jsonDraft}
            setJsonDraft={props.setJsonDraft}
            tools={props.tools}
            saving={props.saving}
            error={props.error}
            onSave={props.onSave}
            onCancel={onCancelEdit}
            embedded
            readOnlyOriginNotice={isReadOnly ? badge : null}
          />
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Rule editor — numbered linear layout
// ────────────────────────────────────────────────────────────────────────

interface EditorProps {
  title:        string
  form:         RuleFormValue
  setForm:      (f: RuleFormValue | ((prev: RuleFormValue) => RuleFormValue)) => void
  mode:         "form" | "json"
  setMode:      (m: "form" | "json") => void
  jsonDraft:    string
  setJsonDraft: (s: string) => void
  tools:        ToolInfo[]
  saving:       boolean
  error:        string | null
  onSave:       () => Promise<void>
  onCancel:     () => void
  embedded?:    boolean
  readOnlyOriginNotice?: { label: string; description: string } | null
  showTemplates?: boolean
  onUseTemplate?: (t: RuleTemplate) => void
}

function RuleEditor(props: EditorProps) {
  const { title, form, setForm, mode, setMode, jsonDraft, setJsonDraft, tools, saving, error, onSave, onCancel } = props
  const editorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    editorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  }, [])

  function switchToJson() {
    setJsonDraft(JSON.stringify(formToParameters(form), null, 2))
    setMode("json")
  }
  function switchToForm() {
    try {
      const parsed = JSON.parse(jsonDraft) as Record<string, unknown>
      const sel = (parsed["selectors"] ?? {}) as Record<string, unknown>
      const newSelectors: Record<string, string> = {}
      for (const [k, v] of Object.entries(sel)) {
        if (typeof v === "string") newSelectors[k] = v
      }
      setForm((s) => ({
        ...s,
        selectors: newSelectors,
        priority:  typeof parsed["priority"] === "number" ? (parsed["priority"] as number) : s.priority,
        reason:    typeof parsed["reason"]   === "string" ? (parsed["reason"]   as string) : s.reason,
      }))
    } catch { /* ignore invalid JSON when switching back */ }
    setMode("form")
  }

  function setSelector(key: string, value: string) {
    setForm((s) => {
      const next = { ...s.selectors }
      if (value === ANY) delete next[key]
      else next[key] = value
      return { ...s, selectors: next }
    })
  }

  const previewRule: PolicyRule = {
    name:       form.name || "(unnamed)",
    effect:     form.effect,
    condition:  form.condition || "selectors",
    parameters: formToParameters(form),
    createdAt:  "",
  }
  const previewSummary = summarizeRule(previewRule)
  const band = getPriorityBand(form.priority)
  const activeDimCount = Object.values(form.selectors).filter((v) => v !== ANY).length

  return (
    <div ref={editorRef} className={`${props.embedded ? "px-4 py-4" : "px-4 py-3.5 rounded-xl bg-overlay-2 border border-accent/30"} space-y-4`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-text">{title}</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => mode === "form" ? switchToJson() : switchToForm()}
            className="text-[11px] text-text-muted hover:text-text px-2 py-1 rounded hover:bg-overlay-3"
            title="Toggle between structured form and raw JSON"
          >{mode === "form" ? "Show JSON" : "Show form"}</button>
          <button onClick={onCancel} className="text-text-muted hover:text-text p-1 rounded hover:bg-overlay-3" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {props.readOnlyOriginNotice && (
        <div className="px-3 py-2 rounded-lg bg-warning/10 border border-warning/30 text-[12px] text-warning flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />
          <span>
            This rule is a <strong>{props.readOnlyOriginNotice.label}</strong> and lives outside the database.
            Saving creates a new <strong>operator</strong> rule with the same name that overrides it on the next run.
            {" "}{props.readOnlyOriginNotice.description}
          </span>
        </div>
      )}

      {props.showTemplates && props.onUseTemplate && (
        <div className="rounded-lg bg-canvas/40 border border-border-subtle p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <Sparkles size={12} className="text-accent" />
            <span className="text-[12px] font-semibold text-text">Start from a template</span>
            <span className="text-[11px] text-text-muted">— click to pre-fill the form</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {RULE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => props.onUseTemplate!(t)}
                title={t.description}
                className="px-2.5 py-1 text-[11.5px] rounded-md bg-overlay-2 border border-border-subtle text-text-secondary hover:text-text hover:border-accent/40 hover:bg-overlay-3 transition-colors"
              >{t.label}</button>
            ))}
          </div>
        </div>
      )}

      {mode === "json" ? (
        <div>
          <div className="text-[12px] text-text-muted mb-1">
            Raw <code className="font-mono">parameters</code> JSON. Switch back to Form to round-trip into the structured editor.
          </div>
          <textarea
            value={jsonDraft}
            onChange={(e) => setJsonDraft(e.target.value)}
            rows={12}
            className="w-full px-3 py-2 rounded-lg bg-surface border border-border-subtle text-[12px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="space-y-4">
          <Section number={1} label="Name this rule" hint="Lowercase + underscores recommended.">
            <input
              placeholder="e.g. allow_dev_query"
              value={form.name}
              onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border-subtle text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </Section>

          <Section number={2} label="What should happen?" hint="Picked when this rule wins.">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {EFFECT_META.map((e) => {
                const Icon = e.icon
                const active = form.effect === e.value
                return (
                  <button
                    key={e.value}
                    type="button"
                    onClick={() => setForm((s) => ({ ...s, effect: e.value as Effect }))}
                    title={e.description}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-left transition-colors ${
                      active
                        ? `${e.color} ${e.bg} border-current font-medium`
                        : "border-border-subtle bg-surface text-text-muted hover:text-text hover:bg-overlay-3"
                    }`}
                  >
                    <Icon size={15} className="shrink-0" />
                    <div className="min-w-0">
                      <div className="text-[13px]">{e.label}</div>
                      <div className="text-[10.5px] opacity-70 leading-tight truncate">{e.description}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </Section>

          <Section
            number={3}
            label="When all of these match"
            hint={`The rule fires only if every dimension you set agrees. Leave a dimension on "Any" to ignore it.`}
          >
            <div className="rounded-lg bg-canvas/40 border border-border-subtle divide-y divide-border-subtle">
              {SELECTOR_KEYS.map((meta) => (
                <DimensionRow
                  key={meta.key}
                  meta={meta}
                  value={form.selectors[meta.key] ?? ANY}
                  onChange={(v) => setSelector(meta.key, v)}
                  tools={tools}
                />
              ))}
            </div>
            <div className="text-[11px] text-text-muted mt-1.5 px-1">
              {SELECTOR_KEYS.length} dimensions · {activeDimCount} active in this rule
            </div>
          </Section>

          <Section number={4} label="Tie-breaker priority + audit reason">
            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
              <div>
                <label className="block text-[11.5px] text-text-muted mb-1">Priority</label>
                <input
                  type="number"
                  value={form.priority}
                  onChange={(e) => setForm((s) => ({ ...s, priority: Number(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border-subtle text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <div className={`text-[11px] mt-1 ${band.color}`} title={band.description}>
                  {band.label}
                </div>
              </div>
              <div>
                <label className="block text-[11.5px] text-text-muted mb-1">
                  Reason <span className="text-text-faint">— shown to operators on approval prompts and in audit logs</span>
                </label>
                <textarea
                  value={form.reason}
                  onChange={(e) => setForm((s) => ({ ...s, reason: e.target.value }))}
                  rows={2}
                  placeholder="e.g. PROD is read-only by default in hosted mode"
                  className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border-subtle text-[12.5px] focus:outline-none focus:ring-1 focus:ring-accent resize-y"
                />
              </div>
            </div>

            <details className="mt-3">
              <summary className="text-[11.5px] text-text-muted cursor-pointer hover:text-text select-none">
                Advanced: change condition form (default: <code className="font-mono">selectors</code>)
              </summary>
              <div className="mt-2">
                <input
                  list="condition-presets"
                  placeholder="selectors"
                  value={form.condition}
                  onChange={(e) => setForm((s) => ({ ...s, condition: e.target.value }))}
                  className="w-full px-3 py-1.5 rounded-lg bg-surface border border-border-subtle text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <datalist id="condition-presets">
                  {CONDITION_FORMS.map((c) => <option key={c.value} value={c.value} />)}
                </datalist>
                <div className="text-[11px] text-text-muted mt-1">
                  Use <code className="font-mono">action:&lt;tool&gt;</code> for the coarse single-tool form. Otherwise leave as <code className="font-mono">selectors</code>.
                </div>
              </div>
            </details>
          </Section>
        </div>
      )}

      <div className="px-3 py-2 rounded-lg bg-info/10 border border-info/20 text-[12px] text-info flex items-start gap-2">
        <Info size={13} className="mt-0.5 shrink-0" />
        <span><strong>Preview:</strong> {previewSummary}</span>
      </div>

      {error && <p className="text-[12px] text-error">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={onSave}
          disabled={saving || !form.name.trim()}
          className="px-3 py-1.5 text-[13px] rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40"
        >{saving ? "Saving…" : "Save rule"}</button>
        <button onClick={onCancel} className="px-3 py-1.5 text-[13px] text-text-muted">Cancel</button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Dimension row — one of the 9 always-visible selector dimensions
// ────────────────────────────────────────────────────────────────────────

function DimensionRow({
  meta, value, onChange, tools,
}: {
  meta:     SelectorKeyMeta
  value:    string
  onChange: (v: string) => void
  tools:    ToolInfo[]
}) {
  const isActive = value !== ANY
  const valueDescription = meta.enumValues?.find((v) => v.value === value)?.description

  // Tool selector: special case — dropdown of known tools + glob wildcards + custom.
  const toolIsCustom = meta.key === "tool"
    && value !== ANY
    && !tools.some((t) => t.name === value)
    && !COMMON_TOOL_GLOBS.includes(value)

  return (
    <div className={`grid grid-cols-[140px_1fr] gap-3 px-3 py-2 ${isActive ? "bg-accent/5" : ""}`}>
      <div className="pt-1.5 min-w-0">
        <div className="text-[12.5px] text-text font-medium truncate" title={meta.description}>
          {meta.label}
        </div>
        <div className="text-[10.5px] text-text-faint font-mono truncate">{meta.key}</div>
      </div>

      <div className="min-w-0">
        {meta.type === "enum" ? (
          <Listbox<string>
            value={value}
            onChange={onChange}
            ariaLabel={meta.label}
            size="sm"
            variant="card"
            className="w-full font-mono"
            options={[
              { value: ANY, label: "Any (ignore this dimension)", hint: "—" },
              ...meta.enumValues!.map<ListboxOption<string>>((v) => ({
                value: v.value,
                label: v.value,
                hint:  v.description,
              })),
            ]}
          />
        ) : meta.key === "tool" ? (
          <div className="space-y-1">
            <Listbox<string>
              value={toolIsCustom ? "__custom__" : value}
              onChange={(v) => {
                if (v === "__custom__") {
                  onChange(toolIsCustom ? value : "mssql_*")
                } else {
                  onChange(v)
                }
              }}
              ariaLabel="Tool"
              size="sm"
              variant="card"
              className="w-full font-mono"
              options={[
                { value: ANY, label: "Any (ignore this dimension)", hint: "—" },
                ...COMMON_TOOL_GLOBS.map<ListboxOption<string>>((g) => ({
                  value: g, label: g, hint: "wildcard",
                })),
                ...tools.map<ListboxOption<string>>((t) => ({
                  value: t.name, label: t.name, hint: "tool",
                })),
                { value: "__custom__", label: "Custom (type a glob…)", hint: "free-text" },
              ]}
            />
            {toolIsCustom && (
              <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder="e.g. mssql_*"
                className="w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border-subtle text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent"
              />
            )}
          </div>
        ) : (
          <input
            value={value}
            placeholder={meta.placeholder ?? "Any (leave empty)"}
            onChange={(e) => onChange(e.target.value)}
            className={`w-full px-2.5 py-1.5 rounded-lg bg-surface border border-border-subtle text-[13px] font-mono focus:outline-none focus:ring-1 focus:ring-accent ${isActive ? "" : "text-text-muted"}`}
          />
        )}
        <div className="text-[11px] text-text-muted mt-0.5 leading-snug">
          {valueDescription ?? meta.description}
          {meta.examples && meta.type !== "enum" && !valueDescription && (
            <> · e.g. {meta.examples.slice(0, 3).map((ex, i) => (
              <span key={ex}>{i > 0 && ", "}<code className="font-mono">{ex}</code></span>
            ))}</>
          )}
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────
// Numbered section wrapper
// ────────────────────────────────────────────────────────────────────────

function Section({
  number, label, hint, children,
}: {
  number:   number
  label:    string
  hint?:    string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5 flex-wrap">
        <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-accent/15 text-accent text-[11px] font-semibold shrink-0">
          {number}
        </span>
        <h4 className="text-[13px] font-semibold text-text">{label}</h4>
        {hint && <span className="text-[11.5px] text-text-muted">— {hint}</span>}
      </div>
      {children}
    </div>
  )
}
