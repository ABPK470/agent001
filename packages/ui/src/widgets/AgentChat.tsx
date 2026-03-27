/**
 * AgentChat — send goals to the agent and see responses.
 *
 * The primary interaction widget: type a goal, agent executes, see the answer.
 */

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
      <div className="flex-1 overflow-auto space-y-3 pr-1">
        {recentRuns.length === 0 && (
          <div className="text-text-muted text-[11px] text-center pt-8">
            Send a goal to start the agent
          </div>
        )}

        {[...recentRuns].reverse().map((run) => (
          <div
            key={run.id}
            className={`space-y-1.5 cursor-pointer rounded-md p-2 transition-colors ${
              run.id === activeRunId ? "bg-elevated" : "hover:bg-elevated/50"
            }`}
            onClick={() => setActiveRun(run.id)}
          >
            {/* Goal (user message) */}
            <div className="flex items-start gap-2">
              <span className="text-accent text-[10px] font-medium shrink-0 mt-0.5">YOU</span>
              <span className="text-text text-xs">{run.goal}</span>
            </div>

            {/* Answer (agent response) */}
            {run.answer && (
              <div className="flex items-start gap-2">
                <span className="text-success text-[10px] font-medium shrink-0 mt-0.5">AI</span>
                <span className="text-text-secondary text-xs whitespace-pre-wrap">
                  {run.answer.length > 300 ? run.answer.slice(0, 300) + "..." : run.answer}
                </span>
              </div>
            )}

            {/* Error */}
            {run.error && (
              <div className="flex items-start gap-2">
                <span className="text-error text-[10px] font-medium shrink-0 mt-0.5">ERR</span>
                <span className="text-error/70 text-xs">{run.error}</span>
              </div>
            )}

            {/* Status badge */}
            {run.status === "running" && (
              <div className="text-[10px] text-accent animate-pulse">● Running...</div>
            )}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 shrink-0">
        <input
          className="flex-1 bg-base border border-border rounded-md px-3 py-1.5 text-xs text-text placeholder:text-text-muted outline-none focus:border-accent transition-colors"
          placeholder={isRunning ? "Agent is working..." : "Enter a goal..."}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
          disabled={sending}
        />
        <button
          className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs rounded-md transition-colors disabled:opacity-40"
          onClick={handleSend}
          disabled={sending || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  )
}
