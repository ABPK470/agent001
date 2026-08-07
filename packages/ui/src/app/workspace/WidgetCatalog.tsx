/**
 * WidgetCatalog — modal for adding product surfaces to the active layout.
 * Lists only surfaces the role may open (no gray disabled cards).
 */

import { canOpenWidget } from "@mia/shared-types"
import { LayoutDashboard } from "lucide-react"
import { useIsMobile } from "../../hooks/useIsMobile"
import { useMe } from "../../hooks/useMe"
import { useLayoutStore } from "../../state/layout-store"
import type { WidgetType } from "../../types"
import { ModalShell } from "../../widgets/entity-registry/ModalShell"
import { modalViewerPanelClass } from "../../widgets/entity-registry/modal-overlay"
import { openWidgetCatalogHint } from "../types"
import { catalogEntries } from "./widget-definitions"

interface Props {
  onClose: () => void
}

export function WidgetCatalog({ onClose }: Props) {
  const activeViewId = useLayoutStore((s) => s.activeViewId)
  const views = useLayoutStore((s) => s.views)
  const addWidget = useLayoutStore((s) => s.addWidget)
  const removeWidget = useLayoutStore((s) => s.removeWidget)
  const isMobile = useIsMobile()
  const { me } = useMe()
  const isAdmin = me?.isAdmin ?? false

  const activeView = views.find((view) => view.id === activeViewId)
  const activeTypes = new Set(activeView?.tiles.map((tile) => tile.type) ?? [])

  function handleToggle(type: WidgetType) {
    if (!canOpenWidget(type, isAdmin)) return
    const existing = activeView?.tiles.find((tile) => tile.type === type)
    if (existing) {
      removeWidget(activeViewId, existing.id)
    } else {
      addWidget(activeViewId, type)
    }
  }

  const catalogHint = openWidgetCatalogHint()
  const entries = catalogEntries().filter((item) => canOpenWidget(item.type, isAdmin))

  return (
    <ModalShell
      title="Add to layout"
      subtitle={`Pick surfaces for this layout · ${catalogHint}`}
      icon={<LayoutDashboard size={20} className="text-text-muted" />}
      onClose={onClose}
      widthClass={modalViewerPanelClass(isMobile)}
    >
      <div
        className={`min-h-0 flex-1 overflow-y-auto p-5 show-scrollbar grid gap-2.5 ${
          isMobile ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3"
        }`}
      >
        {entries.map((item) => {
          const isActive = activeTypes.has(item.type)
          const Icon = item.icon
          return (
            <button
              key={item.type}
              type="button"
              className={`relative flex items-center gap-3.5 rounded-xl text-left p-4 transition-colors border border-border cursor-pointer ${
                isActive
                  ? "bg-[var(--select-fill)] text-text"
                  : "bg-panel text-text-muted hover:bg-[var(--hover-fill)] hover:text-text"
              }`}
              onClick={() => handleToggle(item.type)}
            >
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 border border-border ${
                isActive
                  ? "text-text bg-[var(--hover-fill)]"
                  : "text-text-muted"
              }`}>
                <Icon size={18} className="block shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <span className={`text-sm font-medium block ${
                  isActive ? "text-text" : "text-text-secondary"
                }`}>
                  {item.label}
                </span>
                <span className={`text-[13px] leading-snug block mt-0.5 ${
                  isActive ? "text-text-secondary" : "text-text-muted"
                }`}>
                  {item.desc}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </ModalShell>
  )
}
