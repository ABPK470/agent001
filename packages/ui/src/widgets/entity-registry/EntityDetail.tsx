/**
 * Detail pane — toolbar + read-only views (Overview, Tables).
 * All editing lives in the per-entity ⋯ menu (Edit).
 */

import type { JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"
import { TAB_PILL, TAB_PILL_ACTIVE, TAB_PILL_IDLE, TOOLBAR_ROW } from "./chrome"
import { EntityOverview } from "./EntityOverview"
import { EntityTables } from "./EntityTables"

const TABS = ["overview", "tables"] as const
export type EntityTab = (typeof TABS)[number]

const TAB_LABELS: Record<EntityTab, string> = {
  overview: "Overview",
  tables: "Tables",
}

export interface EntityDetailToolbarProps {
  def: EntityRegistryDefinition
  tab: EntityTab
  onTab: (tab: EntityTab) => void
}

export function EntityDetailToolbar({
  def,
  tab,
  onTab,
}: EntityDetailToolbarProps): JSX.Element {
  return (
    <div className={TOOLBAR_ROW}>
      <nav className="flex min-w-0 items-center gap-1" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onTab(t)}
            className={[TAB_PILL, tab === t ? TAB_PILL_ACTIVE : TAB_PILL_IDLE].join(" ")}
          >
            {t === "tables" ? `Tables · ${(def.tables ?? []).length}` : TAB_LABELS[t]}
          </button>
        ))}
      </nav>
    </div>
  )
}

export interface EntityDetailContentProps {
  def: EntityRegistryDefinition
  tab: EntityTab
  jsonText: string
  isAdmin?: boolean
  onImported?: () => void
}

export function EntityDetailContent({
  def,
  tab,
  jsonText,
  isAdmin,
  onImported,
}: EntityDetailContentProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {tab === "overview" && (
        <EntityOverview
          def={def}
          jsonText={jsonText}
          entityId={def.id}
          isAdmin={isAdmin}
          onImported={onImported}
        />
      )}
      {tab === "tables" && <EntityTables def={def} />}
    </div>
  )
}
