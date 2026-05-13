/**
 * PolicyEditor — full governance dashboard modal.
 *
 * Shows all agent tools with their permission state, allows full CRUD
 * on policy rules, and displays built-in security protections.
 */

import {
    AlertTriangle,
    Brain,
    ChevronDown,
    ChevronRight,
    Cpu,
    Database,
    Eye,
    EyeOff,
    FileEdit,
    FilePlus,
    FileSearch,
    FolderOpen,
    GitFork,
    Globe,
    MessageSquare,
    Network,
    Search,
    Shield,
    ShieldCheck,
    ShieldX,
    Terminal,
    Trash2,
    X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api"
import type { EnvOperation, PolicyRule, SyncEnvironmentAdmin, ToolInfo } from "../types"

interface Props {
  onClose: () => void
}

type Effect = "allow" | "deny" | "require_approval"

const EFFECTS: { value: Effect; label: string; icon: typeof ShieldCheck; color: string }[] = [
  { value: "allow", label: "Allow", icon: ShieldCheck, color: "text-success" },
  { value: "deny", label: "Deny", icon: ShieldX, color: "text-error" },
  { value: "require_approval", label: "Require Approval", icon: AlertTriangle, color: "text-warning" },
]

/** Icon mapping for known tools — falls back to Shield for unknown tools. */
const TOOL_ICONS: Record<string, typeof Shield> = {
  run_command: Terminal,
  read_file: FileSearch,
  write_file: FilePlus,
  append_file: FilePlus,
  replace_in_file: FileEdit,
  list_directory: FolderOpen,
  search_files: Search,
  fetch_url: Globe,
  browse_web: Globe,
  browser_check: Globe,
  ask_user: MessageSquare,
  think: Brain,
  query_mssql: Database,
  explore_mssql_schema: Database,
  discover_relationships: Network,
  profile_data: Database,
  inspect_definition: FileSearch,
  search_catalog: Search,
  delegate: GitFork,
  delegate_parallel: GitFork,
}

function getToolIcon(name: string): typeof Shield {
  return TOOL_ICONS[name] ?? Shield
}

const SHELL_BLOCKLIST = [
  "rm -rf /", "rm -rf /*", "mkfs", "dd if=", "> /dev/sd",
  "chmod -R 777 /", "fork bomb", "shutdown", "reboot", "halt",
  "init 0", "init 6", "systemctl poweroff", "systemctl reboot",
  "/etc/shadow", "/etc/passwd", "launchctl", "crontab",
]

const SSRF_BLOCKED = [
  "localhost", "127.0.0.1", "[::1]", "0.0.0.0",
  "10.*", "192.168.*", "172.16-31.*", "169.254.*",
  "*.local", "*.internal",
]

type Tab = "tools" | "rules" | "envs" | "model" | "security"

const ALL_OPS: EnvOperation[] = [
  "query_read", "schema_introspect", "sync_preview", "sync_execute", "ddl", "dml",
]

const SOURCE_BADGE: Record<NonNullable<PolicyRule["source"]>, { label: string; cls: string }> = {
  db:             { label: "operator",      cls: "text-accent bg-accent/10" },
  hosted_default: { label: "hosted default", cls: "text-text-muted bg-overlay-3" },
  env_derived:    { label: "env-derived",    cls: "text-warning bg-warning/10" },
}

export function PolicyEditor({ onClose }: Props) {
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>("tools")
  const [error, setError] = useState<string | null>(null)

  // Security section expand
  const [shellExpanded, setShellExpanded] = useState(false)
  const [ssrfExpanded, setSsrfExpanded] = useState(false)

  // Workspace
  const [wsPath, setWsPath] = useState("")
  const [wsOriginal, setWsOriginal] = useState("")
  const [wsSaving, setWsSaving] = useState(false)
  const [wsError, setWsError] = useState<string | null>(null)
  const [wsSaved, setWsSaved] = useState(false)

  // Reset data
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  // LLM config
  const [llmProvider, setLlmProvider] = useState("copilot")
  const [llmModel, setLlmModel] = useState("")
  const [llmApiKey, setLlmApiKey] = useState("")
  const [llmBaseUrl, setLlmBaseUrl] = useState("")
  const [llmSaving, setLlmSaving] = useState(false)
  const [llmSaved, setLlmSaved] = useState(false)
  const [llmError, setLlmError] = useState<string | null>(null)
  const [llmDefaults, setLlmDefaults] = useState<Record<string, { model: string; baseUrl: string; placeholder: string }>>({})
  const [showApiKey, setShowApiKey] = useState(false)
  const [llmActiveProvider, setLlmActiveProvider] = useState("")
  const [llmActiveModel, setLlmActiveModel] = useState("")

  // Selector rules tab state
  const [ruleFilter, setRuleFilter] = useState<"all" | "db" | "hosted_default" | "env_derived">("all")
  const [editingRule, setEditingRule] = useState<PolicyRule | null>(null)
  const [ruleForm, setRuleForm] = useState<{ name: string; effect: Effect; condition: string; parameters: string }>({
    name: "", effect: "allow", condition: "selectors", parameters: "{}",
  })
  const [ruleSaving, setRuleSaving] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)

  // Environments tab state
  const [envs, setEnvs] = useState<SyncEnvironmentAdmin[]>([])
  const [envSavingName, setEnvSavingName] = useState<string | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)

  const loadRules = useCallback(async () => {
    try {
      const [data, toolList] = await Promise.all([api.listPolicies(), api.listTools()])
      setRules(data)
      setTools(toolList)
    } catch {
      setError("Failed to load policies")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRules() }, [loadRules])

  const loadEnvs = useCallback(async () => {
    try { setEnvs(await api.listSyncEnvironments()) } catch { setEnvError("Failed to load environments") }
  }, [])
  useEffect(() => { loadEnvs() }, [loadEnvs])

  function startEditRule(r: PolicyRule | null): void {
    setRuleError(null)
    if (r) {
      setEditingRule(r)
      setRuleForm({
        name:       r.name,
        effect:     r.effect,
        condition:  r.condition,
        parameters: JSON.stringify(r.parameters ?? {}, null, 2),
      })
    } else {
      setEditingRule({} as PolicyRule)
      setRuleForm({ name: "", effect: "allow", condition: "selectors", parameters: '{\n  "selectors": {},\n  "priority": 50,\n  "reason": ""\n}' })
    }
  }
  async function saveRule(): Promise<void> {
    setRuleSaving(true); setRuleError(null)
    try {
      let parsed: Record<string, unknown> = {}
      if (ruleForm.parameters.trim()) {
        try { parsed = JSON.parse(ruleForm.parameters) as Record<string, unknown> }
        catch (e) { setRuleError(`Invalid JSON: ${e instanceof Error ? e.message : e}`); setRuleSaving(false); return }
      }
      await api.createPolicy({ name: ruleForm.name.trim(), effect: ruleForm.effect, condition: ruleForm.condition.trim(), parameters: parsed })
      await loadRules()
      setEditingRule(null)
    } catch {
      setRuleError("Save failed")
    } finally {
      setRuleSaving(false)
    }
  }
  async function saveEnv(name: string, fields: Record<string, unknown>): Promise<void> {
    setEnvSavingName(name); setEnvError(null)
    try {
      await api.updateSyncEnvironment(name, fields)
      await loadEnvs()
    } catch {
      setEnvError(`Failed to update ${name}`)
    } finally {
      setEnvSavingName(null)
    }
  }
  async function resetEnv(name: string): Promise<void> {
    setEnvSavingName(name); setEnvError(null)
    try {
      await api.resetSyncEnvironment(name)
      await loadEnvs()
    } catch {
      setEnvError(`Failed to reset ${name}`)
    } finally {
      setEnvSavingName(null)
    }
  }

  // Load workspace path
  useEffect(() => {
    api.getWorkspace().then((w) => {
      setWsPath(w.path)
      setWsOriginal(w.path)
    }).catch(() => {})
  }, [])

  // Load LLM config
  useEffect(() => {
    api.getLlmConfig().then((cfg) => {
      setLlmProvider(cfg.provider)
      setLlmModel(cfg.model)
      setLlmBaseUrl(cfg.baseUrl ?? "")
      setLlmDefaults(cfg.defaults ?? {})
      setLlmActiveProvider(cfg.provider)
      setLlmActiveModel(cfg.model)
    }).catch(() => {})
  }, [])

  async function handleSaveLlm() {
    setLlmSaving(true)
    setLlmError(null)
    setLlmSaved(false)
    try {
      const res = await api.setLlmConfig({
        provider: llmProvider,
        model: llmModel || undefined,
        apiKey: llmApiKey || undefined,
        baseUrl: llmBaseUrl || undefined,
      })
      setLlmActiveProvider(res.provider)
      setLlmActiveModel(res.model)
      setLlmApiKey("")
      setLlmSaved(true)
      setTimeout(() => setLlmSaved(false), 3000)
    } catch {
      setLlmError("Failed to save LLM config")
    } finally {
      setLlmSaving(false)
    }
  }

  async function handleSaveWorkspace() {
    setWsSaving(true)
    setWsError(null)
    setWsSaved(false)
    try {
      const res = await api.setWorkspace(wsPath)
      setWsOriginal(res.path)
      setWsPath(res.path)
      setWsSaved(true)
      setTimeout(() => setWsSaved(false), 3000)
    } catch {
      setWsError("Failed to update workspace. Check the path exists and is a directory.")
    } finally {
      setWsSaving(false)
    }
  }

  // Build a map of tool → rule for quick lookup
  const toolRuleMap = useMemo(() => {
    const map = new Map<string, PolicyRule>()
    for (const rule of rules) {
      // Match action:tool_name conditions
      const m = rule.condition.match(/^action:(\w+)$/)
      if (m) map.set(m[1], rule)
    }
    return map
  }, [rules])

  async function handleDelete(ruleName: string) {
    try {
      await api.deletePolicy(ruleName)
      setRules((prev) => prev.filter((r) => r.name !== ruleName))
    } catch {
      setError("Failed to delete rule")
    }
  }

  async function handleToolToggle(toolName: string, newEffect: Effect | "none") {
    setError(null)
    const existingRule = toolRuleMap.get(toolName)

    if (newEffect === "none") {
      // Remove the rule — tool is freely allowed
      if (existingRule) {
        await handleDelete(existingRule.name)
      }
      return
    }

    try {
      const ruleName = existingRule?.name ?? `policy-${toolName}`
      await api.createPolicy({
        name: ruleName,
        effect: newEffect,
        condition: `action:${toolName}`,
      })
      await loadRules()
    } catch {
      setError("Failed to update tool policy")
    }
  }

  function getEffectStyle(e: string) {
    return EFFECTS.find((ef) => ef.value === e) ?? EFFECTS[1]
  }

  const TABS: { id: Tab; label: string }[] = [
    { id: "tools", label: "Tool Permissions" },
    { id: "rules", label: `Selector Rules (${rules.length})` },
    { id: "envs", label: `Environments (${envs.length})` },
    { id: "model", label: "Model" },
    { id: "security", label: "Security" },
  ]

  const filteredRules = ruleFilter === "all"
    ? rules
    : rules.filter((r) => (r.source ?? "db") === ruleFilter)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-2 sm:p-4"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-xl sm:rounded-2xl w-full max-w-[720px] h-full sm:h-auto sm:max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            <Shield size={20} className="text-text-muted" />
            <h2 className="text-lg font-semibold text-text">Governance & Security</h2>
          </div>
          <button className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-6 pt-4 pb-3 shrink-0">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`px-4 py-1.5 text-sm rounded-lg transition-colors ${
                tab === t.id
                  ? "bg-overlay-3 text-text font-medium"
                  : "text-text-muted hover:text-text-secondary hover:bg-overlay-2"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mb-3 px-3 py-2 bg-error/10 text-error text-[13px] rounded-lg">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 pb-5 min-h-0">
          {loading ? (
            <div className="text-text-muted text-sm text-center py-8">Loading...</div>
          ) : tab === "tools" ? (
            /* ── Tool Permissions tab ──────────────────────── */
            <div className="space-y-2">
              <p className="text-sm text-text-muted mb-4">
                Each tool is <span className="text-success font-medium">allowed</span> by default.
                Set a policy to restrict or gate any tool.
              </p>
              {tools.map((tool) => {
                const rule = toolRuleMap.get(tool.name)
                const currentEffect = rule ? (rule.effect as Effect) : null
                const Icon = getToolIcon(tool.name)
                const effectStyle = currentEffect ? getEffectStyle(currentEffect) : null

                return (
                  <div key={tool.name} className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                    <div className="w-9 h-9 rounded-lg bg-overlay-2 flex items-center justify-center shrink-0">
                      <Icon size={16} className="text-text-secondary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="text-sm font-semibold text-text font-mono">{tool.name}</span>
                        {!currentEffect && (
                          <span className="text-[11px] uppercase font-semibold tracking-wider text-success">allowed</span>
                        )}
                        {effectStyle && (
                          <span className={`text-[11px] uppercase font-semibold tracking-wider ${effectStyle.color}`}>
                            {effectStyle.label}
                          </span>
                        )}
                      </div>
                      <div className="text-[13px] text-text-muted mt-0.5">{tool.description}</div>
                    </div>
                    <select
                      className="bg-overlay-3 text-text text-[13px] rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer shrink-0 border border-border-subtle"
                      value={currentEffect ?? "none"}
                      onChange={(e) => handleToolToggle(tool.name, e.target.value as Effect | "none")}
                    >
                      <option value="none">No policy</option>
                      <option value="allow">Allow</option>
                      <option value="deny">Deny</option>
                      <option value="require_approval">Require Approval</option>
                    </select>
                  </div>
                )
              })}
            </div>
          ) : tab === "rules" ? (
            /* ── Selector Rules tab ───────────────────────── */
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <p className="text-sm text-text-muted flex-1 min-w-0">
                  Every active policy rule with provenance. Operator edits override seeded defaults.
                  <span className="text-warning"> Deleting a hosted-default or env-derived rule will be re-seeded on next server boot — edit the effect instead.</span>
                </p>
                <select
                  className="bg-overlay-3 text-text text-[13px] rounded-lg px-3 py-1.5 outline-none border border-border-subtle"
                  value={ruleFilter}
                  onChange={(e) => setRuleFilter(e.target.value as typeof ruleFilter)}
                >
                  <option value="all">All sources</option>
                  <option value="db">Operator only</option>
                  <option value="hosted_default">Hosted default</option>
                  <option value="env_derived">Env-derived</option>
                </select>
                <button
                  className="px-3 py-1.5 text-[13px] rounded-lg bg-accent/20 text-accent hover:bg-accent/30"
                  onClick={() => startEditRule(null)}
                >+ New rule</button>
              </div>

              {editingRule && (
                <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-accent/30 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold text-text">{ruleForm.name && rules.find((r) => r.name === ruleForm.name) ? "Edit rule" : "New rule"}</span>
                    <button onClick={() => setEditingRule(null)} className="text-text-muted hover:text-text"><X size={14} /></button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <input
                      placeholder="rule name"
                      value={ruleForm.name}
                      onChange={(e) => setRuleForm((s) => ({ ...s, name: e.target.value }))}
                      className="px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-[13px] font-mono"
                    />
                    <select
                      value={ruleForm.effect}
                      onChange={(e) => setRuleForm((s) => ({ ...s, effect: e.target.value as Effect }))}
                      className="px-3 py-1.5 rounded-lg bg-overlay-3 border border-border-subtle text-[13px]"
                    >
                      <option value="allow">allow</option>
                      <option value="deny">deny</option>
                      <option value="require_approval">require_approval</option>
                    </select>
                    <input
                      placeholder='condition (e.g. "selectors" or "action:run_command")'
                      value={ruleForm.condition}
                      onChange={(e) => setRuleForm((s) => ({ ...s, condition: e.target.value }))}
                      className="px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-[13px] font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[12px] text-text-muted block mb-1">Parameters (JSON — supports <code>selectors</code>, <code>priority</code>, <code>reason</code>)</label>
                    <textarea
                      value={ruleForm.parameters}
                      onChange={(e) => setRuleForm((s) => ({ ...s, parameters: e.target.value }))}
                      rows={6}
                      className="w-full px-3 py-2 rounded-lg bg-overlay-2 border border-border-subtle text-[12px] font-mono"
                    />
                  </div>
                  {ruleError && <p className="text-[12px] text-error">{ruleError}</p>}
                  <div className="flex gap-2">
                    <button onClick={saveRule} disabled={ruleSaving || !ruleForm.name.trim()}
                      className="px-3 py-1.5 text-[13px] rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40">
                      {ruleSaving ? "Saving…" : "Save"}
                    </button>
                    <button onClick={() => setEditingRule(null)} className="px-3 py-1.5 text-[13px] text-text-muted">Cancel</button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                {filteredRules.map((r) => {
                  const src = (r.source ?? "db") as NonNullable<PolicyRule["source"]>
                  const badge = SOURCE_BADGE[src]
                  const eff = getEffectStyle(r.effect)
                  const EffIcon = eff.icon
                  return (
                    <div key={r.name} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-overlay-2 border border-border-subtle">
                      <EffIcon size={14} className={eff.color} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13px] font-mono text-text truncate">{r.name}</span>
                          <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
                          {r.updatedAt && <span className="text-[10px] text-text-muted">edited by {r.updatedBy ?? "?"}</span>}
                        </div>
                        <div className="text-[12px] text-text-muted truncate">{r.condition} · prio {String((r.parameters as { priority?: number } | undefined)?.priority ?? "—")}</div>
                      </div>
                      <button onClick={() => startEditRule(r)} className="text-text-muted hover:text-text text-[12px] px-2">Edit</button>
                      <button onClick={() => handleDelete(r.name)} className="text-error/70 hover:text-error p-1"><Trash2 size={13} /></button>
                    </div>
                  )
                })}
                {filteredRules.length === 0 && (
                  <div className="text-text-muted text-[13px] text-center py-6">No rules match this filter.</div>
                )}
              </div>
            </div>
          ) : tab === "envs" ? (
            /* ── Environments tab ─────────────────────────── */
            <div className="space-y-3">
              <p className="text-sm text-text-muted">
                Per-environment access control for hosted MSSQL operations. The JSON config in
                <code className="font-mono text-text"> deploy/mssql/sync-environments.json</code> is the bootstrap;
                edits here are stored as overrides that win at merge time. <span className="text-warning">Changes apply to the next run start (no restart needed).</span>
              </p>
              {envError && <div className="px-3 py-2 bg-error/10 text-error text-[13px] rounded-lg">{envError}</div>}
              {envs.map((e) => (
                <EnvCard
                  key={e.name}
                  env={e}
                  busy={envSavingName === e.name}
                  onSave={(fields) => saveEnv(e.name, fields)}
                  onReset={() => resetEnv(e.name)}
                />
              ))}
              {envs.length === 0 && (
                <div className="text-text-muted text-[13px] text-center py-6">No sync environments configured.</div>
              )}
            </div>
          ) : tab === "model" ? (
            /* ── Model tab ────────────────────────────────── */
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-text-muted">Configure the LLM provider and model used by the agent.</p>
                {llmActiveProvider && (
                  <span className="flex items-center gap-1.5 text-[12px] text-text-muted bg-overlay-2 border border-border-subtle rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                    {llmActiveProvider} / {llmActiveModel}
                  </span>
                )}
              </div>

              {/* Provider selector */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Cpu size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Provider</span>
                </div>
                <p className="text-[13px] text-text-muted leading-relaxed mb-3">
                  Choose the LLM backend. Switching provider updates the model and URL defaults below.
                </p>
                <div className="flex gap-2 flex-wrap">
                  {(["copilot-chat", "copilot", "databricks", "openai", "anthropic", "local"] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setLlmProvider(p)
                        setLlmModel(llmDefaults[p]?.model ?? "")
                        setLlmBaseUrl(llmDefaults[p]?.baseUrl ?? "")
                        setLlmApiKey("")
                      }}
                      className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors border ${
                        llmProvider === p
                          ? "bg-accent/20 text-accent border-accent/30"
                          : "bg-overlay-2 text-text-muted border-border-subtle hover:text-text hover:bg-overlay-3"
                      }`}
                    >
                      {p === "copilot-chat" ? "Copilot Chat" : p === "copilot" ? "GitHub Models" : p === "databricks" ? "Databricks" : p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Local (Ollama)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Model + credentials combined card */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-3">
                  <Cpu size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Connection</span>
                </div>
                <div className="space-y-3 mb-4">
                  {/* Model */}
                  <div>
                    <label className="text-[13px] text-text-muted block mb-1.5">Model</label>
                    <input
                      type="text"
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      placeholder={llmDefaults[llmProvider]?.model ?? "model name"}
                      className="w-full px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
                    />
                  </div>

                  {/* API Key — hidden for local and databricks (M2M from .env) */}
                  {llmProvider !== "local" && llmProvider !== "databricks" && (
                    <div>
                      <label className="text-[13px] text-text-muted block mb-1.5">
                        {llmProvider === "copilot-chat" || llmProvider === "copilot" ? "GitHub Token" : llmProvider === "anthropic" ? "Anthropic API Key" : "OpenAI API Key"}
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder={llmDefaults[llmProvider]?.placeholder ?? "Leave blank to keep existing"}
                          className="w-full px-3 py-1.5 pr-10 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                        >
                          {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <p className="text-[12px] text-text-muted mt-1">Leave blank to keep the existing key.</p>
                    </div>
                  )}

                  {/* Base URL — shown for openai and local */}
                  {(llmProvider === "openai" || llmProvider === "local") && (
                    <div>
                      <label className="text-[13px] text-text-muted block mb-1.5">Base URL</label>
                      <input
                        type="text"
                        value={llmBaseUrl}
                        onChange={(e) => setLlmBaseUrl(e.target.value)}
                        placeholder={llmDefaults[llmProvider]?.baseUrl ?? "https://api.openai.com/v1"}
                        className="w-full px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
                      />
                      {llmProvider === "local" && (
                        <p className="text-[12px] text-text-muted mt-1">Default: <code className="font-mono">http://localhost:11434/v1</code> for Ollama.</p>
                      )}
                    </div>
                  )}
                </div>

                {/* Save */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveLlm}
                    disabled={llmSaving}
                    className="px-3 py-1.5 rounded-lg bg-accent/20 text-accent text-sm font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {llmSaving ? "Saving…" : "Apply"}
                  </button>
                  {llmSaved && <span className="text-[13px] text-success">Saved — active on next run</span>}
                  {llmError && <span className="text-[13px] text-error">{llmError}</span>}
                </div>
              </div>
            </div>
          ) : (
            /* ── Security tab ─────────────────────────────── */
            <div className="space-y-4">
              <p className="text-sm text-text-muted">
                Built-in security protections. These are always active and cannot be disabled.
              </p>

              {/* Workspace */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-2">
                  <FolderOpen size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Workspace</span>
                </div>
                <p className="text-[13px] text-text-muted leading-relaxed mb-3">
                  File and shell operations are scoped to this directory. The agent cannot access files outside.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={wsPath}
                    onChange={(e) => setWsPath(e.target.value)}
                    placeholder="/path/to/workspace"
                    className="flex-1 px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
                  />
                  <button
                    onClick={handleSaveWorkspace}
                    disabled={wsSaving || wsPath === wsOriginal}
                    className="px-3 py-1.5 rounded-lg bg-accent/20 text-accent text-sm font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {wsSaving ? "Saving…" : "Apply"}
                  </button>
                </div>
                {wsError && <p className="text-[12px] text-error mt-1.5">{wsError}</p>}
                {wsSaved && <p className="text-[12px] text-success mt-1.5">Workspace updated</p>}
              </div>

              {/* Shell blocklist */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <button
                  className="flex items-center gap-2.5 w-full text-left"
                  onClick={() => setShellExpanded((v) => !v)}
                >
                  {shellExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <Terminal size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Shell Command Blocklist</span>
                  <span className="text-[12px] text-text-muted ml-auto">{SHELL_BLOCKLIST.length} patterns</span>
                </button>
                {shellExpanded && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {SHELL_BLOCKLIST.map((p) => (
                      <span
                        key={p}
                        className="px-2 py-0.5 text-[11px] font-mono text-error/80 bg-error/5 rounded"
                      >
                        {p}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* SSRF protection */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <button
                  className="flex items-center gap-2.5 w-full text-left"
                  onClick={() => setSsrfExpanded((v) => !v)}
                >
                  {ssrfExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <Globe size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">SSRF Protection</span>
                  <span className="text-[12px] text-text-muted ml-auto">{SSRF_BLOCKED.length} patterns</span>
                </button>
                {ssrfExpanded && (
                  <div className="mt-3">
                    <p className="text-[12px] text-text-muted mb-2">
                      The fetch_url tool blocks requests to internal/private network addresses:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {SSRF_BLOCKED.map((p) => (
                        <span
                          key={p}
                          className="px-2 py-0.5 text-[11px] font-mono text-warning/80 bg-warning/5 rounded"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Policy enforcement */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Shield size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Policy Enforcement</span>
                </div>
                <p className="text-[13px] text-text-muted leading-relaxed">
                  All policy rules are evaluated <strong>before every tool call</strong>.
                  Denied actions throw an error immediately. "Require Approval" blocks
                  the agent until approved. Rules apply to all new runs.
                </p>
              </div>

              {/* Reset data */}
              <div className="h-px bg-overlay-3 my-1" />

              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Trash2 size={15} className="text-error" />
                  <span className="text-sm font-semibold text-text">Restore Defaults</span>
                </div>
                <p className="text-[13px] text-text-muted leading-relaxed mb-3">
                  Delete all runs, logs, audit entries, trace history, checkpoints, and token usage.
                  <strong> Policies and dashboard layout will be preserved.</strong>
                </p>
                {!confirmReset ? (
                  <button
                    className="px-4 py-2 text-[13px] text-error hover:bg-error/10 border border-error/20 rounded-lg"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset All Data
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-[13px] text-error">Are you sure?</span>
                    <button
                      className="px-4 py-2 text-[13px] bg-error text-text rounded-lg disabled:opacity-40"
                      disabled={resetting}
                      onClick={async () => {
                        setResetting(true)
                        try {
                          await api.resetData()
                          window.location.reload()
                        } catch {
                          setError("Failed to reset data")
                          setResetting(false)
                          setConfirmReset(false)
                        }
                      }}
                    >
                      {resetting ? "Resetting..." : "Yes, Delete Everything"}
                    </button>
                    <button
                      className="px-3 py-2 text-[13px] text-text-muted hover:text-text rounded-lg"
                      onClick={() => setConfirmReset(false)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Env permission card ──────────────────────────────────────────

interface EnvCardProps {
  env:    SyncEnvironmentAdmin
  busy:   boolean
  onSave: (fields: Record<string, unknown>) => void
  onReset: () => void
}

function EnvCard({ env, busy, onSave, onReset }: EnvCardProps) {
  const [mode, setMode]       = useState(env.defaultAccessMode)
  const [denyDml, setDenyDml] = useState(env.denyDml)
  const [denyDdl, setDenyDdl] = useState(env.denyDdl)
  const [allowed, setAllowed] = useState<EnvOperation[]>(env.allowedOperations)
  const [approval, setApproval] = useState<EnvOperation[]>(env.approvalRequiredOperations)

  const dirty =
    mode !== env.defaultAccessMode ||
    denyDml !== env.denyDml ||
    denyDdl !== env.denyDdl ||
    JSON.stringify(allowed.slice().sort())  !== JSON.stringify(env.allowedOperations.slice().sort()) ||
    JSON.stringify(approval.slice().sort()) !== JSON.stringify(env.approvalRequiredOperations.slice().sort())

  function toggleOp(list: EnvOperation[], setList: (v: EnvOperation[]) => void, op: EnvOperation): void {
    setList(list.includes(op) ? list.filter((o) => o !== op) : [...list, op])
  }

  const lockedDown = mode === "read_only"

  return (
    <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-semibold text-text font-mono">{env.name}</span>
          <span className="text-[11px] uppercase tracking-wider text-text-muted">{env.role}</span>
          {env.override && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/10 text-warning">
              overridden by {env.override.updatedBy ?? "?"}
            </span>
          )}
        </div>
        {env.override && (
          <button onClick={onReset} disabled={busy}
            className="text-[12px] text-text-muted hover:text-text underline">Reset to JSON default</button>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-[12px] text-text-muted block mb-1">Default access mode</label>
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}
            className="w-full px-3 py-1.5 rounded-lg bg-overlay-3 border border-border-subtle text-[13px]">
            <option value="read_only">read_only</option>
            <option value="read_write">read_write</option>
          </select>
        </div>
        <div className="flex items-end gap-4">
          <label className="flex items-center gap-2 text-[13px] text-text">
            <input type="checkbox" checked={denyDml} onChange={(e) => setDenyDml(e.target.checked)} />
            denyDml
          </label>
          <label className="flex items-center gap-2 text-[13px] text-text">
            <input type="checkbox" checked={denyDdl} onChange={(e) => setDenyDdl(e.target.checked)} />
            denyDdl
          </label>
        </div>
      </div>

      <div>
        <label className="text-[12px] text-text-muted block mb-1.5">Allowed operations</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_OPS.map((op) => {
            const on = allowed.includes(op)
            return (
              <button key={op} onClick={() => toggleOp(allowed, setAllowed, op)}
                className={`text-[12px] px-2 py-0.5 rounded-full border ${on ? "bg-success/10 text-success border-success/30" : "bg-overlay-3 text-text-muted border-border-subtle"}`}>
                {op}
              </button>
            )
          })}
        </div>
      </div>

      <div>
        <label className="text-[12px] text-text-muted block mb-1.5">Operations requiring approval</label>
        <div className="flex flex-wrap gap-1.5">
          {ALL_OPS.map((op) => {
            const on = approval.includes(op)
            return (
              <button key={op} onClick={() => toggleOp(approval, setApproval, op)}
                className={`text-[12px] px-2 py-0.5 rounded-full border ${on ? "bg-warning/10 text-warning border-warning/30" : "bg-overlay-3 text-text-muted border-border-subtle"}`}>
                {op}
              </button>
            )
          })}
        </div>
      </div>

      {lockedDown && (
        <p className="text-[12px] text-text-muted">
          Read-only mode: write tools are denied unless explicitly listed under Allowed operations above.
        </p>
      )}

      <div className="flex items-center gap-2">
        <button
          disabled={!dirty || busy}
          onClick={() => onSave({
            defaultAccessMode:          mode,
            denyDml,
            denyDdl,
            allowedOperations:          allowed,
            approvalRequiredOperations: approval,
          })}
          className="px-3 py-1.5 text-[13px] rounded-lg bg-accent/20 text-accent hover:bg-accent/30 disabled:opacity-40 disabled:cursor-not-allowed"
        >{busy ? "Saving…" : dirty ? "Save changes" : "Saved"}</button>
        {dirty && <span className="text-[12px] text-text-muted">unsaved changes</span>}
      </div>
    </div>
  )
}
