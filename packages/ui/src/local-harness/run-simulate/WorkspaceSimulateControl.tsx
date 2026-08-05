/**
 * LOCAL LAPTOP HARNESS — testing switch. Not product chrome.
 */

import { FlaskConical } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Listbox, type ListboxOption } from "../../components/Listbox"
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
  { id: "planner-parallel", label: "Planner ×3" },
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

  const scenarioOptions = useMemo<ListboxOption<SimScenario>[]>(
    () => SCENARIOS.map((s) => ({ value: s.id, label: s.label })),
    [],
  )
  const paceOptions = useMemo<ListboxOption<SimPace>[]>(
    () => PACES.map((p) => ({ value: p.id, label: p.label })),
    [],
  )

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

  const controlsLocked = on || busy

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
      <Listbox
        className="workspace-simulate__listbox workspace-simulate__listbox--scenario listbox-control"
        value={config.scenario}
        options={scenarioOptions}
        onChange={(scenario) => patchConfig({ scenario })}
        size="sm"
        variant="ghost"
        searchable={false}
        disabled={controlsLocked}
        ariaLabel="Local sim scenario"
      />
      <Listbox
        className="workspace-simulate__listbox workspace-simulate__listbox--pace listbox-control"
        value={config.pace}
        options={paceOptions}
        onChange={(pace) => patchConfig({ pace })}
        size="sm"
        variant="ghost"
        searchable={false}
        disabled={controlsLocked}
        ariaLabel="Local sim pace"
      />
    </div>
  )
}

export function WorkspaceSimulateControl() {
  if (!isLocalRunSimulateUiEnabled()) return null
  return <WorkspaceSimulateControlInner />
}
