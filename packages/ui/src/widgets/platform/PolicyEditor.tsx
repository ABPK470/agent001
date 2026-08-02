/**
 * PolicyEditor — full governance dashboard modal.
 *
 * Shows all agent tools with their permission state, allows full CRUD
 * on policy rules, and displays built-in security protections.
 */

import {
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
  Globe,
  MessageSquare,
  Network,
  Search,
  Shield,
  Terminal,
  Trash2,
  X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../../client/index"
import { Listbox, type ListboxOption } from "../../components/Listbox"
import { SELECT_ACTIVE, SELECT_FOCUS, SELECT_IDLE, SELECT_TRACK } from "../../lib/selection"
import type { PolicyRule, ToolInfo } from "../../types"
import { MODAL_ADMIN_PANEL, MODAL_SURFACE_CLASS, modalOverlayClass } from "../entity-registry/modal-overlay"
import { ExpandableDescription } from "./policy/ExpandableDescription"
import { PolicyPanel } from "./policy/PolicyPanel"
import { SelectorRulesTab } from "./policy/SelectorRulesTab"

interface Props {
  onClose: () => void
}

type Effect = "allow" | "deny" | "require_approval"

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
  const [toolSearch, setToolSearch] = useState("")
  const [bulkBusy, setBulkBusy] = useState(false)

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

  // Reset factory policy defaults from deploy/policies/defaults.json
  const [confirmPolicyDefaultsReset, setConfirmPolicyDefaultsReset] = useState(false)
  const [policyDefaultsResetPhrase, setPolicyDefaultsResetPhrase] = useState("")
  const [policyDefaultsResetting, setPolicyDefaultsResetting] = useState(false)
  const [policyDefaultsResetMessage, setPolicyDefaultsResetMessage] = useState<string | null>(null)

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
    }).catch((err: unknown) => { console.error("[mia]", err) })
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
    }).catch((err: unknown) => { console.error("[mia]", err) })
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

  const filteredTools = useMemo(() => {
    const q = toolSearch.trim().toLowerCase()
    if (!q) return tools
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(q)
        || tool.description.toLowerCase().includes(q),
    )
  }, [tools, toolSearch])

  async function handleAllowAllTools() {
    setBulkBusy(true)
    setError(null)
    try {
      const ruled = tools.filter((tool) => toolRuleMap.has(tool.name))
      await Promise.all(ruled.map((tool) => handleToolToggle(tool.name, "none")))
    } catch {
      setError("Failed to reset tool permissions")
    } finally {
      setBulkBusy(false)
    }
  }

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
              className={`px-2.5 py-1.5 text-sm transition-colors whitespace-nowrap rounded-md border border-transparent ${
                tab === t.id
                  ? "text-text font-semibold bg-[var(--select-fill)]"
                  : "text-text-muted font-medium hover:text-text hover:bg-[var(--hover-fill)]"
              }`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab subtitle — short, one job per tab. */}
        <div className="px-7 pt-3.5 pb-2.5 shrink-0">
          <p className="text-sm text-text-muted leading-snug">
            {tab === "tools" && (
              <>
                <strong className="text-text">Tool Permissions</strong>
                {" — "}
                Allow, deny, or require approval per tool. For path/env/command rules, use Selector Rules.
              </>
            )}
            {tab === "rules" && (
              <>
                <strong className="text-text">Selector Rules</strong>
                {" — "}
                Match on role, tool, path, command, env, and more. Highest priority wins; ties prefer deny over approval over allow.
              </>
            )}
            {tab === "model" && (
              <>
                <strong className="text-text">Model</strong>
                {" — "}
                LLM provider, model, and credentials. Takes effect on the next run.
              </>
            )}
            {tab === "platform" && (
              <>
                <strong className="text-text">Platform</strong>
                {" — "}
                Schema catalog for exploration tools, and sync artifact deploy.
              </>
            )}
            {tab === "security" && (
              <>
                <strong className="text-text">Security</strong>
                {" — "}
                Built-in guards (shell, SSRF, SQL). Workspace path applies in developer mode only.
              </>
            )}
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mia-callout mia-callout--err mx-7 mb-3 px-3 py-2 text-sm">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-7 pb-6 min-h-0">
          {loading ? (
            <div className="text-text-muted text-sm text-center py-8">Loading...</div>
          ) : tab === "tools" ? (
            /* ── Tool Permissions tab — flat table, not card wall ── */
            <div className="min-w-0 space-y-4">
              <p className="text-sm text-text-muted leading-snug">
                Tools are allowed unless you set a rule here. Path/env/command rules live under Selector Rules.
              </p>

              <div className="min-w-0 rounded-lg border border-border-subtle">
                <div className="flex items-center gap-2 border-b border-border-subtle bg-[var(--overlay-1)] px-3 py-2">
                  <div className="relative min-w-0 flex-1">
                    <Search
                      size={15}
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-faint"
                    />
                    <input
                      type="search"
                      value={toolSearch}
                      onChange={(e) => setToolSearch(e.target.value)}
                      placeholder="Search tool name…"
                      className="w-full rounded-md border border-border-subtle bg-transparent py-1.5 pl-8 pr-3 text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-border-strong"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={bulkBusy || tools.every((tool) => !toolRuleMap.has(tool.name))}
                    onClick={handleAllowAllTools}
                    className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-[var(--hover-fill)] hover:text-text disabled:cursor-not-allowed disabled:border-border-subtle disabled:text-text-faint"
                  >
                    {bulkBusy ? "Resetting…" : "Allow all tools"}
                  </button>
                </div>

                <div
                  className="grid grid-cols-[240px_minmax(0,1fr)_220px] items-center border-b border-border-subtle bg-[var(--overlay-1)] px-3 text-[11px] font-medium uppercase tracking-wide text-text-faint"
                  style={{ minHeight: 36 }}
                  role="row"
                >
                  <div className="py-2">Tool name</div>
                  <div className="py-2">Description</div>
                  <div className="py-2 text-right">Permission</div>
                </div>

                {filteredTools.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-text-muted">
                    No tools match &ldquo;{toolSearch.trim()}&rdquo;
                  </div>
                ) : (
                  filteredTools.map((tool) => {
                    const rule = toolRuleMap.get(tool.name)
                    const currentEffect = rule ? (rule.effect as Effect) : null
                    const Icon = getToolIcon(tool.name)

                    return (
                      <div
                        key={tool.name}
                        role="row"
                        className="grid grid-cols-[240px_minmax(0,1fr)_220px] items-center border-b border-border-subtle px-3 py-2.5 last:border-b-0 hover:bg-[var(--hover-fill)]"
                        style={{ minHeight: 56 }}
                      >
                        <div className="flex min-w-0 items-center gap-2 pr-3">
                          <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                            <Icon size={16} className="text-text-faint" />
                          </span>
                          <span className="truncate font-mono text-xs font-semibold text-text">
                            {tool.name}
                          </span>
                        </div>
                        <div className="min-w-0 pr-3">
                          <ExpandableDescription text={tool.description} />
                        </div>
                        <div className="flex justify-end">
                          <EffectSegmented
                            value={currentEffect}
                            onChange={(v) => handleToolToggle(tool.name, v)}
                          />
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </div>
          ) : tab === "rules" ? (
            /* ── Selector Rules tab — see ./policy/SelectorRulesTab.tsx ── */
            <div className="space-y-3">
              <SelectorRulesTab
                rules={rules}
                tools={tools}
                onReload={loadRules}
                onDelete={handleDelete}
              />
            </div>
          ) : tab === "model" ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-text-muted">LLM provider and model for the agent.</p>
                {llmActiveProvider && (
                  <span className="flex items-center gap-1.5 text-sm text-text-muted border border-border-subtle rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                    {llmActiveProvider} / {llmActiveModel}
                  </span>
                )}
              </div>

              <PolicyPanel title="Provider" icon={<Cpu size={15} />}>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Choose the LLM backend. Defaults update when you switch.
                </p>
                <div className={`${SELECT_TRACK} flex-wrap h-auto min-h-[var(--control-h)]`}>
                  {(["copilot-chat", "databricks"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setLlmProvider(p)
                        setLlmModel(llmDefaults[p]?.model ?? "")
                        setLlmBaseUrl(llmDefaults[p]?.baseUrl ?? "")
                        setLlmApiKey("")
                      }}
                      className={`rounded-md px-3 py-1 text-sm ${SELECT_FOCUS} ${
                        llmProvider === p ? SELECT_ACTIVE : SELECT_IDLE
                      }`}
                    >
                      {p === "copilot-chat" ? "Copilot Chat" : "Databricks"}
                    </button>
                  ))}
                </div>
              </PolicyPanel>

              <PolicyPanel title="Connection" icon={<Cpu size={15} />}>
                <div className="space-y-3 mb-4">
                  <div>
                    <label className="text-sm text-text-muted block mb-1.5">
                      {llmProvider === "databricks" ? "Serving endpoint" : "Model"}
                    </label>
                    <input
                      type="text"
                      value={llmModel}
                      onChange={(e) => setLlmModel(e.target.value)}
                      placeholder={llmDefaults[llmProvider]?.model ?? "model name"}
                      className="w-full px-3 py-1.5 rounded-lg border border-border-subtle bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-border-strong font-mono"
                    />
                  </div>

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
                          className="w-full px-3 py-1.5 pr-10 rounded-lg border border-border-subtle bg-transparent text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-1 focus:ring-border-strong font-mono"
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
                </div>

                <div className="flex items-center gap-3">
                  <button
                    onClick={handleSaveLlm}
                    disabled={llmSaving}
                    className="px-3 py-1.5 rounded-lg bg-accent/20 text-accent text-sm font-medium hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {llmSaving ? "Saving…" : "Apply"}
                  </button>
                  {llmSaved && <span className="text-sm text-text-muted">Saved — active on next run</span>}
                  {llmError && <span className="text-sm text-error">{llmError}</span>}
                </div>
              </PolicyPanel>
            </div>
          ) : tab === "security" ? (
            /* ── Security tab ─────────────────────────────── */
            <div className="space-y-4">
              <p className="text-sm text-text-muted">
                Always-on protections. These cannot be turned off here.
              </p>

              {/* Workspace */}
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-2">
                  <FolderOpen size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Workspace (developer mode)</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-2">
                  File and shell tools use this folder in developer mode.
                </p>
                <p className="text-sm text-warning/90 leading-snug mb-3">
                  Hosted mode ignores this — each run uses its own sandbox.
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
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
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
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
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
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Shield size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Policy Enforcement</span>
                </div>
                <p className="text-sm text-text-muted leading-snug">
                  Checked before every tool call. Deny fails immediately; require approval waits for an operator.
                </p>
              </div>

              {/* SQL rails — tool layer, not policy-editable */}
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <button
                  className="flex items-center gap-2.5 w-full text-left"
                  onClick={() => setSqlGuardExpanded((v) => !v)}
                >
                  {sqlGuardExpanded ? <ChevronDown size={14} className="text-text-muted" /> : <ChevronRight size={14} className="text-text-muted" />}
                  <Database size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">SQL Rails</span>
                  <span className="text-sm text-text-muted ml-auto">tool layer · not policy</span>
                </button>
                {sqlGuardExpanded && (
                  <div className="mt-3 space-y-2.5">
                    <p className="text-sm text-text-muted leading-snug">
                      Hard blocks in the SQL tools (not policy DB). DML/DDL still need a matching policy rule.
                    </p>
                    <ul className="text-sm text-text-secondary leading-relaxed space-y-1.5 pl-1">
                      <li><span className="text-error font-medium">✗ Always blocked</span> — <code className="font-mono">EXEC</code>, <code className="font-mono">xp_*</code>, <code className="font-mono">OPENROWSET</code>, <code className="font-mono">BULK INSERT</code>, <code className="font-mono">DBCC</code>, global <code className="font-mono">##temp</code>.</li>
                      <li><span className="text-text-muted">ℹ export_query_to_file</span> — tool-level read-only (SELECT/WITH/#temp only).</li>
                      <li><span className="text-text-muted">ℹ Per-row safety cap</span> — <code className="font-mono">query_mssql</code> hard-limits to 1 000 rows; use <code className="font-mono">export_query_to_file</code> for larger pulls.</li>
                    </ul>
                  </div>
                )}
              </div>

              {/* Reset data */}
              <div className="h-px bg-overlay-3 my-1" />

              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Trash2 size={15} className="text-error" />
                  <span className="text-sm font-semibold text-text">Restore Defaults</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Clears runs, logs, audit, traces, and usage. Policies and layout stay.
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
                      className="px-4 py-2 text-sm rounded-lg border border-error text-error bg-transparent hover:bg-[var(--hover-fill)] hover:text-text disabled:opacity-40"
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
              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Database size={15} className="text-accent" />
                  <span className="text-sm font-semibold text-text">MSSQL schema catalog</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Live MSSQL table/FK cache for catalog search and schema tools. Not from sync publish.
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

              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Database size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Deploy sync artifacts</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Load entity definitions and sync steps into SQLite. Publish from Entity Registry before syncing.
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
                    <div className="w-[7.5rem] shrink-0">
                      <Listbox
                        value={mssqlConnection || platformHealth.mssql.connections[0] || ""}
                        options={platformHealth.mssql.connections.map(
                          (c): ListboxOption<string> => ({ value: c, label: c }),
                        )}
                        onChange={setMssqlConnection}
                        size="sm"
                        className="w-full listbox-control"
                        ariaLabel="MSSQL connection"
                      />
                    </div>
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

              <div className="rounded-lg border border-border-subtle px-4 py-3.5">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Shield size={15} className="text-accent" />
                  <span className="text-sm font-semibold text-text">Factory policy defaults</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Re-apply factory rules from deploy defaults. Your custom-named rules stay.
                </p>
                {policyDefaultsResetMessage && (
                  <p className="text-sm text-text-muted mb-3">{policyDefaultsResetMessage}</p>
                )}
                {!confirmPolicyDefaultsReset ? (
                  <button
                    type="button"
                    className="px-4 py-2 text-sm text-accent border border-accent/30 rounded-lg hover:bg-accent/10"
                    onClick={() => {
                      setConfirmPolicyDefaultsReset(true)
                      setPolicyDefaultsResetMessage(null)
                    }}
                  >
                    Reset factory policy defaults
                  </button>
                ) : (
                  <div className="space-y-3">
                    <p className="text-sm text-text-secondary">
                      Type <code className="font-mono text-text">RESET POLICY DEFAULTS</code> to confirm.
                    </p>
                    <input
                      type="text"
                      value={policyDefaultsResetPhrase}
                      onChange={(e) => setPolicyDefaultsResetPhrase(e.target.value)}
                      placeholder="RESET POLICY DEFAULTS"
                      className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text focus:outline-none focus:ring-1 focus:ring-border-strong"
                    />
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        className="px-4 py-2 text-sm bg-accent text-text rounded-lg disabled:opacity-40"
                        disabled={
                          policyDefaultsResetting ||
                          policyDefaultsResetPhrase !== "RESET POLICY DEFAULTS"
                        }
                        onClick={async () => {
                          setPolicyDefaultsResetting(true)
                          setPolicyDefaultsResetMessage(null)
                          try {
                            const result = await api.resetFactoryPolicyDefaults("RESET POLICY DEFAULTS")
                            setPolicyDefaultsResetMessage(result.message)
                            setConfirmPolicyDefaultsReset(false)
                            setPolicyDefaultsResetPhrase("")
                          } catch (err) {
                            setPolicyDefaultsResetMessage(
                              err instanceof Error ? err.message : "Failed to reset policy defaults",
                            )
                          } finally {
                            setPolicyDefaultsResetting(false)
                          }
                        }}
                      >
                        {policyDefaultsResetting ? "Resetting…" : "Reset policy defaults"}
                      </button>
                      <button
                        type="button"
                        className="px-3 py-2 text-sm text-text-muted hover:text-text rounded-lg"
                        onClick={() => {
                          setConfirmPolicyDefaultsReset(false)
                          setPolicyDefaultsResetPhrase("")
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="h-px bg-overlay-3 my-1" />

              <div className="px-4 py-3.5 rounded-xl border border-border-subtle border-l-[3px] border-l-error">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Trash2 size={15} className="text-error" />
                  <span className="text-sm font-semibold text-text">Factory Reset Platform</span>
                </div>
                <p className="text-sm text-text-muted leading-snug mb-3">
                  Wipe sync entities and the published bundle, then re-seed from deploy. Publish again before syncing.
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
                        className="px-4 py-2 text-sm rounded-lg border border-error text-error bg-transparent hover:bg-[var(--hover-fill)] hover:text-text disabled:opacity-40"
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
    { v: "none",             label: "Allowed",  cls: "text-policy-allow" },
    { v: "require_approval", label: "Approval", cls: "text-policy-approval" },
    { v: "deny",             label: "Denied",   cls: "text-policy-deny" },
  ]
  const current = value ?? "none"
  return (
    <div className="inline-flex max-w-full rounded-md border border-border-subtle p-0.5 shrink-0">
      {OPTIONS.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`whitespace-nowrap px-2 py-1 text-xs rounded transition-colors ${
            current === o.v ? `${o.cls} bg-[var(--select-fill)] font-medium` : "text-text-muted hover:text-text"
          }`}
        >{o.label}</button>
      ))}
    </div>
  )
}
