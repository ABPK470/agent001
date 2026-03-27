/**
 * PolicyEditor — modal for managing governance policy rules.
 *
 * Lists existing rules, allows creating new ones and deleting existing ones.
 * Rules are persisted to the server and applied to every new agent run.
 */

import { AlertTriangle, Plus, Shield, ShieldCheck, ShieldX, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api"
import type { PolicyRule } from "../types"

interface Props {
  onClose: () => void
}

const EFFECTS = [
  { value: "allow", label: "Allow", icon: ShieldCheck, color: "text-success" },
  { value: "deny", label: "Deny", icon: ShieldX, color: "text-error" },
  { value: "require_approval", label: "Require Approval", icon: AlertTriangle, color: "text-warning" },
] as const

const CONDITION_EXAMPLES = [
  { pattern: "action:shell", desc: "Matches the shell tool" },
  { pattern: "action:write_file", desc: "Matches the write_file tool" },
  { pattern: "action:fetch_url", desc: "Matches the fetch_url tool" },
  { pattern: "amount_gt:1000", desc: "Matches when amount > 1000" },
]

export function PolicyEditor({ onClose }: Props) {
  const [rules, setRules] = useState<PolicyRule[]>([])
  const [loading, setLoading] = useState(true)

  // New rule form
  const [name, setName] = useState("")
  const [effect, setEffect] = useState<string>("deny")
  const [condition, setCondition] = useState("")
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function handleAdd() {
    if (!name.trim() || !condition.trim()) return
    setAdding(true)
    setError(null)
    try {
      await api.createPolicy({ name: name.trim(), effect, condition: condition.trim() })
      setName("")
      setCondition("")
      await loadRules()
    } catch {
      setError("Failed to create rule")
    } finally {
      setAdding(false)
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

  function getEffectStyle(e: string) {
    return EFFECTS.find((ef) => ef.value === e) ?? EFFECTS[1]
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-2xl w-[680px] max-h-[80vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 shrink-0">
          <div className="flex items-center gap-2.5">
            <Shield size={20} className="text-text-muted" />
            <h2 className="text-base font-semibold text-text">Governance Policies</h2>
          </div>
          <button
            className="text-text-muted hover:text-text p-1 rounded"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        {/* Description */}
        <p className="px-6 text-[13px] text-text-muted leading-relaxed -mt-2 mb-4">
          Policy rules are evaluated before every tool call. They can allow, deny, or require approval for specific actions.
          Rules apply to all new agent runs.
        </p>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mb-3 px-3 py-2 bg-error/10 text-error text-[13px] rounded-lg">
            {error}
          </div>
        )}

        {/* Rules list */}
        <div className="flex-1 overflow-y-auto px-6 min-h-0">
          {loading ? (
            <div className="text-text-muted text-sm text-center py-8">Loading...</div>
          ) : rules.length === 0 ? (
            <div className="text-text-muted text-sm text-center py-8">
              No policy rules configured. The agent can use all tools freely.
            </div>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => {
                const style = getEffectStyle(rule.effect)
                const Icon = style.icon
                return (
                  <div
                    key={rule.name}
                    className="flex items-center gap-3 px-4 py-3 rounded-xl bg-base group"
                  >
                    <Icon size={16} className={style.color} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text">{rule.name}</span>
                        <span className={`text-[11px] uppercase font-mono ${style.color}`}>
                          {style.label}
                        </span>
                      </div>
                      <div className="text-[13px] text-text-muted font-mono mt-0.5">
                        {rule.condition}
                      </div>
                    </div>
                    <button
                      className="text-text-muted hover:text-error opacity-0 group-hover:opacity-100 p-1 rounded"
                      onClick={() => handleDelete(rule.name)}
                      title="Delete rule"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-white/5 mx-6 my-4" />

        {/* Add new rule form */}
        <div className="px-6 pb-5 space-y-3 shrink-0">
          <div className="text-[13px] text-text-secondary font-medium">Add Rule</div>

          <div className="flex gap-2">
            <input
              className="flex-1 bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
              placeholder="Rule name (e.g. block-shell)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <select
              className="bg-base text-text text-sm rounded-lg px-3 py-2 outline-none focus:ring-1 focus:ring-accent appearance-none cursor-pointer"
              value={effect}
              onChange={(e) => setEffect(e.target.value)}
            >
              {EFFECTS.map((e) => (
                <option key={e.value} value={e.value}>{e.label}</option>
              ))}
            </select>
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 bg-base rounded-lg px-3 py-2 text-sm text-text font-mono placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent"
              placeholder="Condition (e.g. action:shell)"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleAdd() }}
            />
            <button
              className="flex items-center gap-1.5 px-4 py-2 bg-white/5 hover:bg-white/10 text-text-secondary hover:text-text text-sm rounded-lg disabled:opacity-40"
              onClick={handleAdd}
              disabled={adding || !name.trim() || !condition.trim()}
            >
              <Plus size={14} />
              Add
            </button>
          </div>

          {/* Condition hints */}
          <div className="flex flex-wrap gap-1.5">
            {CONDITION_EXAMPLES.map((ex) => (
              <button
                key={ex.pattern}
                className="px-2 py-0.5 text-[11px] text-text-muted hover:text-text-secondary font-mono bg-white/[0.02] hover:bg-white/[0.04] rounded"
                onClick={() => setCondition(ex.pattern)}
                title={ex.desc}
              >
                {ex.pattern}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
