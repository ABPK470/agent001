/**
 * AgentEditor — CRUD modal for agent definitions.
 *
 * Manage configured agents: create, edit, delete.
 * Each agent is defined by name, description, system prompt, and tool subset.
 */

import { Brain, Check, ChevronLeft, Plus, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api"
import type { AgentDefinition, ToolInfo } from "../types"
import { modalOverlayClass, MODAL_SURFACE_CLASS } from "../widgets/entity-registry/modal-overlay"

interface Props {
  onClose: () => void
}

type View = "list" | "edit"

export function AgentEditor({ onClose }: Props) {
  const [agents, setAgents] = useState<AgentDefinition[]>([])
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>("list")

  // Edit form state
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [systemPrompt, setSystemPrompt] = useState("")
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const [agentList, toolList] = await Promise.all([api.listAgents(), api.listTools()])
      setAgents(agentList)
      setTools(toolList)
    } catch {
      setError("Failed to load agents")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  function openCreate() {
    setEditId(null)
    setName("")
    setDescription("")
    setSystemPrompt("You are a capable AI agent that can use tools to accomplish goals.\n\nWhen given a goal:\n1. Break it down into steps\n2. Use tools to gather information or take actions\n3. Observe the results and decide what to do next\n4. Repeat until the goal is achieved\n5. Provide a clear final answer\n\nBe methodical. Think before acting. If a tool call fails, try a different approach.\nAlways explain your reasoning when providing the final answer.")
    setSelectedTools(tools.map((t) => t.name))
    setError(null)
    setView("edit")
  }

  function openEdit(agent: AgentDefinition) {
    setEditId(agent.id)
    setName(agent.name)
    setDescription(agent.description)
    setSystemPrompt(agent.systemPrompt)
    setSelectedTools([...agent.tools])
    setError(null)
    setView("edit")
  }

  function toggleTool(toolName: string) {
    setSelectedTools((prev) =>
      prev.includes(toolName)
        ? prev.filter((t) => t !== toolName)
        : [...prev, toolName],
    )
  }

  async function handleSave() {
    if (!name.trim()) { setError("Name is required"); return }
    if (!systemPrompt.trim()) { setError("System prompt is required"); return }
    if (selectedTools.length === 0) { setError("Select at least one tool"); return }

    setSaving(true)
    setError(null)
    try {
      if (editId) {
        await api.updateAgent(editId, {
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          tools: selectedTools,
        })
      } else {
        await api.createAgent({
          name: name.trim(),
          description: description.trim(),
          systemPrompt: systemPrompt.trim(),
          tools: selectedTools,
        })
      }
      await load()
      setView("list")
    } catch {
      setError(editId ? "Failed to update agent" : "Failed to create agent")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(agent: AgentDefinition) {
    if (agent.id === "default") return
    setError(null)
    try {
      await api.deleteAgent(agent.id)
      await load()
    } catch {
      setError("Failed to delete agent")
    }
  }

  return (
    <div
      className={modalOverlayClass("detail")}
      onClick={onClose}
    >
      <div
        className={`${MODAL_SURFACE_CLASS} w-full max-w-[720px] h-full sm:h-auto sm:max-h-[85vh] flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-border-subtle shrink-0">
          <div className="flex items-center gap-2.5">
            {view === "edit" && (
              <button
                className="text-text-muted hover:text-text p-1 rounded-lg hover:bg-overlay-3 transition-colors mr-1"
                onClick={() => { setView("list"); setError(null) }}
              >
                <ChevronLeft size={18} />
              </button>
            )}
            <Brain size={20} className="text-text-muted" />
            <h2 className="text-lg font-semibold text-text">
              {view === "list" ? "Agents" : editId ? "Edit Agent" : "New Agent"}
            </h2>
          </div>
          <button className="text-text-muted hover:text-text p-1.5 rounded-lg hover:bg-overlay-3 transition-colors" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-6 mt-4 px-3 py-2 bg-error/10 text-error text-[13px] rounded-lg">
            {error}
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 pb-5 pt-4 min-h-0">
          {loading ? (
            <div className="text-text-muted text-sm text-center py-8">Loading...</div>
          ) : view === "list" ? (
            /* ── Agent list ──────────────────────────────── */
            <div className="space-y-2">
              <p className="text-sm text-text-muted mb-4">
                Each agent has its own system prompt and tool set. Select an agent before starting a run.
              </p>

              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-4 px-4 py-3.5 rounded-xl bg-overlay-2 border border-border-subtle cursor-pointer hover:border-border-subtle transition-colors"
                  onClick={() => openEdit(agent)}
                >
                  <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                    <Brain size={16} className="text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-text">{agent.name}</span>
                      {agent.id === "default" && (
                        <span className="text-[10px] uppercase font-semibold tracking-wider text-accent bg-accent/10 px-1.5 py-0.5 rounded">
                          default
                        </span>
                      )}
                    </div>
                    <p className="text-[13px] text-text-muted mt-0.5 truncate">
                      {agent.description || `${agent.tools.length} tools`}
                    </p>
                  </div>
                  {agent.id !== "default" && (
                    <button
                      className="text-text-muted hover:text-error p-1.5 rounded-lg hover:bg-overlay-3 transition-colors shrink-0"
                      title="Delete agent"
                      onClick={(e) => { e.stopPropagation(); handleDelete(agent) }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              ))}

              <button
                className="flex items-center gap-3 w-full px-4 py-3 rounded-xl border border-dashed border-border-subtle text-text-muted hover:text-text hover:border-text-secondary/[0.15] transition-colors"
                onClick={openCreate}
              >
                <Plus size={16} />
                <span className="text-sm">Create Agent</span>
              </button>
            </div>
          ) : (
            /* ── Edit / Create form ──────────────────────── */
            <div className="space-y-4">
              {/* Name */}
              <div>
                <label className="text-[13px] font-medium text-text-secondary block mb-1.5">Name</label>
                <input
                  className="w-full bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Code Reviewer"
                />
              </div>

              {/* Description */}
              <div>
                <label className="text-[13px] font-medium text-text-secondary block mb-1.5">Description</label>
                <input
                  className="w-full bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short description of what this agent does"
                />
              </div>

              {/* System prompt */}
              <div>
                <label className="text-[13px] font-medium text-text-secondary block mb-1.5">System Prompt</label>
                <textarea
                  className="w-full bg-base rounded-lg px-3 py-2.5 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all resize-y font-mono leading-relaxed"
                  rows={8}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Instructions for the agent..."
                />
              </div>

              {/* Tools */}
              <div>
                <label className="text-[13px] font-medium text-text-secondary block mb-1.5">
                  Tools ({selectedTools.length}/{tools.length})
                </label>
                <div className="grid grid-cols-2 gap-1.5">
                  {tools.map((tool) => {
                    const active = selectedTools.includes(tool.name)
                    return (
                      <button
                        key={tool.name}
                        className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors ${
                          active
                            ? "border-accent/30 bg-accent/5 text-text"
                            : "border-border-subtle bg-overlay-1 text-text-muted hover:border-border-subtle"
                        }`}
                        onClick={() => toggleTool(tool.name)}
                      >
                        <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                          active ? "bg-accent border-accent" : "border-border-strong"
                        }`}>
                          {active && <Check size={10} className="text-text" />}
                        </div>
                        <div className="min-w-0">
                          <span className="text-[13px] font-mono block truncate">{tool.name}</span>
                          <span className="text-[11px] text-text-muted block truncate">{tool.description}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Save */}
              <div className="flex justify-end pt-2">
                <button
                  className="px-5 py-2 bg-accent hover:bg-accent-hover text-text text-sm font-medium rounded-lg transition-colors disabled:opacity-40"
                  onClick={handleSave}
                  disabled={saving}
                >
                  {saving ? "Saving..." : editId ? "Save Changes" : "Create Agent"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
