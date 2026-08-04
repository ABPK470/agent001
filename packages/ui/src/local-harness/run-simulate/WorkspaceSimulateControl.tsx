/**
 * LOCAL LAPTOP HARNESS — testing switch. Not product chrome.
 */

import { FlaskConical } from "lucide-react"
import { useEffect, useState } from "react"
import { isLocalRunSimulateUiEnabled } from "./allow"
import {
  clearSimulationIfRun,
  getSimulatingRunId,
  readSimConfig,
  startSimulation,
  stopSimulation,
  writeSimConfig,
  type SimConfig,
  type SimPace,
  type SimScenario,
} from "./run-simulate"
import { useStore } from "../../state/store"
import { RunStatus } from "../../enums"
import "./run-simulate.css"

const SCENARIOS: Array<{ id: SimScenario; label: string }> = [
  { id: "direct", label: "Direct" },
  { id: "planner-seq", label: "Planner seq" },
  { id: "planner-parallel", label: "Planner ∥" },
]

const PACES: Array<{ id: SimPace; label: string }> = [
  { id: "fast", label: "Fast" },
  { id: "normal", label: "Normal" },
  { id: "slow", label: "Slow" },
]

function WorkspaceSimulateControlInner() {
  const [config, setConfig] = useState<SimConfig>(() => readSimConfig())
  const [on, setOn] = useState(() => getSimulatingRunId() != null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRunId = useStore((s) => s.activeRunId)
  const runs = useStore((s) => s.runs)

  useEffect(() => {
    const runId = getSimulatingRunId()
    if (!runId) return
    const run = runs.find((r) => r.id === runId)
    if (!run) return
    if (
      run.status === RunStatus.Completed ||
      run.status === RunStatus.Failed ||
      run.status === RunStatus.Cancelled
    ) {
      clearSimulationIfRun(runId)
      setOn(false)
    }
  }, [runs, activeRunId])

  function patchConfig(patch: Partial<SimConfig>): void {
    const next = { ...config, ...patch }
    writeSimConfig(next)
    setConfig(next)
  }

  async function turnOn(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await startSimulation(config)
      setOn(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Local sim failed")
    } finally {
      setBusy(false)
    }
  }

  async function turnOff(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await stopSimulation()
      setOn(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stop failed")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="workspace-simulate"
      title={error ?? "LOCAL ONLY — LLM-free test harness (not product)"}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={busy}
        className={`toolbar-ops-btn shrink-0 px-2.5${on ? " toolbar-ops-btn--active" : ""}`}
        onClick={() => {
          void (on ? turnOff() : turnOn())
        }}
        aria-label={on ? "Stop local test simulation" : "Start local test simulation"}
        title={
          error
            ? error
            : on
              ? "LOCAL SIM ON — click to stop (not product)"
              : `LOCAL SIM OFF — ${config.scenario} · ${config.pace}`
        }
      >
        <FlaskConical size={15} className="block shrink-0" aria-hidden />
        <span className="hidden leading-none sm:inline">Local sim</span>
        <span
          className={`workspace-simulate__dot${on ? " is-on" : ""}`}
          aria-hidden
        />
      </button>
      <select
        className="workspace-simulate__select"
        value={config.scenario}
        disabled={on || busy}
        onChange={(e) => patchConfig({ scenario: e.target.value as SimScenario })}
        aria-label="Local sim scenario"
      >
        {SCENARIOS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <select
        className="workspace-simulate__select"
        value={config.pace}
        disabled={on || busy}
        onChange={(e) => patchConfig({ pace: e.target.value as SimPace })}
        aria-label="Local sim pace"
      >
        {PACES.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function WorkspaceSimulateControl() {
  if (!isLocalRunSimulateUiEnabled()) return null
  return <WorkspaceSimulateControlInner />
}
