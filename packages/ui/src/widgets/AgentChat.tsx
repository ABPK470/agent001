/**
 * AgentChat — send goals to the agent and see responses.
 *
 * The primary interaction widget: type a goal, agent executes, see the answer.
 */

import { AlertCircle, Bot, Loader2, Send, User } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api } from "../api"
import { useStore } from "../store"

export function AgentChat() {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)
  const runs = useStore((s) => s.runs)
  const activeRunId = useStore((s) => s.activeRunId)
  const setActiveRun = useStore((s) => s.setActiveRun)
  const bottomRef = useRef<HTMLDivElement>(null)

  const activeRun = runs.find((r) => r.id === activeRunId)
  const isRunning = activeRun?.status === "pending" || activeRun?.status === "running" || activeRun?.status === "planning"

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [runs])

  async function handleSend() {
    const goal = input.trim()
    if (!goal || sending) return

    setSending(true)
    setInput("")
    try {
      const { runId } = await api.startRun(goal)
      setActiveRun(runId)
    } catch (err) {
      console.error("Failed to start run:", err)
    } finally {
      setSending(false)
    }
  }

  // Show recent runs as "conversation"
  const recentRuns = runs.slice(0, 20)

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto space-y-3 py-1">
        {recentRuns.length === 0 && (
          <div className="text-text-muted text-sm text-center pt-8">
            Send a goal to start the agent
          </div>
        )}

        {[...recentRuns].reverse().map((run) => (
          <div
            key={run.id}
            className={`space-y-2 cursor-pointer rounded-lg p-2 transition-colors ${
              run.id === activeRunId ? "bg-elevated/50" : "hover:bg-elevated/25"
            }`}
            onClick={() => setActiveRun(run.id)}
          >
            {/* Goal (user message) — right-aligned */}
            <div className="flex justify-end">
              <div className="flex items-start gap-2 max-w-[85%]">
                <span className="text-text text-sm bg-accent/10 rounded-xl rounded-tr-sm px-3 py-1.5 leading-relaxed">{run.goal}</span>
                <User size={14} className="text-accent shrink-0 mt-1.5" />
              </div>
            </div>

            {/* Answer (agent response) — left-aligned */}
            {run.answer && (
              <div className="flex items-start gap-2 max-w-[85%]">
                <Bot size={14} className="text-text-muted shrink-0 mt-1.5" />
                <span className="text-text-secondary text-sm whitespace-pre-wrap leading-relaxed">
                  {run.answer}
                </span>
              </div>
            )}

            {/* Error */}
            {run.error && (
              <div className="flex items-start gap-2">
                <AlertCircle size={14} className="text-error shrink-0 mt-0.5" />
                <span className="text-error/80 text-sm">{run.error}</span>
              </div>
            )}

            {/* Status badge */}
            {run.status === "running" && (
              <div className="flex items-center gap-1.5 text-[13px] text-accent ml-5">
                <Loader2 size={14} className="animate-spin" />
                Running
              </div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 shrink-0">
        <input
          className="flex-1 bg-base rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-muted outline-none focus:ring-1 focus:ring-accent transition-all"
          placeholder={isRunning ? "Agent is working..." : "Enter a goal..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
          disabled={sending}
        />
        <button
          className="flex items-center justify-center w-10 h-10 bg-accent hover:bg-accent-hover text-white rounded-lg transition-colors disabled:opacity-40"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  )
}
