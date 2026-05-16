/**
 * SyncAdminShell — left rail + active section pane.
 *
 * Single fixed-height container holding the entire Sync Operations
 * Console. Sections are panels imported from this folder; each panel
 * brings its own chrome via `PanelChrome`, so the shell only renders
 * navigation and the active panel.
 *
 * Why one widget instead of six? Operators kept losing context when
 * approvals/policies/schedules/freeze-windows/strategies/environments
 * lived as separate widgets. One shell with a unified rail gives them
 * a single mental map.
 */

import {
    Calendar, Clock, Database, GitBranch, LayoutDashboard, Mail, ShieldCheck,
} from "lucide-react"
import type { JSX } from "react"
import { useState } from "react"
import { EnvironmentsPanel } from "./EnvironmentsPanel"
import { FreezeWindowsPanel } from "./FreezeWindowsPanel"
import { OverviewPanel } from "./OverviewPanel"
import { PoliciesPanel } from "./PoliciesPanel"
import { RoutesPanel } from "./RoutesPanel"
import { SchedulesPanel } from "./SchedulesPanel"
import { StrategiesPanel } from "./StrategiesPanel"

export type Section =
  | "overview"
  | "environments"
  | "schedules"
  | "policies"
  | "routes"
  | "strategies"
  | "freezes"

interface NavItem { id: Section; label: string; icon: typeof Database; hint: string }

const NAV: readonly NavItem[] = [
  { id: "overview",     label: "Overview",        icon: LayoutDashboard, hint: "everything at a glance" },
  { id: "environments", label: "Environments",    icon: Database,        hint: "DEV · UAT · PROD" },
  { id: "schedules",    label: "Schedules",       icon: Clock,           hint: "cron-driven proposers" },
  { id: "policies",     label: "Approval policies",icon: ShieldCheck,    hint: "who must sign off" },
  { id: "routes",       label: "Notifications",   icon: Mail,            hint: "where events go" },
  { id: "strategies",   label: "SCD2 strategies", icon: GitBranch,       hint: "history templates" },
  { id: "freezes",      label: "Freeze windows",  icon: Calendar,        hint: "scheduled blackouts" },
]

export function SyncAdminShell({ initial = "overview" }: { initial?: Section }): JSX.Element {
  const [section, setSection] = useState<Section>(initial)
  return (
    <div className="flex h-full overflow-hidden bg-canvas text-text">
      <nav className="flex w-52 shrink-0 flex-col border-r border-border-subtle bg-panel">
        <header className="flex h-14 shrink-0 items-center border-b border-border-subtle px-4">
          <h1 className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">Sync Operations</h1>
        </header>
        <ul className="flex-1 overflow-y-auto py-2">
          {NAV.map((n) => {
            const Icon = n.icon
            const active = n.id === section
            return (
              <li key={n.id}>
                <button type="button" onClick={() => setSection(n.id)}
                  className={[
                    "flex w-full items-start gap-2.5 border-l-2 px-3 py-2 text-left text-xs",
                    active
                      ? "border-accent bg-overlay-2 text-text"
                      : "border-transparent text-text-muted hover:bg-overlay-2 hover:text-text",
                  ].join(" ")}
                >
                  <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="flex flex-col">
                    <span className="font-medium">{n.label}</span>
                    <span className="text-[10px] text-text-faint">{n.hint}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="flex-1 min-w-0">
        {section === "overview"     && <OverviewPanel onJump={setSection} />}
        {section === "environments" && <EnvironmentsPanel />}
        {section === "schedules"    && <SchedulesPanel />}
        {section === "policies"     && <PoliciesPanel />}
        {section === "routes"       && <RoutesPanel />}
        {section === "strategies"   && <StrategiesPanel />}
        {section === "freezes"      && <FreezeWindowsPanel />}
      </div>
    </div>
  )
}
