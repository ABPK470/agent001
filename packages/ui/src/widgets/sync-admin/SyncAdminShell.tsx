/**
 * SyncAdminShell — entity-registry style envelope + section rail.
 */

import type { JSX } from "react"
import { useState } from "react"
import { ApprovalsPanel } from "./ApprovalsPanel"
import { ConsoleNotice, ConsoleProvider } from "./console-context"
import { WIDGET_ENVELOPE } from "./design"
import { EnvironmentsPanel } from "./EnvironmentsPanel"
import { FreezeWindowsPanel } from "./FreezeWindowsPanel"
import { OverviewPanel } from "./OverviewPanel"
import { ProposalsPanel } from "./ProposalsPanel"
import { RoutesPanel } from "./RoutesPanel"
import { RunsPanel } from "./RunsPanel"
import { SchedulesPanel } from "./SchedulesPanel"
import { StrategiesPanel } from "./StrategiesPanel"

export type Section =
  | "overview"
  | "proposals"
  | "runs"
  | "approvals"
  | "environments"
  | "schedules"
  | "routes"
  | "strategies"
  | "freezes"

const NAV: readonly { id: Section; label: string }[] = [
  { id: "overview",     label: "Overview" },
  { id: "proposals",    label: "Proposals" },
  { id: "runs",         label: "Runs" },
  { id: "approvals",    label: "Approvals" },
  { id: "environments", label: "Connections" },
  { id: "schedules",    label: "Schedules" },
  { id: "routes",       label: "Notify" },
  { id: "strategies",   label: "SCD2" },
  { id: "freezes",      label: "Freezes" },
]

export function SyncAdminShell({
  initial = "overview",
  runsTab = "runs",
}: {
  initial?: Section
  runsTab?: "runs" | "evidence"
}): JSX.Element {
  const [section, setSection] = useState<Section>(initial)

  return (
    <ConsoleProvider>
      <div className="sync-admin flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-panel p-3">
        <ConsoleNotice />
        <div className={WIDGET_ENVELOPE}>
          <div className="entity-registry-shell grid min-h-0 flex-1 overflow-hidden">
            <aside className="entity-rail flex min-h-0 flex-col border-r border-border-subtle" aria-label="Sections">
              <div className="entity-rail-header">
                <span className="entity-rail-header__label">Sync</span>
              </div>
              <div className="entity-rail-scroll min-h-0 flex-1 overflow-y-auto">
                <ul className="entity-rail-list">
                  {NAV.map((n) => {
                    const active = section === n.id
                    return (
                      <li
                        key={n.id}
                        className={`entity-rail-item-wrap ${active ? "entity-rail-item-wrap--active" : ""}`}
                      >
                        <div className="entity-rail-item-row">
                          <button
                            type="button"
                            onClick={() => setSection(n.id)}
                            className="entity-rail-item min-w-0 flex-1 text-left"
                          >
                            <span className="entity-rail-item-title block min-w-0 truncate">{n.label}</span>
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </aside>

            <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
              {section === "overview"     && <OverviewPanel onJump={setSection} />}
              {section === "proposals"    && <ProposalsPanel />}
              {section === "runs"         && <RunsPanel initialTab={runsTab} />}
              {section === "approvals"    && <ApprovalsPanel />}
              {section === "environments" && <EnvironmentsPanel />}
              {section === "schedules"    && <SchedulesPanel />}
              {section === "routes"       && <RoutesPanel />}
              {section === "strategies"   && <StrategiesPanel />}
              {section === "freezes"      && <FreezeWindowsPanel />}
            </div>
          </div>
        </div>
      </div>
    </ConsoleProvider>
  )
}
