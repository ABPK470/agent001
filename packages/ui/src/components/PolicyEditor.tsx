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
import type { PolicyRule, ToolInfo } from "../types"
import { SelectorRulesTab } from "./policy/SelectorRulesTab"
import { modalOverlayClass, MODAL_ADMIN_PANEL, MODAL_SURFACE_CLASS } from "../widgets/entity-registry/modal-overlay"

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

type Tab = "tools" | "rules" | "model" | "security" | "platform"

export function PolicyEditor({ onClose }: Props) {
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>("tools")
  const [error, setError] = useState<string | null>(null)

  // Security section expand
  const [shellExpanded, setShellExpanded] = useState(false)
  const [ssrfExpanded, setSsrfExpanded] = useState(false)
  const [sqlGuardExpanded, setSqlGuardExpanded] = useState(false)

  // Workspace
  const [wsPath, setWsPath] = useState("")
  const [wsOriginal, setWsOriginal] = useState("")
  const [wsSaving, setWsSaving] = useState(false)
  const [wsError, setWsError] = useState<string | null>(null)
  const [wsSaved, setWsSaved] = useState(false)

  // Reset data
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)

  // Factory reset platform (entity defs + published bundle)
  const [confirmFactoryReset, setConfirmFactoryReset] = useState(false)
  const [factoryResetPhrase, setFactoryResetPhrase] = useState("")
  const [factoryResetting, setFactoryResetting] = useState(false)

  // Platform health (sync readiness)
  const [platformHealth, setPlatformHealth] = useState<Awaited<ReturnType<typeof api.getPlatformHealth>> | null>(null)
  const [catalogRebuilding, setCatalogRebuilding] = useState(false)
  const [catalogRebuildMessage, setCatalogRebuildMessage] = useState<string | null>(null)
  const [artifactsRefreshing, setArtifactsRefreshing] = useState<"shipped" | "mssql" | null>(null)
  const [artifactsMessage, setArtifactsMessage] = useState<string | null>(null)
  const [mssqlConnection, setMssqlConnection] = useState("")

  // LLM config
  const [llmProvider, setLlmProvider] = useState("databricks")
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

  useEffect(() => {
    api.getPlatformHealth()
      .then((health) => {
        setPlatformHealth(health)
        if (health.mssql.connections[0]) {
          setMssqlConnection(health.mssql.connections[0])
        }
      })
      .catch(() => setPlatformHealth(null))
  }, [])

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
    { id: "model", label: "Model" },
    { id: "platform", label: "Platform" },
    { id: "security", label: "Security" },
  ]

  return (
    <div
      className={modalOverlayClass("detail")}
      onClick={onClose}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} policy-editor-modal ${MODAL_ADMIN_PANEL} flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            <Shield size={22} className="text-text-muted" />
            <h2 className="text-xl font-semibold text-text">Governance & Security</h2>
          </div>
          <button className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1.5 px-7 pt-4 pb-3 shrink-0 border-b border-border-subtle overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`px-4 py-2 text-sm rounded-lg transition-colors whitespace-nowrap ${
                tab === t.id
                  ? "bg-accent/15 text-accent font-medium"
                  : "text-text-muted hover:text-text hover:bg-overlay-2"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab subtitle / context — explains what THIS tab governs vs the others. */}
        <div className="px-7 pt-3.5 pb-2.5 shrink-0">
          <p className="text-sm text-text-muted leading-relaxed">
            {tab === "tools"    && <><strong className="text-text">Tool Permissions</strong> — coarse-grained on/off for every tool, regardless of arguments. Sets simple <code className="font-mono">action:&lt;tool&gt;</code> rules. For nuanced control (per-environment, per-command, per-path) use <em>Selector Rules</em>.</>}
            {tab === "rules"    && <><strong className="text-text">Selector Rules</strong> — the full policy engine. Each rule matches on selectors (tool, path, command regex, dbEnvironment, scope, etc.) and resolves by priority. Includes baseline hosted defaults and per-env-derived rules; you can override or augment any of them.</>}
            {tab === "model"    && <><strong className="text-text">Model</strong> — LLM provider, model, credentials. Active on the next run.</>}
            {tab === "platform" && <><strong className="text-text">Platform</strong> — MSSQL schema catalog (core agent infrastructure) and deploy/sync artifact import. Schema catalog is separate from Entity Registry publish.</>}
            {tab === "security" && <><strong className="text-text">Security</strong> — built-in protections (shell blocklist, SSRF guards, SQL engine invariants). The Workspace path here is the <em>developer-mode</em> root used when <code className="font-mono">AGENT_HOSTED_MODE</code> is off; in hosted mode each run gets its own isolated sandbox and this field is ignored.</>}
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-7 mb-3 px-3 py-2 bg-error/10 text-error text-sm rounded-lg">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-7 pb-6 min-h-0">
          {loading ? (
            <div className="text-text-muted text-sm text-center py-8">Loading...</div>
          ) : tab === "tools" ? (
            /* ── Tool Permissions tab ──────────────────────── */
            <div className="space-y-2">
              <div className="mb-4 px-3 py-2 rounded-lg bg-overlay-2/50 border border-border-subtle text-sm text-text-muted">
                Each tool is <span className="text-success font-medium">allowed by default</span>.
                Selecting a state here writes an <code className="font-mono">action:&lt;tool&gt;</code> rule into Selector Rules.
              </div>
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
                          <span className="text-xs uppercase font-semibold tracking-wider text-success">allowed</span>
                        )}
                        {effectStyle && (
                          <span className={`text-xs uppercase font-semibold tracking-wider ${effectStyle.color}`}>
                            {effectStyle.label}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-text-muted mt-0.5 line-clamp-2">{tool.description}</div>
                    </div>
                    <EffectSegmented
                      value={currentEffect}
                      onChange={(v) => handleToolToggle(tool.name, v)}
                    />
                  </div>
                )
              })}
            </div>
          ) : tab === "rules" ? (
            /* ── Selector Rules tab — see ./policy/SelectorRulesTab.tsx ── */
            <SelectorRulesTab
              rules={rules}
              tools={tools}
              onReload={loadRules}
              onDelete={handleDelete}
            />
          ) : tab === "model" ? (
            /* ── Model tab ────────────────────────────────── */
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-text-muted">Configure the LLM provider and model used by the agent.</p>
                {llmActiveProvider && (
                  <span className="flex items-center gap-1.5 text-sm text-text-muted bg-overlay-2 border border-border-subtle rounded-full px-3 py-1">
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
                <p className="text-sm text-text-muted leading-relaxed mb-3">
                  Choose the LLM backend. Switching provider updates the model and URL defaults below.
                </p>
                <div className="flex gap-2 flex-wrap">
                  {(["copilot-chat", "databricks"] as const).map((p) => (
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
                      {p === "copilot-chat" ? "Copilot Chat" : "Databricks"}
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
                    <label className="text-sm text-text-muted block mb-1.5">
                      {llmProvider === "databricks" ? "Serving endpoint" : "Model"}
                    </label>
                    <input
                      type="text"
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      placeholder={llmDefaults[llmProvider]?.model ?? "model name"}
                      className="w-full px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm"
                    />
                  </div>

                  {/* API Key — only shown for copilot-chat (Device Flow auto-fills if blank). */}
                  {llmProvider === "copilot-chat" && (
                    <div>
                      <label className="text-sm text-text-muted block mb-1.5">
                        GitHub Token
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder={llmDefaults[llmProvider]?.placeholder ?? "Leave blank to keep existing"}
                          className="w-full px-3 py-1.5 pr-10 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm"
                        />
                        <button
                          type="button"
                          onClick={() => setShowApiKey((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                        >
                          {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      <p className="text-sm text-text-muted mt-1">Leave blank to keep the existing key.</p>
                    </div>
                  )}

                  {/* Base URL — not shown; copilot-chat & databricks both auto-resolve */}
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
                  {llmSaved && <span className="text-sm text-success">Saved — active on next run</span>}
                  {llmError && <span className="text-sm text-error">{llmError}</span>}
                </div>
              </div>
            </div>
          ) : tab === "security" ? (
            /* ── Security tab ─────────────────────────────── */
            <div className="space-y-4">
              <p className="text-sm text-text-muted">
                Built-in security protections. These are always active and cannot be disabled.
              </p>

              {/* Workspace */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-2">
                  <FolderOpen size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Workspace (developer mode)</span>
                </div>
                <p className="text-sm text-text-muted leading-relaxed mb-2">
                  Root for <code className="font-mono text-text">read_file</code>, <code className="font-mono text-text">write_file</code>,
                  <code className="font-mono text-text"> run_command</code> and friends when the server is running in
                  <strong className="text-text"> developer mode</strong> (<code className="font-mono">AGENT_HOSTED_MODE</code> unset). Every run shares this directory.
                </p>
                <p className="text-sm text-warning/90 leading-relaxed mb-3">
                  ⚠ In <strong>hosted mode</strong> this field is ignored — each run gets its own isolated sandbox under <code className="font-mono">runWorkspaceRoot</code>, and the agent cannot reach this path.
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={wsPath}
                    onChange={(e) => setWsPath(e.target.value)}
                    placeholder="/path/to/workspace"
                    className="flex-1 px-3 py-1.5 rounded-lg bg-overlay-2 border border-border-subtle text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-sm"
                  />
                  <button
                    onClick={handleSaveWorkspace}
                    disabled={wsSaving || wsPath === wsOriginal}
                    className="px-3 py-1.5 rounded-lg bg-accent/20 text-accent text-sm font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {wsSaving ? "Saving…" : "Apply"}
                  </button>
                </div>
                {wsError && <p className="text-sm text-error mt-1.5">{wsError}</p>}
                {wsSaved && <p className="text-sm text-success mt-1.5">Workspace updated</p>}
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
                  <span className="text-sm text-text-muted ml-auto">{SHELL_BLOCKLIST.length} patterns</span>
                </button>
                {shellExpanded && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {SHELL_BLOCKLIST.map((p) => (
                      <span
                        key={p}
                        className="px-2 py-0.5 text-xs font-mono text-error/80 bg-error/5 rounded"
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
                  <span className="text-sm text-text-muted ml-auto">{SSRF_BLOCKED.length} patterns</span>
                </button>
                {ssrfExpanded && (
                  <div className="mt-3">
                    <p className="text-sm text-text-muted mb-2">
                      The fetch_url tool blocks requests to internal/private network addresses:
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {SSRF_BLOCKED.map((p) => (
                        <span
                          key={p}
                          className="px-2 py-0.5 text-xs font-mono text-warning/80 bg-warning/5 rounded"
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
                <p className="text-sm text-text-muted leading-relaxed">
                  All policy rules are evaluated <strong>before every tool call</strong>.
                  Denied actions throw an error immediately. "Require Approval" blocks
                  the agent until approved. Rules apply to all new runs.
                </p>
              </div>

              {/* SQL engine invariants — hard-coded in the tool layer, not policy-editable */}
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <button
                  className="flex items-center gap-2.5 w-full text-left"
                  onClick={() => setSqlGuardExpanded((v) => !v)}
                >
                  {sqlGuardExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <Database size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">SQL Engine Invariants</span>
                  <span className="text-sm text-text-muted ml-auto">read-only · enforced in tool layer</span>
                </button>
                {sqlGuardExpanded && (
                  <div className="mt-3 space-y-2.5">
                    <p className="text-sm text-text-muted leading-relaxed">
                      These rails are baked into <code className="font-mono text-text">query_mssql</code> /
                      <code className="font-mono text-text"> export_query_to_file</code> at the agent layer
                      (<code className="font-mono text-text">packages/agent/src/tools/mssql/validation.ts</code>).
                      They are <strong>not</strong> stored in the policy DB and are intentionally
                      <strong> not operator-toggleable</strong> — weakening them would let the agent
                      mutate production data.
                    </p>
                    <ul className="text-sm text-text-secondary leading-relaxed space-y-1.5 pl-1">
                      <li><span className="text-success font-medium">✓ ALLOWED on local <code className="font-mono">#temp</code> tables</span> — <code className="font-mono">CREATE TABLE</code>, <code className="font-mono">SELECT … INTO</code>, <code className="font-mono">INSERT</code>, <code className="font-mono">UPDATE</code>, <code className="font-mono">DELETE</code>, <code className="font-mono">CREATE INDEX</code>, <code className="font-mono">TRUNCATE</code>, <code className="font-mono">DROP</code>, <code className="font-mono">MERGE</code>.</li>
                      <li><span className="text-error font-medium">✗ BLOCKED forever</span> — any mutation (CREATE/INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/MERGE/CREATE INDEX/SELECT INTO) targeting an <strong>existing real table, view, index, procedure, schema</strong>, or <code className="font-mono">sys.*</code> object.</li>
                      <li><span className="text-error font-medium">✗ BLOCKED</span> — global <code className="font-mono">##temp</code> tables (would survive past the session and leak across runs). Only single-<code className="font-mono">#</code> local temps are permitted.</li>
                      <li><span className="text-error font-medium">✗ BLOCKED</span> — <code className="font-mono">EXEC</code>, <code className="font-mono">sp_executesql</code>, <code className="font-mono">xp_*</code>, <code className="font-mono">OPENROWSET</code>, <code className="font-mono">OPENQUERY</code>, <code className="font-mono">BULK INSERT</code>, <code className="font-mono">DBCC</code>, <code className="font-mono">SHUTDOWN</code>, <code className="font-mono">RECONFIGURE</code>.</li>
                      <li><span className="text-text-muted">ℹ Per-row safety cap</span> — <code className="font-mono">query_mssql</code> hard-limits to 1 000 rows; use <code className="font-mono">export_query_to_file</code> for larger pulls.</li>
                    </ul>
                    <p className="text-sm text-text-muted/80 leading-relaxed pt-2 border-t border-border-subtle/40">
                      Want to relax this? You can't, by design. To stage data, the agent uses a <code className="font-mono text-text">#temp</code> table
                      and follows the micro-ETL pattern (that prompt section is injected only on data-shaped goals to keep token cost low for non-DB chats).
                    </p>
                  </div>
                )}
              </div>

              {/* Reset data */}
              <div className="h-px bg-overlay-3 my-1" />

              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Trash2 size={15} className="text-error" />
                  <span className="text-sm font-semibold text-text">Restore Defaults</span>
                </div>
                <p className="text-sm text-text-muted leading-relaxed mb-3">
                  Delete all runs, logs, audit entries, trace history, checkpoints, and token usage.
                  <strong> Policies and dashboard layout will be preserved.</strong>
                </p>
                {!confirmReset ? (
                  <button
                    className="px-4 py-2 text-sm text-error hover:bg-error/10 border border-error/20 rounded-lg"
                    onClick={() => setConfirmReset(true)}
                  >
                    Reset All Data
                  </button>
                ) : (
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-error">Are you sure?</span>
                    <button
                      className="px-4 py-2 text-sm bg-error text-text rounded-lg disabled:opacity-40"
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
                      className="px-3 py-2 text-sm text-text-muted hover:text-text rounded-lg"
                      onClick={() => setConfirmReset(false)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>

            </div>
          ) : tab === "platform" ? (
            /* ── Platform tab (schema catalog + sync artifacts) ── */
            <div className="space-y-4">
              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Database size={15} className="text-accent" />
                  <span className="text-sm font-semibold text-text">MSSQL schema catalog</span>
                </div>
                <p className="text-sm text-text-muted leading-relaxed mb-3">
                  Introspected table/FK metadata cached on disk for <code className="font-mono text-text">search_catalog</code>,
                  schema exploration tools, and Entity Registry “Suggest from schema”. Built from live MSSQL — not from shipped
                  sync artifacts or Entity Registry publish.
                </p>
                {platformHealth && (
                  <div className="text-sm text-text-secondary space-y-1 mb-3">
                    <p>
                      MSSQL: {platformHealth.mssql.configured ? platformHealth.mssql.summary : "not configured"}
                      {platformHealth.catalog.available && platformHealth.catalog.detail
                        ? ` · Catalog: ${platformHealth.catalog.detail}`
                        : platformHealth.mssql.configured
                          ? " · Catalog: missing"
                          : ""}
                    </p>
                    <p>
                      Sync entities: {platformHealth.entities.count}
                      {platformHealth.publish.definitionCount > 0
                        ? ` · Published: ${platformHealth.publish.definitionCount}`
                        : " · Not published"}
                    </p>
                    {!platformHealth.catalog.available && platformHealth.mssql.configured && (
                      <p className="text-warning/90 pt-1">
                        Rebuild the schema catalog while MSSQL is reachable (button below).
                      </p>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="px-4 py-2 text-sm text-accent border border-accent/30 rounded-lg hover:bg-accent/10 disabled:opacity-40"
                  disabled={catalogRebuilding || !platformHealth?.mssql.configured}
                  onClick={async () => {
                    setCatalogRebuilding(true)
                    setCatalogRebuildMessage(null)
                    try {
                      const result = await api.rebuildPlatformCatalog()
                      setCatalogRebuildMessage(result.message)
                      const next = await api.getPlatformHealth()
                      setPlatformHealth(next)
                    } catch (err) {
                      setCatalogRebuildMessage(err instanceof Error ? err.message : "Catalog rebuild failed")
                    } finally {
                      setCatalogRebuilding(false)
                    }
                  }}
                >
                  {catalogRebuilding ? "Rebuilding catalog…" : "Rebuild schema catalog"}
                </button>
                {catalogRebuildMessage && (
                  <p className="text-sm text-text-muted mt-2">{catalogRebuildMessage}</p>
                )}
              </div>

              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Database size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Deploy sync artifacts</span>
                </div>
                <p className="text-sm text-text-muted leading-relaxed mb-3">
                  Import entity definitions and sync step catalog into SQLite from bundled release files or by
                  regenerating from live MyMI/MSSQL. After import, <strong>publish from Entity Registry</strong> before
                  running sync — this does not build the schema catalog above.
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="px-4 py-2 text-sm text-text-secondary border border-border rounded-lg hover:bg-overlay-2 disabled:opacity-40"
                    disabled={artifactsRefreshing !== null}
                    onClick={async () => {
                      setArtifactsRefreshing("shipped")
                      setArtifactsMessage(null)
                      try {
                        const result = await api.refreshPlatformArtifacts({ source: "shipped" })
                        setArtifactsMessage(result.message)
                        const next = await api.getPlatformHealth()
                        setPlatformHealth(next)
                      } catch (err) {
                        setArtifactsMessage(err instanceof Error ? err.message : "Failed to load shipped artifacts")
                      } finally {
                        setArtifactsRefreshing(null)
                      }
                    }}
                  >
                    {artifactsRefreshing === "shipped" ? "Loading…" : "Use shipped artifacts"}
                  </button>
                  {platformHealth?.mssql.configured && platformHealth.mssql.connections.length > 1 && (
                    <select
                      value={mssqlConnection}
                      onChange={(e) => setMssqlConnection(e.target.value)}
                      className="rounded-lg border border-border bg-surface px-2 py-2 text-sm text-text"
                    >
                      {platformHealth.mssql.connections.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="px-4 py-2 text-sm text-accent border border-accent/30 rounded-lg hover:bg-accent/10 disabled:opacity-40"
                    disabled={artifactsRefreshing !== null || !platformHealth?.mssql.configured}
                    onClick={async () => {
                      setArtifactsRefreshing("mssql")
                      setArtifactsMessage(null)
                      try {
                        const result = await api.refreshPlatformArtifacts({
                          source: "mssql",
                          connection: mssqlConnection || platformHealth?.mssql.connections[0],
                          reseedSqlite: true,
                        })
                        setArtifactsMessage(result.message)
                        const next = await api.getPlatformHealth()
                        setPlatformHealth(next)
                      } catch (err) {
                        setArtifactsMessage(err instanceof Error ? err.message : "Failed to refresh from database")
                      } finally {
                        setArtifactsRefreshing(null)
                      }
                    }}
                  >
                    {artifactsRefreshing === "mssql" ? "Refreshing from MSSQL…" : "Refresh from database"}
                  </button>
                </div>
                {artifactsMessage && (
                  <p className="text-sm text-text-muted mt-2">{artifactsMessage}</p>
                )}
              </div>

              <div className="h-px bg-overlay-3 my-1" />

              <div className="px-4 py-3.5 rounded-xl bg-overlay-2 border border-error/20">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Trash2 size={15} className="text-error" />
                  <span className="text-sm font-semibold text-text">Factory Reset Platform</span>
                </div>
                <p className="text-sm text-text-muted leading-relaxed mb-3">
                  Wipe entity definitions, sync configs, and the published bundle, then re-seed from deploy artifacts.
                  <strong> Publish again from Entity Registry before sync is operational.</strong>
                  Policies, dashboard layout, and run history are preserved.
                </p>
                {!confirmFactoryReset ? (
                  <button
                    className="px-4 py-2 text-sm text-error hover:bg-error/10 border border-error/20 rounded-lg"
                    onClick={() => setConfirmFactoryReset(true)}
                  >
                    Factory Reset Platform
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-text-secondary">
                      Type <code className="font-mono text-text">FACTORY RESET</code> to confirm.
                    </p>
                    <input
                      type="text"
                      value={factoryResetPhrase}
                      onChange={(e) => setFactoryResetPhrase(e.target.value)}
                      placeholder="FACTORY RESET"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-border-strong"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        className="px-4 py-2 text-sm bg-error text-text rounded-lg disabled:opacity-40"
                        disabled={factoryResetting || factoryResetPhrase !== "FACTORY RESET"}
                        onClick={async () => {
                          setFactoryResetting(true)
                          try {
                            await api.factoryResetPlatform("FACTORY RESET")
                            window.location.reload()
                          } catch {
                            setError("Failed to factory reset platform")
                            setFactoryResetting(false)
                            setConfirmFactoryReset(false)
                            setFactoryResetPhrase("")
                          }
                        }}
                      >
                        {factoryResetting ? "Resetting..." : "Reset Platform"}
                      </button>
                      <button
                        className="px-3 py-2 text-sm text-text-muted hover:text-text rounded-lg"
                        onClick={() => {
                          setConfirmFactoryReset(false)
                          setFactoryResetPhrase("")
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

// ── Effect segmented control for the Tools tab ───────────────────

function EffectSegmented({ value, onChange }: { value: Effect | null; onChange: (v: Effect | "none") => void }) {
  const OPTIONS: { v: Effect | "none"; label: string; cls: string }[] = [
    { v: "none",             label: "Allowed",  cls: "text-success" },
    { v: "require_approval", label: "Approval", cls: "text-warning" },
    { v: "deny",             label: "Denied",   cls: "text-error" },
  ]
  const current = value ?? "none"
  return (
    <div className="inline-flex rounded-lg bg-surface border border-border-subtle p-0.5 shrink-0">
      {OPTIONS.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`px-3.5 py-1.5 text-sm rounded-md transition-colors ${
            current === o.v ? `${o.cls} bg-overlay-3 font-medium` : "text-text-muted hover:text-text"
          }`}
        >{o.label}</button>
      ))}
    </div>
  )
}
