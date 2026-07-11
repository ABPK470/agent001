/**
 * Detail pane — toolbar + read-only views (Overview, Tables).
 * All editing lives in the per-entity ⋯ menu (Edit).
 */

import type { JSX } from "react"
import type { EntityRegistryDefinition } from "../../types"
import { TAB_PILL, TOOLBAR_ROW } from "./chrome"
import { EntityTables } from "./EntityTables"
import { EntityYaml } from "./EntityYaml"

const TABS = ["overview", "tables"] as const
export type EntityTab = typeof TABS[number]

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
            className={[
              TAB_PILL,
              tab === t
                ? "bg-accent/15 text-accent"
                : "text-text-muted hover:bg-elevated hover:text-text",
            ].join(" ")}
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
}

export function EntityDetailContent({
  def,
  tab,
  jsonText,
}: EntityDetailContentProps): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {tab === "overview" && (
        <EntityYaml def={def} jsonText={jsonText} entityId={def.id} />
      )}
      {tab === "tables" && <EntityTables def={def} />}
    </div>
  )
}

/** @deprecated use EntityDetailToolbar + EntityDetailContent from shell */
export interface EntityDetailProps {
  def: EntityRegistryDefinition
  tab: EntityTab
  onTab: (tab: EntityTab) => void
  jsonText: string
}

export function EntityDetail(props: EntityDetailProps): JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <EntityDetailToolbar def={props.def} tab={props.tab} onTab={props.onTab} />
      <EntityDetailContent
        def={props.def}
        tab={props.tab}
        jsonText={props.jsonText}
      />
    </div>
  )
}
