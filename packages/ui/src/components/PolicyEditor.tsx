/**
 * PolicyEditor — full governance dashboard modal.
 *
 * Shows all agent tools with their permission state, allows full CRUD
 * on policy rules, and displays built-in security protections.
 */

import {
    AlertTriangle,
    ChevronDown,
    ChevronRight,
    Cpu,
    Eye,
    EyeOff,
    FolderOpen,
    Globe,
    Shield,
    ShieldCheck,
    ShieldX,
    Terminal,
    Trash2,
    X,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api"
import type { PolicyRule } from "../types"

interface Props {
  onClose: () => void
}

type Effect = "allow" | "deny" | "require_approval"

const EFFECTS: { value: Effect; label: string; icon: typeof ShieldCheck; color: string }[] = [
  { value: "allow", label: "Allow", icon: ShieldCheck, color: "text-success" },
  { value: "deny", label: "Deny", icon: ShieldX, color: "text-error" },
  { value: "require_approval", label: "Require Approval", icon: AlertTriangle, color: "text-warning" },
]

/** All agent tools with metadata */
const AGENT_TOOLS = [
  { name: "run_command", condition: "action:run_command", desc: "Execute shell commands", icon: Terminal },
  { name: "read_file", condition: "action:read_file", desc: "Read files from workspace" },
  { name: "write_file", condition: "action:write_file", desc: "Write / create files" },
  { name: "list_directory", condition: "action:list_directory", desc: "List directory contents" },
  { name: "fetch_url", condition: "action:fetch_url", desc: "Fetch web pages & APIs", icon: Globe },
  { name: "think", condition: "action:think", desc: "Internal reasoning (no side effects)" },
]

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

type Tab = "tools" | "model" | "security"

export function PolicyEditor({ onClose }: Props) {
  const [rules, setRules] = useState<PolicyRule[]>([])
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

  const loadRules = useCallback(async () => {
    try {
      const data = await api.listPolicies()
      setRules(data)
    } catch {
      setError("Failed to load policies")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRules() }, [loadRules])

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
    { id: "model", label: "Model" },
    { id: "security", label: "Security" },
  ]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl w-full max-w-[720px] h-[85vh] max-sm:h-[92vh] mx-4 sm:mx-auto flex flex-col shadow-2xl max-sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2.5">
            <Shield size={20} className="text-text-muted" />
            <h2 className="text-lg font-semibold text-text">Governance & Security</h2>
          </div>
          <button className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-white/[0.06] transition-colors" onClick={onClose}>
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
                  ? "bg-white/10 text-text font-medium"
                  : "text-text-muted hover:text-text-secondary hover:bg-white/[0.04]"
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
              {AGENT_TOOLS.map((tool) => {
                const rule = toolRuleMap.get(tool.name)
                const currentEffect = rule ? (rule.effect as Effect) : null
                const Icon = tool.icon ?? Shield
                const effectStyle = currentEffect ? getEffectStyle(currentEffect) : null

                return (
                  <div key={tool.name} className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                    <div className="w-9 h-9 rounded-lg bg-white/[0.05] flex items-center justify-center shrink-0">
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
                      <div className="text-[13px] text-text-muted mt-0.5">{tool.desc}</div>
                    </div>
                    <select
                      className="bg-white/[0.06] text-text text-[13px] rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer shrink-0 border border-white/[0.06]"
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
          ) : tab === "model" ? (
            /* ── Model tab ────────────────────────────────── */
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-text-muted">Configure the LLM provider and model used by the agent.</p>
                {llmActiveProvider && (
                  <span className="flex items-center gap-1.5 text-[12px] text-text-muted bg-white/[0.04] border border-white/[0.06] rounded-full px-3 py-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                    {llmActiveProvider} / {llmActiveModel}
                  </span>
                )}
              </div>

              {/* Provider selector */}
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Cpu size={15} className="text-text-muted" />
                  <span className="text-sm font-semibold text-text">Provider</span>
                </div>
                <p className="text-[13px] text-text-muted leading-relaxed mb-3">
                  Choose the LLM backend. Switching provider updates the model and URL defaults below.
                </p>
                <div className="flex gap-2 flex-wrap">
                  {(["copilot", "openai", "anthropic", "local"] as const).map((p) => (
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
                          : "bg-white/[0.04] text-text-muted border-white/[0.06] hover:text-text hover:bg-white/[0.06]"
                      }`}
                    >
                      {p === "copilot" ? "GitHub Copilot" : p === "openai" ? "OpenAI" : p === "anthropic" ? "Anthropic" : "Local (Ollama)"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Model + credentials combined card */}
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
                      className="w-full px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
                    />
                  </div>

                  {/* API Key — hidden for local */}
                  {llmProvider !== "local" && (
                    <div>
                      <label className="text-[13px] text-text-muted block mb-1.5">
                        {llmProvider === "copilot" ? "GitHub Token" : llmProvider === "anthropic" ? "Anthropic API Key" : "OpenAI API Key"}
                      </label>
                      <div className="relative">
                        <input
                          type={showApiKey ? "text" : "password"}
                          value={llmApiKey}
                          onChange={(e) => setLlmApiKey(e.target.value)}
                          placeholder={llmDefaults[llmProvider]?.placeholder ?? "Leave blank to keep existing"}
                          className="w-full px-3 py-1.5 pr-10 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
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
                        className="w-full px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
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
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
                    className="flex-1 px-3 py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.06] text-sm text-text placeholder:text-text-muted/50 focus:outline-none focus:ring-1 focus:ring-accent font-mono text-[13px]"
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
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
              <div className="h-px bg-white/[0.06] my-1" />

              <div className="px-4 py-3.5 rounded-xl bg-white/[0.03] border border-white/[0.04]">
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
                      className="px-4 py-2 text-[13px] bg-error text-white rounded-lg disabled:opacity-40"
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
